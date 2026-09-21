import { copyFile, lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

async function jsonFile(file) {
  try {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error(`Expected a regular file: ${file}`);
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}

// Reuse only the explicitly installed Desktop bridge. Credentials, other MCPs,
// permission grants, production settings and task metadata are not imported.
export async function configureClaudeDesktop(instance, home) {
  const source = await jsonFile(path.join(home, ".claude.json"));
  const registration = source.mcpServers?.codex_desktop;
  if (!registration) return { configured: false };
  const script = registration.args?.[0];
  if (
    registration.type !== "stdio" ||
    registration.command !== "/usr/bin/python3" ||
    !Array.isArray(registration.args) ||
    registration.args.length !== 1 ||
    typeof script !== "string" ||
    !path.isAbsolute(script) ||
    path.basename(script) !== "codex_desktop_mcp.py"
  ) {
    throw new Error("Unrecognized user codex_desktop bridge; debug configuration was not changed");
  }
  const directory = path.dirname(script);
  for (const name of [
    "codex_desktop_mcp.py",
    "app_server_mcp.py",
    "app_approval_policy.py",
    "bridge_common.py",
    "memory_hook.py",
    "lifecycle_hook.py",
  ]) {
    if (!(await lstat(path.join(directory, name))).isFile())
      throw new Error(`Missing Desktop bridge script: ${name}`);
  }
  const configPath = path.join(instance, "claude/.claude.json");
  const settingsPath = path.join(instance, "claude/settings.json");
  const config = await jsonFile(configPath);
  const settings = await jsonFile(settingsPath);
  const desired = {
    ...registration,
    env: {
      ...registration.env,
      CODEX_HOME: path.join(instance, "codex"),
      CODEX_DESKTOP_APP: path.join(instance, "app/ChatGPT.app"),
    },
  };
  const existing = config.mcpServers?.codex_desktop;
  if (existing && !isDeepStrictEqual(existing, desired))
    throw new Error(
      "Debug codex_desktop registration differs; existing configuration was retained",
    );
  const originalConfig = JSON.stringify(config);
  const originalSettings = JSON.stringify(settings);
  config.mcpServers ??= {};
  config.mcpServers.codex_desktop = desired;
  // The official app-server owns cua_repl so IAB receives a supported native peer.
  // Keep an explicit debug override, including the direct owner for diagnostics.
  settings.env ??= {};
  settings.env.CODEXHOST_CUA_OWNER ??= "app-server";
  settings.hooks ??= {};
  for (const event of ["SessionStart", "Stop", "StopFailure", "SessionEnd"]) {
    const memory = event === "SessionStart";
    // The memory source is intentionally shared; the MCP runtime keeps debug CODEX_HOME.
    const command =
      (memory ? `/usr/bin/env ${quote(`CODEX_HOME=${path.join(home, ".codex")}`)} ` : "") +
      `/usr/bin/python3 ${quote(path.join(directory, memory ? "memory_hook.py" : "lifecycle_hook.py"))}`;
    const groups = (settings.hooks[event] ??= []);
    if (!groups.some((group) => group.hooks?.some((hook) => hook.command === command)))
      groups.push({ hooks: [{ type: "command", command, timeout: 5 }] });
  }
  const changes = [
    [configPath, config, originalConfig],
    [settingsPath, settings, originalSettings],
  ].filter(([, data, original]) => JSON.stringify(data) !== original);
  if (changes.length) {
    const backup = path.join(instance, "claude/backups", `desktop-bridge-${Date.now()}`);
    await mkdir(backup, { recursive: true, mode: 0o700 });
    for (const [file] of changes) {
      await copyFile(file, path.join(backup, path.basename(file))).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
    for (const [file, data] of changes) {
      const temporary = `${file}.desktop-bridge-${process.pid}`;
      await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      await rename(temporary, file);
    }
  }
  return { configured: true, changed: changes.length > 0 };
}
