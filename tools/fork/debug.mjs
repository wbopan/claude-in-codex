import { execFileSync, spawn } from "node:child_process";
import { constants } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { verifySnapshot } from "./launch.mjs";
import { retireClaudeDesktopBridge } from "./claude-desktop.mjs";

const marker = "codexhost-debug-instance-v1\n";

export function debugEnvironment(environment, instance) {
  const clean = Object.fromEntries(
    Object.entries(environment).filter(
      ([key]) =>
        !key.startsWith("CODEX") &&
        !key.startsWith("CLAUDE_CODE_") &&
        !["ELECTRON_RUN_AS_NODE", "NODE_OPTIONS", "CLAUDE_CONFIG_DIR"].includes(key),
    ),
  );
  return {
    ...clean,
    CODEX_HOME: path.join(instance, "codex"),
    CODEX_SQLITE_HOME: path.join(instance, "codex"),
    CODEX_ELECTRON_USER_DATA_PATH: path.join(instance, "electron"),
    CODEXHOST_DATA_DIR: path.join(instance, "host"),
    CODEXHOST_DEBUG_INSTANCE_DIR: instance,
    CODEXHOST_HARNESS_BROKER_DIR: path.join(instance, "broker"),
    CODEXHOST_CLAUDE_BROKER_DESCRIPTOR: path.join(instance, "broker/claude-code-broker-v1.json"),
    CLAUDE_CONFIG_DIR: path.join(instance, "claude"),
    // Empty selects Claude's default credential store, including its unscoped macOS Keychain
    // entry. An explicit ~/.claude path selects a different, hashed Keychain entry.
    CLAUDE_SECURESTORAGE_CONFIG_DIR: environment.CLAUDE_SECURESTORAGE_CONFIG_DIR ?? "",
    CODEXHOST_STARTUP_TRACE: "1",
    ...(environment.CODEXHOST_NATIVE_APP_TOOLS === "1" ? { CODEXHOST_NATIVE_APP_TOOLS: "1" } : {}),
  };
}

async function privateDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) {
    throw new Error(`Expected a private, owned directory without a symlink: ${directory}`);
  }
}

async function copyInitialFile(source, destination) {
  try {
    await copyFile(source, destination, constants.COPYFILE_EXCL);
    await chmod(destination, 0o600);
  } catch (error) {
    if (!["ENOENT", "EEXIST"].includes(error.code)) throw error;
  }
}

function verifyApp(app) {
  execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", app], { stdio: "pipe" });
  const identity = execFileSync(
    "/usr/libexec/PlistBuddy",
    ["-c", "Print :CFBundleIdentifier", path.join(app, "Contents/Info.plist")],
    { encoding: "utf8" },
  ).trim();
  if (identity !== "com.openai.codex")
    throw new Error("Expected the official Codex Desktop bundle identity");
}

export async function prepareInstance(instance, app = "/Applications/ChatGPT.app") {
  await privateDirectory(instance);
  if ((await realpath(instance)) !== instance)
    throw new Error("Debug instance path must be canonical");
  const lock = path.join(instance, "setup.lock");
  await mkdir(lock, { mode: 0o700 });
  try {
    for (const name of [
      "host",
      "codex",
      "electron",
      "claude",
      "broker",
      "app",
      "logs",
      "workspace",
    ]) {
      await privateDirectory(path.join(instance, name));
    }
    const destination = path.join(instance, "app/ChatGPT.app");
    if (
      !(await lstat(destination).catch((error) => {
        if (error.code === "ENOENT") return null;
        throw error;
      }))
    ) {
      verifyApp(app);
      const staging = path.join(instance, `app/ChatGPT-${process.pid}.app`);
      try {
        // APFS clone preserves the official bundle and its signatures; no plist edits or re-signing.
        execFileSync("/bin/cp", ["-cR", app, staging], { stdio: "pipe" });
        verifyApp(staging);
        await rename(staging, destination);
      } finally {
        await rm(staging, { recursive: true, force: true });
      }
    }
    if ((await realpath(destination)) !== destination)
      throw new Error("Debug app must not be a symlink");
    verifyApp(destination);
    const version = path.join(instance, "instance-version");
    if (!(await lstat(version).catch(() => null))) {
      // Seed Codex login once. Claude uses its native credential-store override independently of the
      // isolated config directory, so no credential copy or token refresh sync is needed.
      await copyInitialFile(
        path.join(os.homedir(), ".codex/auth.json"),
        path.join(instance, "codex/auth.json"),
      );
      const codexDirectory = path.join(instance, "codex");
      await writeFile(
        path.join(codexDirectory, "config.toml"),
        `cli_auth_credentials_store = "file"\nsqlite_home = ${JSON.stringify(codexDirectory)}\nlog_dir = ${JSON.stringify(path.join(codexDirectory, "log"))}\n`,
        { flag: "wx", mode: 0o600 },
      );
      await writeFile(version, marker, { flag: "wx", mode: 0o600 });
    }
    if ((await readFile(version, "utf8")) !== marker)
      throw new Error("Unknown debug instance format");
    await retireClaudeDesktopBridge(instance);
  } finally {
    await rm(lock, { recursive: true });
  }
}

async function selectedBuild(repository, embedded) {
  const build =
    embedded ??
    (await readFile(path.join(repository, ".codexhost/latest-debug-build.txt"), "utf8")).trim();
  const manifest = await verifySnapshot(build);
  if (!manifest.debug || manifest.repository !== repository)
    throw new Error("Expected a debug snapshot from this repository");
  return build;
}

function nativeCommand(build, command, instance, environment) {
  return execFileSync(path.join(build, "bin/codexhost"), ["debug", command, instance], {
    env: environment,
    encoding: "utf8",
  });
}

async function start(build, instance, environment) {
  const logPath = path.join(instance, "logs", `startup-${Date.now()}.log`);
  const log = await open(logPath, "a", 0o600);
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(path.join(build, "bin/codexhost"), ["debug", "start", instance], {
        env: environment,
        cwd: path.join(instance, "workspace"),
        stdio: ["ignore", "pipe", log.fd],
        detached: true,
      });
      let output = "";
      let ready = false;
      const timeout = setTimeout(() => {
        // Never kill an unobserved startup tree; retain logs and exact native lifecycle state.
        child.stdout.destroy();
        child.unref();
        reject(new Error(`Debug startup timed out. Inspect ${logPath} and use debug:stop.`));
      }, 180_000);
      child.stdout.on("data", (chunk) => {
        output += chunk;
        if (output.split("\n").includes("ready") && !ready) {
          ready = true;
          clearTimeout(timeout);
          child.stdout.destroy();
          child.unref();
          resolve();
        }
      });
      child.on("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.on("exit", (code) => {
        clearTimeout(timeout);
        if (!ready) reject(new Error(`Debug startup exited (${code}). See ${logPath}`));
      });
    });
  } finally {
    await log.close();
  }
  console.log(`Debug instance ready: ${instance}\nBuild: ${build}\nStartup log: ${logPath}`);
}

async function main() {
  const [command = "start", ...rest] = process.argv.slice(2);
  if (!["start", "restart", "stop", "status"].includes(command) || rest.length) {
    throw new Error("Usage: debug.mjs start|restart|stop|status");
  }
  if (process.platform !== "darwin")
    throw new Error("Independent debug Desktop currently supports macOS");
  const embeddedManifest = await readFile(
    path.join(import.meta.dirname, "fork-manifest.json"),
    "utf8",
  )
    .then(JSON.parse)
    .catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
  const repository = embeddedManifest?.repository ?? path.resolve(import.meta.dirname, "../..");
  const instance = path.join(repository, ".codexhost/debug-instance");
  const environment = debugEnvironment(process.env, instance);
  const activeFile = path.join(instance, "active-build.txt");
  const active = await readFile(activeFile, "utf8")
    .then((text) => text.trim())
    .catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
  if (command === "stop" || command === "status") {
    if (!active) {
      console.log(command === "stop" ? "stopped" : JSON.stringify({ instance, running: false }));
      return;
    }
    await verifySnapshot(active);
    console.log(nativeCommand(active, command, instance, environment).trim());
    return;
  }
  if (command === "start" || command === "restart") await prepareInstance(instance);
  const build = await selectedBuild(repository, embeddedManifest ? import.meta.dirname : undefined);
  if (command === "restart" && active) {
    await verifySnapshot(active);
    console.log(nativeCommand(active, "stop", instance, environment).trim());
  }
  // Native locking rejects a duplicate launch before any Desktop can be stopped.
  if (JSON.parse(nativeCommand(build, "status", instance, environment)).running) {
    throw new Error("Debug instance is running; use debug:restart to replace only that instance");
  }
  await writeFile(activeFile, `${build}\n`, { mode: 0o600 });
  await start(build, instance, environment);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
