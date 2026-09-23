import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { homedir } from "node:os";
import path from "node:path";
import { CdpClient } from "@codexhost/desktop-control";
import { installDesktopAgent, refreshDesktopQueries } from "./desktop-agent.js";
import { HotAttachSession, type DesktopHello } from "./session.js";

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function within<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
export interface DesktopProcess {
  pid: number;
  started: string;
  executable: string;
}
export function desktopProcesses(appPath: string): DesktopProcess[] {
  const executable = path.join(appPath, "Contents/MacOS/ChatGPT");
  return execFileSync("/bin/ps", ["-axo", "pid=,lstart=,comm="], { encoding: "utf8" })
    .split("\n")
    .flatMap((line) => {
      const match = line.trim().match(/^(\d+)\s+(\w+\s+\w+\s+\d+\s+[\d:]+\s+\d+)\s+(.*)$/);
      return match?.[3] === executable
        ? [{ pid: Number(match[1]), started: match[2]!, executable }]
        : [];
    });
}
function inspectorOwners(): number[] {
  try {
    return execFileSync("/usr/sbin/lsof", ["-nP", "-t", "-iTCP:9229", "-sTCP:LISTEN"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .trim()
      .split("\n")
      .map(Number);
  } catch (error) {
    if ((error as { status?: number }).status === 1) return [];
    throw error;
  }
}

export class HotAttachController {
  #session: HotAttachSession | undefined;
  #server: Server | undefined;
  #directory: string | undefined;
  #operation: Promise<void> | undefined;
  #detachment: Promise<void> | undefined;
  #forceDetach = false;
  #phase = "detached";
  #error: string | null = null;
  #target: DesktopProcess | undefined;
  #drainGeneration = 0;
  constructor(
    readonly options: {
      appPath: string;
      environment: NodeJS.ProcessEnv;
      hostRuntimeUrl: string;
      changed?: () => void;
    },
  ) {}

  status() {
    return {
      phase: this.#phase,
      error: this.#error,
      appPath: this.options.appPath,
      pid: this.#target?.pid ?? null,
      backendPid: this.#session?.hello.backendPid ?? null,
      appVersion: this.#session?.hello.appVersion ?? null,
      activeExternal: this.#session?.state().activeExternal.length ?? 0,
      backgroundTasks: this.#session?.state().backgroundTasks ?? 0,
      busy: this.#session?.state().busy ?? false,
    };
  }
  #changed(): void {
    this.options.changed?.();
  }
  attach(): Promise<void> {
    if (this.#detachment) return this.#detachment.then(() => this.attach());
    if (this.#operation) return this.#operation;
    if (this.#session?.attached) return Promise.resolve();
    const operation = this.#attach();
    this.#operation = operation;
    void operation
      .finally(() => {
        if (this.#operation === operation) this.#operation = undefined;
      })
      .catch(() => {});
    return operation;
  }
  async #attach(): Promise<void> {
    this.#phase = "attaching";
    this.#error = null;
    this.#changed();
    let cdp: CdpClient | undefined,
      openedInspector = false,
      agentToken: string | undefined;
    try {
      const targets = desktopProcesses(this.options.appPath);
      if (targets.length !== 1)
        throw new Error(
          targets.length
            ? "Multiple Desktop instances match; choose one explicitly"
            : "Open the original Desktop first",
        );
      const target = targets[0]!;
      this.#target = target;
      // Any genuinely signed Desktop is accepted; the injected agent verifies the connection
      // layout at runtime and refuses to patch anything it does not recognize.
      try {
        execFileSync(
          "/usr/bin/codesign",
          [
            "--verify",
            "--deep",
            "--strict",
            "-R",
            '=anchor apple generic and identifier "com.openai.codex" and certificate leaf[subject.OU] = "2DC432GLL2"',
            this.options.appPath,
          ],
          { stdio: "ignore" },
        );
      } catch {
        throw new Error("Desktop is not the original OpenAI-signed App");
      }
      const owners = inspectorOwners();
      if (owners.some((pid) => pid !== target.pid))
        throw new Error("Inspector port 9229 is in use by another process");
      if (
        !desktopProcesses(this.options.appPath).some(
          (p) => p.pid === target.pid && p.started === target.started,
        )
      )
        throw new Error("Desktop changed during attachment");
      if (!owners.length) {
        process.kill(target.pid, "SIGUSR1");
        openedInspector = true;
      }
      let discovered: { webSocketDebuggerUrl: string }[] | undefined;
      for (let attempt = 0; attempt < 50; attempt++) {
        discovered = await fetch("http://127.0.0.1:9229/json/list", {
          signal: AbortSignal.timeout(500),
        })
          .then((r) => r.json() as Promise<typeof discovered>)
          .catch(() => undefined);
        if (discovered?.length) break;
        await pause(100);
      }
      if (discovered?.length !== 1 || inspectorOwners().some((pid) => pid !== target.pid))
        throw new Error("Cannot identify Desktop inspector");
      const endpoint = new URL(discovered[0]!.webSocketDebuggerUrl);
      if (
        endpoint.protocol !== "ws:" ||
        endpoint.hostname !== "127.0.0.1" ||
        endpoint.port !== "9229"
      )
        throw new Error("Unexpected inspector endpoint");
      cdp = await CdpClient.connect(endpoint.href, { commandTimeoutMs: 30_000 });
      const identity = await cdp.evaluate<{ pid: number; cliPath: string; attached: boolean }>(
        `({pid:process.pid,cliPath:process.env.CODEX_CLI_PATH||"",attached:!!globalThis.__codexhostHotAttachV1})`,
      );
      if (identity.pid !== target.pid) throw new Error("Inspector PID does not match Desktop");
      if (identity.cliPath)
        throw new Error(
          "This Desktop is using the legacy launcher. Quit it and open the original App normally before attaching.",
        );
      if (identity.attached) throw new Error("Another Host is already attached");
      const token = randomBytes(32).toString("hex");
      agentToken = token;
      this.#directory = await mkdtemp("/tmp/codexhost-attach-");
      await chmod(this.#directory, 0o700);
      const socketPath = path.join(this.#directory, "bridge.sock");
      const accepted = Promise.withResolvers<HotAttachSession>();
      this.#server = createServer((socket) => {
        if (this.#session) {
          socket.destroy();
          return;
        }
        socket.setEncoding("utf8");
        let buffer = "",
          session: HotAttachSession | undefined;
        const timeout = setTimeout(() => socket.destroy(), 5000);
        socket.on("error", () => socket.destroy());
        socket.on("data", (chunk) => {
          buffer += chunk;
          if (Buffer.byteLength(buffer) > 64 * 1024 * 1024) {
            socket.destroy();
            return;
          }
          let end: number;
          while ((end = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, end);
            buffer = buffer.slice(end + 1);
            try {
              const value = JSON.parse(line);
              if (session) session.receive(value);
              else {
                if (
                  value.type !== "hello" ||
                  value.token !== token ||
                  value.pid !== target.pid ||
                  value.cliPath ||
                  typeof value.codexHome !== "string" ||
                  !Number.isSafeInteger(value.backendPid)
                )
                  throw new Error("Invalid Desktop bridge identity");
                clearTimeout(timeout);
                session = new HotAttachSession(value as DesktopHello, socket, {
                  environment: this.options.environment,
                  hostRuntimeUrl: this.options.hostRuntimeUrl,
                  stockCodexPath: path.join(this.options.appPath, "Contents/Resources/codex"),
                });
                this.#session = session;
                session.on("state", () => this.#changed());
                session.on("failed", (error: unknown) => {
                  this.#error = errorText(error);
                  this.#changed();
                });
                socket.once("close", () => {
                  if (this.#phase === "attached" || this.#phase === "draining") {
                    this.#error = "Desktop connection closed";
                    void this.detach(true).catch(() => {});
                  }
                });
                accepted.resolve(session);
              }
            } catch {
              socket.destroy();
            }
          }
        });
        socket.once("close", () => clearTimeout(timeout));
      });
      await new Promise<void>((resolve, reject) => {
        this.#server!.once("error", reject);
        this.#server!.listen(socketPath, () => {
          this.#server!.removeListener("error", reject);
          resolve();
        });
      });
      await chmod(socketPath, 0o600);
      await cdp.evaluate(
        `(${installDesktopAgent.toString()})(${JSON.stringify({
          socketPath,
          token,
          leaseMs: 15_000,
          refresh: `(${refreshDesktopQueries.toString()})()`,
          refreshUsage: `(${refreshDesktopQueries.toString()})("usage")`,
        })})`,
      );
      const session = await within(
        accepted.promise,
        12_000,
        "Local connection discovery timed out",
      );
      await within(session.ready.promise, 20_000, "Host startup timed out");
      this.#phase = "attached";
    } catch (error) {
      if (cdp && agentToken)
        await cdp
          .evaluate(
            `(globalThis.__codexhostHotAttachV1?.ownerToken===${JSON.stringify(agentToken)} && globalThis.__codexhostHotAttachV1.detach("attach-failed"),true)`,
          )
          .catch(() => {});
      await this.#cleanup();
      this.#phase = "error";
      this.#error = errorText(error);
      throw error;
    } finally {
      if (openedInspector)
        await this.#closeOwnedInspector(cdp).catch(() => {
          this.#error = [this.#error, "Desktop inspector cleanup could not be confirmed"]
            .filter(Boolean)
            .join(". ");
        });
      cdp?.close();
      this.#changed();
    }
  }
  async #closeOwnedInspector(existing: CdpClient | undefined): Promise<void> {
    const target = this.#target;
    if (!target || !inspectorOwners().includes(target.pid)) return;
    if (
      !desktopProcesses(this.options.appPath).some(
        (p) => p.pid === target.pid && p.started === target.started,
      )
    )
      return;
    let client = existing;
    try {
      if (!client) {
        const targets = (await fetch("http://127.0.0.1:9229/json/list", {
          signal: AbortSignal.timeout(1000),
        }).then((response) => response.json())) as { webSocketDebuggerUrl: string }[];
        if (targets.length !== 1) throw new Error("Unknown inspector");
        const endpoint = new URL(targets[0]!.webSocketDebuggerUrl);
        if (
          endpoint.protocol !== "ws:" ||
          endpoint.hostname !== "127.0.0.1" ||
          endpoint.port !== "9229"
        )
          throw new Error("Unknown inspector");
        client = await CdpClient.connect(endpoint.href, {
          commandTimeoutMs: 2000,
          connectTimeoutMs: 2000,
        });
      }
      if ((await client.evaluate("process.pid")) !== target.pid)
        throw new Error("Inspector owner changed");
      await client.evaluate(
        `(setTimeout(()=>process.mainModule.require("node:inspector").close(),100),true)`,
      );
    } finally {
      if (client !== existing) client?.close();
    }
  }
  cancelDrain(): void {
    if (this.#phase !== "draining" || this.#forceDetach) return;
    ++this.#drainGeneration;
    this.#session?.host.setAttachmentDraining(false);
    this.#phase = "attached";
    this.#changed();
  }
  detach(force = false): Promise<void> {
    this.#forceDetach ||= force;
    if (this.#detachment) return this.#detachment;
    const operation = this.#detach();
    this.#detachment = operation;
    void operation
      .finally(() => {
        if (this.#detachment === operation) {
          this.#detachment = undefined;
          this.#forceDetach = false;
        }
      })
      .catch(() => {});
    return operation;
  }
  async #detach(): Promise<void> {
    if (this.#operation) await this.#operation.catch(() => {});
    const generation = ++this.#drainGeneration;
    const session = this.#session;
    if (session) {
      this.#phase = "draining";
      session.host.setAttachmentDraining(true);
      this.#changed();
      while (!this.#forceDetach && (session.state().busy || session.state().pending > 0)) {
        await pause(200);
        if (generation !== this.#drainGeneration) return;
      }
      if (generation !== this.#drainGeneration) return;
    }
    this.#phase = "detaching";
    this.#changed();
    await this.#cleanup();
    this.#phase = "detached";
    this.#changed();
  }
  async #cleanup(): Promise<void> {
    const session = this.#session;
    this.#session = undefined;
    try {
      await session?.close();
    } finally {
      try {
        if (this.#server)
          await new Promise<void>((resolve) => this.#server!.close(() => resolve()));
      } finally {
        this.#server = undefined;
        const directory = this.#directory;
        this.#directory = undefined;
        if (directory) await rm(directory, { recursive: true, force: true });
      }
    }
  }
}

export function defaultMenuBarEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...environment,
    CODEXHOST_DATA_DIR: environment.CODEXHOST_DATA_DIR ?? path.join(homedir(), ".codexhost"),
  };
}
