import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { configureClaudeDesktop } from "./claude-desktop.mjs";

const roots = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const home = await mkdtemp(path.join(os.tmpdir(), "claude bridge ' test-"));
  roots.push(home);
  const instance = path.join(home, "debug");
  await mkdir(path.join(instance, "claude"), { recursive: true });
  const bridge = path.join(home, "bridge");
  await mkdir(bridge);
  for (const file of [
    "codex_desktop_mcp.py",
    "app_server_mcp.py",
    "app_approval_policy.py",
    "bridge_common.py",
    "memory_hook.py",
    "lifecycle_hook.py",
  ])
    await writeFile(path.join(bridge, file), "# fixture\n");
  await writeFile(
    path.join(home, ".claude.json"),
    JSON.stringify({
      oauthAccount: { emailAddress: "not-copied" },
      mcpServers: {
        codex_desktop: {
          type: "stdio",
          command: "/usr/bin/python3",
          args: [path.join(bridge, "codex_desktop_mcp.py")],
        },
        unrelated: { command: "not-copied" },
      },
    }),
  );
  return { home, instance };
}
it("uses debug runtime paths and shared memory while preserving private configuration", async () => {
  const { home, instance } = await fixture();
  const file = path.join(instance, "claude/.claude.json");
  await writeFile(file, JSON.stringify({ machineID: "keep", mcpServers: { local: {} } }));
  const settingsFile = path.join(instance, "claude/settings.json");
  await writeFile(settingsFile, JSON.stringify({ permissions: { allow: [] } }));
  expect(await configureClaudeDesktop(instance, home)).toEqual({ configured: true, changed: true });
  const config = JSON.parse(await readFile(file, "utf8"));
  expect(config.machineID).toBe("keep");
  expect(config.oauthAccount).toBeUndefined();
  expect(Object.keys(config.mcpServers)).toEqual(["local", "codex_desktop"]);
  expect(config.mcpServers.codex_desktop.env).toEqual({
    CODEX_HOME: path.join(instance, "codex"),
    CODEX_DESKTOP_APP: path.join(instance, "app/ChatGPT.app"),
  });
  const settings = JSON.parse(await readFile(settingsFile, "utf8"));
  expect(settings.permissions).toEqual({ allow: [] });
  expect(settings.env.CODEXHOST_CUA_OWNER).toBe("app-server");
  expect(settings.hooks.SessionStart[0].hooks[0].command).toContain("CODEX_HOME=");
  expect(settings.hooks.SessionStart[0].hooks[0].command).toContain("'\\''");
  expect(await configureClaudeDesktop(instance, home)).toEqual({
    configured: true,
    changed: false,
  });
});
it("rejects a conflicting MCP before writing either configuration file", async () => {
  const { home, instance } = await fixture();
  const file = path.join(instance, "claude/.claude.json");
  const original = JSON.stringify({ mcpServers: { codex_desktop: { command: "custom" } } });
  await writeFile(file, original);
  await expect(configureClaudeDesktop(instance, home)).rejects.toThrow("differs");
  expect(await readFile(file, "utf8")).toBe(original);
  await expect(readFile(path.join(instance, "claude/settings.json"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});
it("leaves an unconfigured user's profile alone", async () => {
  const { home, instance } = await fixture();
  await writeFile(path.join(home, ".claude.json"), "{}");
  expect(await configureClaudeDesktop(instance, home)).toEqual({ configured: false });
});
it("preserves an explicit debug MCP owner override", async () => {
  const { home, instance } = await fixture();
  const file = path.join(instance, "claude/settings.json");
  await writeFile(file, JSON.stringify({ env: { CODEXHOST_CUA_OWNER: "direct", KEEP: "value" } }));
  await configureClaudeDesktop(instance, home);
  expect(JSON.parse(await readFile(file, "utf8")).env).toEqual({
    CODEXHOST_CUA_OWNER: "direct",
    KEEP: "value",
  });
});
it("rejects an incomplete bridge installation before writing configuration", async () => {
  const { home, instance } = await fixture();
  await rm(path.join(home, "bridge/app_server_mcp.py"));
  await expect(configureClaudeDesktop(instance, home)).rejects.toThrow();
  for (const file of [".claude.json", "settings.json"])
    await expect(readFile(path.join(instance, "claude", file))).rejects.toMatchObject({
      code: "ENOENT",
    });
});
