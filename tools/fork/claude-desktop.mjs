import { copyFile, lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

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

const BRIDGE_HOOK = /(?:^|[/'" ])lifecycle_hook\.py(?:['" ]|$)/u;

/**
 * The Host now owns `cua_repl` and `codex_app` (see official-desktop-tools.ts), so the external
 * Python bridge is retired from the private debug Claude profile: its MCP registration, the
 * owner override and its turn lifecycle hooks. Anything else in the profile is left untouched,
 * and the user's standard Claude profile is never read or written.
 */
export async function retireClaudeDesktopBridge(instance) {
  const configPath = path.join(instance, "claude/.claude.json");
  const settingsPath = path.join(instance, "claude/settings.json");
  const config = await jsonFile(configPath);
  const settings = await jsonFile(settingsPath);
  const originalConfig = JSON.stringify(config);
  const originalSettings = JSON.stringify(settings);

  if (config.mcpServers) {
    delete config.mcpServers.codex_desktop;
    if (Object.keys(config.mcpServers).length === 0) delete config.mcpServers;
  }
  if (settings.env) {
    delete settings.env.CODEXHOST_CUA_OWNER;
    if (Object.keys(settings.env).length === 0) delete settings.env;
  }
  for (const [event, groups] of Object.entries(settings.hooks ?? {})) {
    if (!Array.isArray(groups)) continue;
    const kept = groups
      .map((group) =>
        Array.isArray(group?.hooks)
          ? {
              ...group,
              hooks: group.hooks.filter((hook) => !BRIDGE_HOOK.test(hook?.command ?? "")),
            }
          : group,
      )
      .filter((group) => !Array.isArray(group?.hooks) || group.hooks.length > 0);
    if (kept.length > 0) settings.hooks[event] = kept;
    else delete settings.hooks[event];
  }
  if (settings.hooks && Object.keys(settings.hooks).length === 0) delete settings.hooks;

  const changes = [
    [configPath, config, originalConfig],
    [settingsPath, settings, originalSettings],
  ].filter(([, data, original]) => JSON.stringify(data) !== original);
  if (changes.length) {
    const backup = path.join(instance, "claude/backups", `retire-desktop-bridge-${Date.now()}`);
    await mkdir(backup, { recursive: true, mode: 0o700 });
    for (const [file] of changes) await copyFile(file, path.join(backup, path.basename(file)));
    for (const [file, data] of changes) {
      const temporary = `${file}.retire-bridge-${process.pid}`;
      await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      await rename(temporary, file);
    }
  }
  return { changed: changes.length > 0 };
}
