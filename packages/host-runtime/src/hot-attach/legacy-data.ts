import { lstat, mkdir, readdir, rename, rm, rmdir } from "node:fs/promises";
import path from "node:path";

import { mappingStoreOwnerIsLive } from "@claude-in-codex/mapping-store";
import {
  legacyDataDirectory,
  logDirectory,
  platformDataDirectory,
} from "@claude-in-codex/shared-contracts/app-paths";

/** What the menu bar Host kept in `~/.codexhost`; each entry moves as a whole. */
const MOVED_ENTRIES = new Set([
  "mapping-store",
  "native-picker-selection.json",
  "harness-launch-settings",
  "plugins",
  "native-picker-trace.jsonl",
]);
/** Written only by the removed local launcher. */
const OBSOLETE_ENTRIES = new Set(["desktop-proxy"]);

export interface LegacyDataMigration {
  moved: string[];
  /** Left in place: Remote Host installs, brokers, unknown files and entries the new folder already has. */
  kept: string[];
}

async function exists(file: string): Promise<boolean> {
  return (await lstat(file).catch(() => null)) !== null;
}

/**
 * Moves the data the pre-rename App kept in `~/.codexhost` into the macOS data folder, and its
 * logs into the Logs folder. Runs only for the default data folder, and refuses while a legacy
 * Host still owns the Mapping Store: moving it then would split one store across two Hosts.
 */
export async function migrateLegacyDataDirectory(
  environment: NodeJS.ProcessEnv,
): Promise<LegacyDataMigration | null> {
  const legacy = legacyDataDirectory(environment);
  if (!(await lstat(legacy).catch(() => null))?.isDirectory()) return null;
  if (await mappingStoreOwnerIsLive(path.join(legacy, "mapping-store"))) {
    throw new Error(
      "The previous Codex Host is still running. Quit it, then attach again to move its data.",
    );
  }
  const target = platformDataDirectory(environment);
  await mkdir(target, { recursive: true, mode: 0o700 });
  const result: LegacyDataMigration = { moved: [], kept: [] };
  for (const entry of await readdir(legacy)) {
    const source = path.join(legacy, entry);
    if (MOVED_ENTRIES.has(entry) && !(await exists(path.join(target, entry)))) {
      await rename(source, path.join(target, entry));
      result.moved.push(entry);
    } else if (entry === "logs") {
      const logs = logDirectory(environment);
      await mkdir(logs, { recursive: true, mode: 0o700 });
      for (const file of await readdir(source)) {
        await rename(path.join(source, file), path.join(logs, `codexhost-${file}`));
      }
      await rmdir(source);
      result.moved.push(entry);
    } else if (OBSOLETE_ENTRIES.has(entry)) {
      await rm(source, { recursive: true, force: true });
    } else {
      result.kept.push(entry);
    }
  }
  if (result.kept.length === 0) await rmdir(legacy).catch(() => undefined);
  return result;
}
