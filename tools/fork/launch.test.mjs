import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { inventory, requireStoppedDesktop, verifySnapshot } from "./launch.mjs";

const directories = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "codexhost-fork-"));
  directories.push(root);
  for (const relative of [
    "bin/codexhost",
    "libexec/codexhost-shim",
    "runtime/node",
    "app/host-runtime.mjs",
    "app/desktop-controller.mjs",
    "app/renderer-extension.js",
  ]) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), relative);
  }
  const manifest = {
    schemaVersion: 1,
    commit: "a".repeat(40),
    platform: process.platform,
    architecture: process.arch,
    files: await inventory(root),
  };
  await writeFile(path.join(root, "fork-manifest.json"), JSON.stringify(manifest));
  return { root, manifest };
}

describe("fork snapshot launch", () => {
  it("verifies a complete snapshot and rejects a changed bundle", async () => {
    const { root, manifest } = await fixture();
    await expect(verifySnapshot(root)).resolves.toEqual(manifest);
    await writeFile(path.join(root, "app/host-runtime.mjs"), "modified");
    await expect(verifySnapshot(root)).rejects.toThrow("Snapshot files changed");
  });

  it("rejects extra plugins and source-linked runtime files", async () => {
    const { root } = await fixture();
    await writeFile(path.join(root, "app/extra.mjs"), "extra");
    await expect(verifySnapshot(root)).rejects.toThrow("Snapshot files changed");
    await rm(path.join(root, "app/extra.mjs"));
    await symlink(path.join(root, "runtime/node"), path.join(root, "app/source-link"));
    await expect(verifySnapshot(root)).rejects.toThrow("symbolic link");
  });

  it("rejects installer update metadata even if recorded in the manifest", async () => {
    const { root, manifest } = await fixture();
    await writeFile(path.join(root, "app/codexhost-distribution.json"), "{}");
    manifest.files = await inventory(root);
    await writeFile(path.join(root, "fork-manifest.json"), JSON.stringify(manifest));
    await expect(verifySnapshot(root)).rejects.toThrow("upstream installer updater");
  });

  it("requires Desktop and Host to exit without terminating them", () => {
    for (const command of [
      "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
      "/Users/example/Applications/Codex.app/Contents/MacOS/Codex",
      "/a build/bin/codexhost",
      "/a build/libexec/codexhost-shim",
    ]) {
      expect(() => requireStoppedDesktop(`/usr/bin/login\n${command}\n`)).toThrow("still running");
    }
    expect(() => requireStoppedDesktop("/usr/bin/login\n/opt/homebrew/bin/node\n")).not.toThrow();
  });

  it("allows independent CLI services and crash reporters from the Desktop bundle", () => {
    const processes = [
      "/Applications/ChatGPT.app/Contents/Resources/codex",
      "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node_repl",
      "/Applications/ChatGPT.app/Contents/Frameworks/Codex Framework.framework/Helpers/browser_crashpad_handler",
    ].join("\n");
    expect(() => requireStoppedDesktop(processes)).not.toThrow();
    expect(() =>
      requireStoppedDesktop(`${processes}\n/Applications/ChatGPT.app/Contents/MacOS/ChatGPT`),
    ).toThrow("still running");
  });
});
