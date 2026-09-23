import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { syncClaudeMemoryToCodex } from "../src/claude-memory-sync.js";

let data: string;
let environment: NodeJS.ProcessEnv;
beforeEach(async () => {
  data = await mkdtemp(path.join(os.tmpdir(), "claude-in-codex-memory-sync-"));
  environment = { CLAUDE_IN_CODEX_DATA_DIR: data };
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(data, { recursive: true, force: true });
});

const lastResult = async () =>
  JSON.parse(await readFile(path.join(data, "claude-memory-sync.json"), "utf8"));

describe("Claude memory sync switch", () => {
  it("records each export result in the Host data folder", async () => {
    const exportMemory = vi.fn(async () => ({
      directory: "/mirror",
      written: ["a.md", "b.md"],
      removed: ["c.md"],
    }));
    await syncClaudeMemoryToCodex({ cwd: "/project", environment }, exportMemory);
    expect(exportMemory).toHaveBeenCalledWith({ cwd: "/project", environment });
    expect(await lastResult()).toMatchObject({ written: 2, removed: 1, error: null });
  });

  it("reads the switch on every run, so turning it off stops the next sync", async () => {
    const exportMemory = vi.fn(async () => ({ directory: null, written: [], removed: [] }));
    await writeFile(path.join(data, "features.json"), JSON.stringify({ claudeMemorySync: false }));
    await expect(
      syncClaudeMemoryToCodex({ cwd: "/project", environment }, exportMemory),
    ).resolves.toBeNull();
    expect(exportMemory).not.toHaveBeenCalled();
    await writeFile(path.join(data, "features.json"), JSON.stringify({ claudeMemorySync: true }));
    await expect(
      syncClaudeMemoryToCodex({ cwd: "/project", environment }, exportMemory),
    ).resolves.not.toBeNull();
    expect(exportMemory).toHaveBeenCalledTimes(1);
  });

  it("records and logs a failure, then rejects so the Session traces it", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await expect(
      syncClaudeMemoryToCodex({ cwd: "/project", environment }, async () => {
        throw new Error("disk full");
      }),
    ).rejects.toThrow("disk full");
    expect(await lastResult()).toMatchObject({ written: 0, removed: 0, error: "disk full" });
    expect(stderr).toHaveBeenCalledWith("Claude memory sync failed: disk full\n");
  });
});
