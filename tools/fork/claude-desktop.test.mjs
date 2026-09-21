import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { retireClaudeDesktopBridge } from "./claude-desktop.mjs";

const temporary = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function profile(config, settings) {
  const instance = await mkdtemp(path.join(tmpdir(), "retire-bridge-"));
  temporary.push(instance);
  await mkdir(path.join(instance, "claude"), { recursive: true });
  if (config) await writeFile(path.join(instance, "claude/.claude.json"), JSON.stringify(config));
  if (settings)
    await writeFile(path.join(instance, "claude/settings.json"), JSON.stringify(settings));
  return instance;
}
const read = async (instance, name) =>
  JSON.parse(await readFile(path.join(instance, "claude", name), "utf8"));
const hook = (command) => ({ hooks: [{ type: "command", command, timeout: 5 }] });

test("removes only the bridge registration, owner override and lifecycle hooks", async () => {
  const memory = hook(
    "/usr/bin/env 'CODEX_HOME=/h/.codex' /usr/bin/python3 '/b/bin/memory_hook.py'",
  );
  const lifecycle = hook("/usr/bin/python3 '/b/bin/lifecycle_hook.py'");
  const instance = await profile(
    { mcpServers: { codex_desktop: { type: "stdio" }, other: { type: "stdio" } }, keep: 1 },
    {
      env: { CODEXHOST_CUA_OWNER: "app-server", KEEP: "1" },
      hooks: { SessionStart: [memory], Stop: [lifecycle], SessionEnd: [lifecycle, memory] },
    },
  );
  expect(await retireClaudeDesktopBridge(instance)).toEqual({ changed: true });
  expect(await read(instance, ".claude.json")).toEqual({
    mcpServers: { other: { type: "stdio" } },
    keep: 1,
  });
  expect(await read(instance, "settings.json")).toEqual({
    env: { KEEP: "1" },
    hooks: { SessionStart: [memory], SessionEnd: [memory] },
  });
  expect(await readdir(path.join(instance, "claude/backups"))).toHaveLength(1);
  // A second run has nothing left to retire and writes nothing.
  expect(await retireClaudeDesktopBridge(instance)).toEqual({ changed: false });
  expect(await readdir(path.join(instance, "claude/backups"))).toHaveLength(1);
});

test("leaves a fresh profile untouched", async () => {
  const instance = await profile();
  expect(await retireClaudeDesktopBridge(instance)).toEqual({ changed: false });
  expect(await readdir(path.join(instance, "claude"))).toEqual([]);
});
