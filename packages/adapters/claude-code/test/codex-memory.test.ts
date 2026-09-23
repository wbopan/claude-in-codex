import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { codexMemorySummaryPath, readCodexMemoryAppend } from "../src/codex-memory.js";

async function codexHome(summary?: string): Promise<string> {
  const home = await mkdtemp(path.join(os.tmpdir(), "claude-in-codex-codex-memory-"));
  if (summary !== undefined) {
    await mkdir(path.join(home, "memories"), { recursive: true });
    await writeFile(path.join(home, "memories", "memory_summary.md"), summary);
  }
  return home;
}

describe("Codex memory summary", () => {
  it("resolves the summary under CODEX_HOME, defaulting to ~/.codex", () => {
    expect(codexMemorySummaryPath({ CODEX_HOME: "/tmp/codex-home" })).toBe(
      path.join("/tmp/codex-home", "memories", "memory_summary.md"),
    );
    expect(codexMemorySummaryPath({})).toBe(
      path.join(os.homedir(), ".codex", "memories", "memory_summary.md"),
    );
  });

  it("wraps the summary with its source and a dating note", async () => {
    const home = await codexHome("v1\n\n## User Profile\n\nLikes green tea.\n");
    try {
      const append = await readCodexMemoryAppend({
        CODEX_HOME: home,
        CLAUDE_IN_CODEX_DATA_DIR: home,
      });
      expect(append).toBeDefined();
      expect(append).toContain(
        `<codex-memory source="${path.join(home, "memories", "memory_summary.md")}">`,
      );
      expect(append).toContain("Likes green tea.");
      expect(append?.endsWith("</codex-memory>")).toBe(true);
      expect(append).toContain("dated context");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("returns nothing when the summary is missing or empty", async () => {
    const missing = await codexHome();
    const empty = await codexHome("  \n");
    try {
      await expect(
        readCodexMemoryAppend({ CODEX_HOME: missing, CLAUDE_IN_CODEX_DATA_DIR: missing }),
      ).resolves.toBeUndefined();
      await expect(
        readCodexMemoryAppend({ CODEX_HOME: empty, CLAUDE_IN_CODEX_DATA_DIR: empty }),
      ).resolves.toBeUndefined();
    } finally {
      await rm(missing, { recursive: true, force: true });
      await rm(empty, { recursive: true, force: true });
    }
  });

  it("reads the codexMemory switch in features.json on every call", async () => {
    const home = await codexHome("remember me");
    const environment = { CODEX_HOME: home, CLAUDE_IN_CODEX_DATA_DIR: home };
    try {
      await writeFile(path.join(home, "features.json"), JSON.stringify({ codexMemory: false }));
      await expect(readCodexMemoryAppend(environment)).resolves.toBeUndefined();
      await writeFile(path.join(home, "features.json"), JSON.stringify({ codexMemory: true }));
      await expect(readCodexMemoryAppend(environment)).resolves.toContain("remember me");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("truncates a runaway summary instead of forwarding it whole", async () => {
    const home = await codexHome("x".repeat(70 * 1024));
    try {
      const append = await readCodexMemoryAppend({
        CODEX_HOME: home,
        CLAUDE_IN_CODEX_DATA_DIR: home,
      });
      expect(append).toContain("[truncated]");
      expect(Buffer.byteLength(append ?? "", "utf8")).toBeLessThan(66 * 1024);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
