import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { access, chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dataDirectory } from "@claude-in-codex/shared-contracts/app-paths";
import { featureIdSchema, idleReleaseMinutesSchema } from "@claude-in-codex/shared-contracts";
import { OfficialRuntimeScope } from "./codex-runtime/official-runtime-scope.js";
import { createOwnedUnixBackend } from "./codex-runtime/owned-official-backends.js";
import { AppServerHost, officialEnvironment } from "./app-server-host.js";
import { MappingStoreError } from "@claude-in-codex/mapping-store";
import {
  createProductionExternalThreadStore,
  type ExternalThreadStore,
} from "./external-thread-repository.js";
import { installedHarnessPluginOptions } from "./installed-harness-plugins.js";
import { isDesktopStdioInvocation } from "./remote-app-server.js";
import { FeatureHealth } from "./hot-attach/features.js";
import { hostClaudeProcesses, type HotAttachController } from "./hot-attach/controller.js";
import { accountUsageMeters, type UsageMeter } from "./hot-attach/usage-meters.js";

export type StartupStatus = ReturnType<HotAttachController["status"]> & {
  connectionMode: "startup";
};
interface Descriptor {
  socket: string;
  token: string;
  pid: number;
}
const descriptorPath = (environment: NodeJS.ProcessEnv) =>
  path.join(dataDirectory(environment), "startup-session.json");
const shellQuote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

export async function stockDesktopCli(appPath: string): Promise<string> {
  for (const relative of [
    "Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex",
    "Contents/Resources/codex",
  ]) {
    const candidate = path.join(appPath, relative);
    if (
      await access(candidate).then(
        () => true,
        () => false,
      )
    )
      return candidate;
  }
  throw new Error("The Codex App's bundled CLI could not be found");
}

/** Prepare a reversible launch override. The official app bundle stays untouched. */
export async function prepareStartupConnection(
  environment: NodeJS.ProcessEnv,
  hostRuntimeUrl: string,
) {
  const appPath = environment.CLAUDE_IN_CODEX_DESKTOP_APP ?? "/Applications/ChatGPT.app";
  execFileSync(
    "/usr/bin/codesign",
    [
      "--verify",
      "--deep",
      "--strict",
      "-R",
      '=anchor apple generic and identifier "com.openai.codex" and certificate leaf[subject.OU] = "2DC432GLL2"',
      appPath,
    ],
    { stdio: "ignore" },
  );
  await stockDesktopCli(appPath);
  const directory = dataDirectory(environment);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const cliPath = path.join(directory, "desktop-cli");
  const source = `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(fileURLToPath(hostRuntimeUrl))} --claude-in-codex-desktop-cli "$@"\n`;
  const temporary = `${cliPath}.${process.pid}.tmp`;
  await writeFile(temporary, source, { mode: 0o700 });
  await chmod(temporary, 0o700);
  await rename(temporary, cliPath);
  return { appPath, cliPath, dataDirectory: directory };
}

/** One authenticated request over a private local socket; no Desktop/debug port is opened. */
export async function startupRequest(
  environment: NodeJS.ProcessEnv,
  command: string,
  fields: Record<string, unknown> = {},
): Promise<StartupStatus> {
  const descriptor: Descriptor = JSON.parse(await readFile(descriptorPath(environment), "utf8"));
  if (
    typeof descriptor.socket !== "string" ||
    !path.isAbsolute(descriptor.socket) ||
    typeof descriptor.token !== "string" ||
    !/^[a-f0-9]{64}$/.test(descriptor.token)
  )
    throw new Error("Invalid startup connection");
  return new Promise((resolve, reject) => {
    const socket = createConnection(descriptor.socket);
    let buffer = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("Startup connection timed out"));
    }, 5000);
    socket.setEncoding("utf8");
    socket.once("connect", () =>
      socket.write(JSON.stringify({ token: descriptor.token, command, ...fields }) + "\n"),
    );
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.length > 4 * 1024 * 1024) {
        socket.destroy(new Error("Startup response too large"));
        return;
      }
      if (!buffer.includes("\n")) return;
      try {
        const response = JSON.parse(buffer.slice(0, buffer.indexOf("\n")));
        if (response.error) reject(new Error(response.error));
        else if (response.status?.connectionMode === "startup" && response.status.pid > 0)
          resolve(response.status);
        else reject(new Error("Invalid startup response"));
      } catch (error) {
        reject(error);
      }
      socket.end();
    });
    socket.once("error", reject);
    socket.once("close", () => {
      clearTimeout(timer);
      reject(new Error("Startup connection closed"));
    });
  });
}

/** The Desktop owns this process and its stdin lifetime. The menu bar is only a control client. */
export async function runDesktopCli(
  arguments_: string[],
  environment: NodeJS.ProcessEnv,
  hostRuntimeUrl: string,
): Promise<number> {
  const appPath = environment.CLAUDE_IN_CODEX_DESKTOP_APP ?? "/Applications/ChatGPT.app";
  const stock = await stockDesktopCli(appPath);
  if (!isDesktopStdioInvocation(arguments_)) {
    return new Promise((resolve, reject) => {
      const child = spawn(stock, arguments_, {
        env: officialEnvironment(environment),
        stdio: "inherit",
      });
      child.once("error", reject);
      child.once("exit", (code) => resolve(code ?? 1));
    });
  }
  const mappingStore = createProductionExternalThreadStore(environment);
  try {
    // Desktop replaces its backend when bundled plugins change. Its previous Host may
    // still be releasing Claude sessions and the store after stdin closes.
    const deadline = Date.now() + 10_000;
    for (;;) {
      try {
        await mappingStore.initialize();
        break;
      } catch (error) {
        if (
          !(error instanceof MappingStoreError) ||
          error.code !== "STORE_LOCKED" ||
          Date.now() >= deadline
        )
          throw error;
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
      }
    }
    return await runDesktopHost(
      arguments_,
      environment,
      hostRuntimeUrl,
      appPath,
      stock,
      mappingStore,
    );
  } finally {
    await mappingStore.close();
  }
}

/** Desktop keeps stdio; independent Host clients share a private native listener. */
export function desktopOfficialListenerArguments(
  arguments_: string[],
  socketPath: string,
): string[] {
  if (!isDesktopStdioInvocation(arguments_) || !path.isAbsolute(socketPath))
    throw new Error("Expected Desktop stdio arguments and an absolute socket path");
  const result: string[] = [];
  for (let index = 0; index < arguments_.length; index++) {
    const argument = arguments_[index];
    if (!argument) continue;
    if (["-c", "--config", "--enable", "--disable", "--code-mode-host"].includes(argument)) {
      result.push(argument, arguments_[++index] as string);
    } else if (argument === "--listen") index++;
    else if (!argument.startsWith("--listen=")) result.push(argument);
  }
  return [...result, "--listen", `unix://${socketPath}`];
}

async function runDesktopHost(
  arguments_: string[],
  environment: NodeJS.ProcessEnv,
  hostRuntimeUrl: string,
  appPath: string,
  stock: string,
  mappingStore: ExternalThreadStore,
): Promise<number> {
  const directory = await mkdtemp("/tmp/claude-in-codex-startup-");
  await chmod(directory, 0o700);
  const socketPath = path.join(directory, "official.sock");
  const officialRuntimeScope = new OfficialRuntimeScope({
    permanentHome: path.resolve(environment.CODEX_HOME ?? path.join(os.homedir(), ".codex")),
    diagnosticOutput: process.stderr,
    createBackend: () =>
      createOwnedUnixBackend({
        stockCodexPath: stock,
        arguments: desktopOfficialListenerArguments(arguments_, socketPath),
        environment: officialEnvironment(environment),
        socketPath,
        diagnosticOutput: process.stderr,
      }),
  });
  const host = new AppServerHost({
    officialRuntimeScope,
    stockCodexPath: stock,
    arguments: arguments_,
    defaultAgent: "codex",
    environment,
    mappingStore,
    ...installedHarnessPluginOptions(environment, false, hostRuntimeUrl),
  });
  const session = {
    attached: true,
    hello: { codexHome: environment.CODEX_HOME ?? path.join(os.homedir(), ".codex") },
    host,
  };
  const health = new FeatureHealth({ environment });
  let harnesses: StartupStatus["harnesses"] = [];
  let usage: UsageMeter[] = [];
  let usageObservedAt: string | null = null;
  let refreshedAt = 0;
  let refreshing: Promise<void> | undefined;
  const appVersion = execFileSync(
    "/usr/libexec/PlistBuddy",
    ["-c", "Print :CFBundleShortVersionString", path.join(appPath, "Contents/Info.plist")],
    { encoding: "utf8" },
  ).trim();
  const snapshot = (): StartupStatus => {
    const state = host.attachmentState();
    return {
      connectionMode: "startup",
      phase: "attached",
      restartRequired: false,
      error: null,
      appPath,
      appRunning: true,
      pid: process.ppid,
      backendPid: process.pid,
      appVersion,
      activeExternal: state.activeExternal.length,
      backgroundTasks: state.backgroundTasks,
      busy: state.busy,
      tasks: host.externalTasks(),
      harnesses,
      claudeProcesses: hostClaudeProcesses(
        harnesses.flatMap((h) => (h.executable ? [h.executable] : [])),
      ),
      usage,
      usageObservedAt,
      features: health.status(),
    };
  };
  const refresh = async () => {
    await health.refresh(session);
    if (Date.now() - refreshedAt < 30_000) return;
    refreshedAt = Date.now();
    harnesses = await host.harnessInstallations();
    const accounts = await host.harnessAccounts();
    usage = accounts.flatMap(({ harnessId, account }) =>
      account ? accountUsageMeters(harnessId, account.credits) : [],
    );
    usageObservedAt = new Date().toISOString();
  };
  const descriptor: Descriptor = {
    socket: path.join(directory, "control.sock"),
    token: randomBytes(32).toString("hex"),
    pid: process.pid,
  };
  const server = createServer((socket) => {
    socket.setEncoding("utf8");
    socket.setTimeout(5000, () => socket.destroy());
    socket.on("error", () => socket.destroy());
    let buffer = "",
      handled = false;
    socket.on("data", (chunk: string) => {
      if (handled) return;
      buffer += chunk;
      if (buffer.length > 65536) {
        socket.destroy();
        return;
      }
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      handled = true;
      void (async () => {
        const request = JSON.parse(buffer.slice(0, end));
        if (request.token !== descriptor.token) {
          socket.destroy();
          return;
        }
        if (request.command === "set-feature") {
          const id = featureIdSchema.parse(request.feature);
          if (typeof request.enabled !== "boolean") throw new Error("Invalid feature setting");
          await health.set(id, request.enabled, session);
        } else if (request.command === "set-idle-release") {
          await health.setIdleRelease(idleReleaseMinutesSchema.parse(request.minutes), session);
        } else if (request.command !== "status") throw new Error("Unknown startup command");
        socket.end(JSON.stringify({ status: snapshot() }) + "\n");
      })().catch((error: unknown) =>
        socket.end(
          JSON.stringify({ error: error instanceof Error ? error.message : String(error) }) + "\n",
        ),
      );
    });
  });
  let timer: NodeJS.Timeout | undefined;
  const stop = () => host.close();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(descriptor.socket, resolve);
    });
    await chmod(descriptor.socket, 0o600);
    await mkdir(dataDirectory(environment), { recursive: true, mode: 0o700 });
    const filename = descriptorPath(environment);
    const temporary = `${filename}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(descriptor), { mode: 0o600 });
    await rename(temporary, filename);
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
    timer = setInterval(() => {
      refreshing ??= refresh()
        .catch(() => {})
        .finally(() => {
          refreshing = undefined;
        });
    }, 2000);
    return await host.run();
  } finally {
    clearInterval(timer);
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
    session.attached = false;
    await host.close();
    await officialRuntimeScope.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    // A Desktop backend restart may already have published the next owner's descriptor.
    const saved = await readFile(descriptorPath(environment), "utf8").then(JSON.parse, () => null);
    if (saved?.token === descriptor.token) await rm(descriptorPath(environment), { force: true });
    await rm(directory, { recursive: true, force: true });
  }
}
