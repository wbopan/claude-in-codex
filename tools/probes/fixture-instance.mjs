// Private, isolated Codex Desktop + Claude fixture instances for the menu bar and hot-attach
// probes. The probes clone the signed official Desktop into the instance and run it with this
// environment, so they never touch the user's real Codex, Claude or Host state.
import { execFileSync } from "node:child_process";
import { constants } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { retireClaudeDesktopBridge } from "./claude-desktop.mjs";

const marker = "claude-in-codex-debug-instance-v1\n";

export function debugEnvironment(environment, instance) {
  const clean = Object.fromEntries(
    Object.entries(environment).filter(
      ([key]) =>
        !key.startsWith("CODEX") &&
        !key.startsWith("CLAUDE_IN_CODEX_") &&
        !key.startsWith("CLAUDE_CODE_") &&
        !["ELECTRON_RUN_AS_NODE", "NODE_OPTIONS", "CLAUDE_CONFIG_DIR"].includes(key),
    ),
  );
  return {
    ...clean,
    CODEX_HOME: path.join(instance, "codex"),
    CODEX_SQLITE_HOME: path.join(instance, "codex"),
    CODEX_ELECTRON_USER_DATA_PATH: path.join(instance, "electron"),
    CLAUDE_IN_CODEX_DATA_DIR: path.join(instance, "host"),
    CLAUDE_IN_CODEX_HARNESS_BROKER_DIR: path.join(instance, "broker"),
    CLAUDE_IN_CODEX_CLAUDE_BROKER_DESCRIPTOR: path.join(
      instance,
      "broker/claude-code-broker-v1.json",
    ),
    CLAUDE_CONFIG_DIR: path.join(instance, "claude"),
    // Empty selects Claude's default credential store, including its unscoped macOS Keychain
    // entry. An explicit ~/.claude path selects a different, hashed Keychain entry.
    CLAUDE_SECURESTORAGE_CONFIG_DIR: environment.CLAUDE_SECURESTORAGE_CONFIG_DIR ?? "",
    CLAUDE_IN_CODEX_STARTUP_TRACE: "1",
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
