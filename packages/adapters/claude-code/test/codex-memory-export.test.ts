import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  CODEX_MEMORY_EXTENSION_INSTRUCTIONS,
  codexMemoryExtensionDirectory,
  exportClaudeMemoryToCodex,
} from "../src/codex-memory-export.js";

async function fixture() {
  // Canonical like Claude Code's own project keys: macOS tmpdir sits behind /var -> /private/var.
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "claude-in-codex-memory-export-")));
  const claudeHome = path.join(root, "claude");
  const codexHome = path.join(root, "codex");
  const cwd = path.join(root, "work", "my project");
  await mkdir(cwd, { recursive: true });
  await mkdir(path.join(codexHome, "memories"), { recursive: true });
  const memory = path.join(claudeHome, "projects", cwd.replace(/[^A-Za-z0-9]/gu, "-"), "memory");
  await mkdir(memory, { recursive: true });
  const environment = { CLAUDE_CONFIG_DIR: claudeHome, CODEX_HOME: codexHome };
  const mirror = path.join(
    codexMemoryExtensionDirectory(environment),
    "resources",
    cwd.replace(/[^A-Za-z0-9]/gu, "-"),
  );
  return { root, claudeHome, codexHome, cwd, memory, environment, mirror };
}

const note = (name: string, body: string) =>
  `---\nname: ${name}\ndescription: ${body}\nmetadata:\n  originSessionId: s1\n---\n\n${body}\n`;

describe("Claude memory export to Codex", () => {
  it("mirrors memory files with scope.json and the extension instructions", async () => {
    const f = await fixture();
    try {
      await writeFile(path.join(f.memory, "tests.md"), note("tests", "Run bun test."));
      await mkdir(path.join(f.memory, "nested"));
      await writeFile(path.join(f.memory, "nested", "deep.md"), note("deep", "Nested lesson."));
      await writeFile(path.join(f.memory, "notes.txt"), "not markdown");
      const result = await exportClaudeMemoryToCodex({ cwd: f.cwd, environment: f.environment });
      expect(result.directory).toBe(f.mirror);
      expect(result.written).toEqual([
        "instructions.md",
        "scope.json",
        "nested/deep.md",
        "tests.md",
      ]);
      expect(result.removed).toEqual([]);
      expect(await readFile(path.join(f.mirror, "tests.md"), "utf8")).toBe(
        note("tests", "Run bun test."),
      );
      expect(JSON.parse(await readFile(path.join(f.mirror, "scope.json"), "utf8"))).toEqual({
        cwd: f.cwd,
      });
      expect(
        await readFile(
          path.join(f.codexHome, "memories/extensions/claude_code/instructions.md"),
          "utf8",
        ),
      ).toBe(CODEX_MEMORY_EXTENSION_INSTRUCTIONS);
      await expect(stat(path.join(f.mirror, "notes.txt"))).rejects.toThrow();
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("is idempotent and propagates edits and deletions", async () => {
    const f = await fixture();
    try {
      await writeFile(path.join(f.memory, "a.md"), note("a", "A"));
      await writeFile(path.join(f.memory, "b.md"), note("b", "B"));
      await exportClaudeMemoryToCodex({ cwd: f.cwd, environment: f.environment });
      const again = await exportClaudeMemoryToCodex({ cwd: f.cwd, environment: f.environment });
      expect(again).toEqual({ directory: f.mirror, written: [], removed: [] });

      await writeFile(path.join(f.memory, "a.md"), note("a", "A revised"));
      await rm(path.join(f.memory, "b.md"));
      const changed = await exportClaudeMemoryToCodex({ cwd: f.cwd, environment: f.environment });
      expect(changed).toEqual({ directory: f.mirror, written: ["a.md"], removed: ["b.md"] });
      await expect(stat(path.join(f.mirror, "b.md"))).rejects.toThrow();
      expect(await readFile(path.join(f.mirror, "a.md"), "utf8")).toContain("A revised");
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("removes the whole mirror when the source memory is emptied", async () => {
    const f = await fixture();
    try {
      await writeFile(path.join(f.memory, "a.md"), note("a", "A"));
      await exportClaudeMemoryToCodex({ cwd: f.cwd, environment: f.environment });
      await rm(path.join(f.memory, "a.md"));
      const result = await exportClaudeMemoryToCodex({ cwd: f.cwd, environment: f.environment });
      expect(result).toEqual({ directory: f.mirror, written: [], removed: ["a.md"] });
      await expect(stat(f.mirror)).rejects.toThrow();
      // The extension itself (instructions for other projects) stays.
      await stat(path.join(f.codexHome, "memories/extensions/claude_code/instructions.md"));
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("does nothing without source memories, without a Codex memories directory", async () => {
    const f = await fixture();
    try {
      const none = { directory: null, written: [], removed: [] };
      await expect(
        exportClaudeMemoryToCodex({ cwd: f.cwd, environment: f.environment }),
      ).resolves.toEqual(none);
      await expect(stat(path.join(f.codexHome, "memories/extensions"))).rejects.toThrow();

      await writeFile(path.join(f.memory, "a.md"), note("a", "A"));
      await rm(path.join(f.codexHome, "memories"), { recursive: true });
      await expect(
        exportClaudeMemoryToCodex({ cwd: f.cwd, environment: f.environment }),
      ).resolves.toEqual(none);
      await expect(stat(path.join(f.codexHome, "memories"))).rejects.toThrow();
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("skips symlinked memory files", async () => {
    const f = await fixture();
    try {
      await writeFile(path.join(f.root, "outside.md"), note("outside", "Not a memory."));
      await symlink(path.join(f.root, "outside.md"), path.join(f.memory, "link.md"));
      await writeFile(path.join(f.memory, "real.md"), note("real", "Real."));
      const result = await exportClaudeMemoryToCodex({ cwd: f.cwd, environment: f.environment });
      expect(result.written).toEqual(["instructions.md", "scope.json", "real.md"]);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("resolves a symlinked cwd to the project key Claude Code saved under", async () => {
    const f = await fixture();
    try {
      await writeFile(path.join(f.memory, "rule.md"), note("rule", "Blind attacks only."));
      const alias = path.join(f.root, "work", "old name");
      await symlink(f.cwd, alias);
      const result = await exportClaudeMemoryToCodex({ cwd: alias, environment: f.environment });
      expect(result.directory).toBe(f.mirror);
      expect(result.written).toEqual(["instructions.md", "scope.json", "rule.md"]);
      expect(JSON.parse(await readFile(path.join(f.mirror, "scope.json"), "utf8"))).toEqual({
        cwd: f.cwd,
      });
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });
});
