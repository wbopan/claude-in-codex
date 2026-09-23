import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { onTestFinished } from "vitest";

/**
 * Create a temporary directory that is removed when the current test finishes.
 *
 * The path is canonical: on macOS the system temp directory sits behind /var -> /private/var,
 * and code that calls realpath (as Claude Code does for project keys) would otherwise see a
 * different path than the test. Call it from a test or a beforeEach hook, not a describe body.
 */
export async function tempDir(prefix = "claude-in-codex-test-"): Promise<string> {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
