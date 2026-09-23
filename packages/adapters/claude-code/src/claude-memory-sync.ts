import {
  featureEnabled,
  writeMemorySyncResult,
} from "@claude-in-codex/shared-contracts/features-file";

import {
  exportClaudeMemoryToCodex,
  type ClaudeMemoryExportInput,
  type ClaudeMemoryExportResult,
} from "./codex-memory-export.js";

/**
 * The production memory export of a Claude Session. The `claudeMemorySync` switch is read on
 * every run, so turning it off stops the next sync. Each result lands in the Host data folder,
 * where the menu bar Host reads it for its problem report; a failure is also written to stderr,
 * the Host log, and still rejects so the Session traces it.
 */
export async function syncClaudeMemoryToCodex(
  input: ClaudeMemoryExportInput,
  exportMemory: (
    input: ClaudeMemoryExportInput,
  ) => Promise<ClaudeMemoryExportResult> = exportClaudeMemoryToCodex,
): Promise<ClaudeMemoryExportResult | null> {
  if (!(await featureEnabled("claudeMemorySync", input.environment))) return null;
  const at = () => new Date().toISOString();
  let result: ClaudeMemoryExportResult;
  try {
    result = await exportMemory(input);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Claude memory sync failed: ${message}\n`);
    await writeMemorySyncResult(
      { at: at(), written: 0, removed: 0, error: message },
      input.environment,
    ).catch(() => undefined);
    throw error;
  }
  await writeMemorySyncResult(
    { at: at(), written: result.written.length, removed: result.removed.length, error: null },
    input.environment,
  ).catch(() => undefined);
  return result;
}
