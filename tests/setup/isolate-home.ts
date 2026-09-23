import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll } from "vitest";

/**
 * Point every home-derived location at a throwaway directory so a test that forgets to pass
 * its own environment reads an empty home instead of the developer's ~/.codex or ~/.claude.
 * `os.homedir()` honours HOME, so code that falls back to it is covered too.
 */
const home = realpathSync(mkdtempSync(path.join(os.tmpdir(), "claude-in-codex-home-")));
for (const directory of [".codex", ".claude"]) mkdirSync(path.join(home, directory));

process.env.HOME = home;
process.env.CODEX_HOME = path.join(home, ".codex");
process.env.CLAUDE_CONFIG_DIR = path.join(home, ".claude");
delete process.env.XDG_CONFIG_HOME;
delete process.env.XDG_DATA_HOME;
delete process.env.XDG_STATE_HOME;
delete process.env.XDG_CACHE_HOME;

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});
