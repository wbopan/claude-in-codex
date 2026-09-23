import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { readClaudeCodeVersion, resolveClaudeCodeExecutable } from "../src/command.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});

function fakeExecutable(): { directory: string; executable: string } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codexhost-claude-adapter-"));
  directories.push(directory);
  const executable = path.join(directory, process.platform === "win32" ? "claude.exe" : "claude");
  fs.writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  return { directory, executable };
}

describe("Claude Code executable resolution", () => {
  it("uses an explicit command", () => {
    const { executable } = fakeExecutable();
    expect(
      resolveClaudeCodeExecutable({ command: executable, environment: {}, platform: "darwin" }),
    ).toBe(executable);
  });

  it("resolves from PATH", () => {
    const { directory, executable } = fakeExecutable();
    expect(
      resolveClaudeCodeExecutable({
        environment: { PATH: directory, PATHEXT: ".exe" },
        platform: process.platform,
      }),
    ).toBe(executable);
  });

  it("resolves the Windows npm shim to Claude Code's native executable", () => {
    const appData = String.raw`C:\Users\test\AppData\Roaming`;
    const shim = String.raw`C:\Users\test\AppData\Roaming\npm\claude.cmd`;
    const nativeExecutable = String.raw`C:\Users\test\AppData\Roaming\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe`;

    expect(
      resolveClaudeCodeExecutable(
        {
          environment: {
            APPDATA: appData,
            PATH: String.raw`C:\Users\test\AppData\Roaming\npm`,
            PATHEXT: ".CMD",
          },
          homeDirectory: String.raw`C:\Users\test`,
          platform: "win32",
        },
        { isExecutable: (candidate) => candidate === shim || candidate === nativeExecutable },
      ),
    ).toBe(nativeExecutable);
  });

  it("rejects a Windows npm shim without a native executable", () => {
    const shim = String.raw`C:\tools\claude.cmd`;

    expect(() =>
      resolveClaudeCodeExecutable(
        { command: shim, environment: {}, platform: "win32" },
        { isExecutable: (candidate) => candidate === shim },
      ),
    ).toThrow("not installed");
  });

  it("finds a user npm installation when a Finder-style PATH omits it", () => {
    const homeDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "codexhost-claude-home-"));
    directories.push(homeDirectory);
    const executable = path.join(homeDirectory, ".npm-global", "bin", "claude");
    fs.mkdirSync(path.dirname(executable), { recursive: true });
    fs.writeFileSync(executable, "#!/usr/bin/env node\nexit 0\n", { mode: 0o700 });

    expect(
      resolveClaudeCodeExecutable({
        environment: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
        homeDirectory,
        platform: "darwin",
      }),
    ).toBe(executable);
  });

  it("finds a user NVM installation when a Finder-style PATH omits it", () => {
    const homeDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "codexhost-claude-home-"));
    directories.push(homeDirectory);
    const executable = path.join(
      homeDirectory,
      ".nvm",
      "versions",
      "node",
      "v24.18.0",
      "bin",
      "claude",
    );
    fs.mkdirSync(path.dirname(executable), { recursive: true });
    fs.writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });

    expect(
      resolveClaudeCodeExecutable({
        environment: { PATH: "" },
        homeDirectory,
        platform: "darwin",
      }),
    ).toBe(executable);
  });

  it("fails without substituting the SDK bundled binary", () => {
    const homeDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "codexhost-claude-home-"));
    directories.push(homeDirectory);
    expect(() =>
      resolveClaudeCodeExecutable({
        environment: { PATH: "" },
        homeDirectory,
        platform: "linux",
      }),
    ).toThrow("not installed");
  });
});

describe.skipIf(process.platform === "win32")("readClaudeCodeVersion", () => {
  it("returns the bare version the CLI reports and null when it fails", async () => {
    const { directory, executable } = fakeExecutable();
    fs.writeFileSync(executable, '#!/bin/sh\necho "2.3.14 (Claude Code)"\n', { mode: 0o700 });
    await expect(readClaudeCodeVersion(executable, {})).resolves.toBe("2.3.14");
    const broken = path.join(directory, "broken");
    fs.writeFileSync(broken, "#!/bin/sh\nexit 3\n", { mode: 0o700 });
    await expect(readClaudeCodeVersion(broken, {})).resolves.toBeNull();
    await expect(readClaudeCodeVersion(path.join(directory, "missing"), {})).resolves.toBeNull();
  });
});
