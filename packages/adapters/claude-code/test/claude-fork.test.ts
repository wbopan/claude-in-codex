import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { nativeCheckpointRefSchema, nativeSessionRefSchema } from "@codexhost/shared-contracts";

import { forkClaudeSession } from "../src/claude-fork.js";
import { ClaudePendingSessions } from "../src/pending-session.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "claude-fork-cwd-")));
  roots.push(root);
  const directory = path.join(root, "renamed-project");
  const alias = path.join(root, "original-project");
  await mkdir(directory);
  await symlink(directory, alias, "junction");
  const sourceRef = nativeSessionRefSchema.parse({
    harnessId: "claude-code",
    nativeSessionId: "source-session",
    formatVersion: 1,
  });
  const checkpoint = nativeCheckpointRefSchema.parse({
    ...sourceRef,
    checkpointId: "source-assistant-1",
  });
  const messages = (prefix: string, count: number) =>
    Array.from({ length: count }, (_, index) => [
      {
        type: "user",
        uuid: `${prefix}-user-${index + 1}`,
        session_id: `${prefix}-session`,
        message: { role: "user", content: `prompt ${index + 1}` },
      },
      {
        type: "assistant",
        uuid: `${prefix}-assistant-${index + 1}`,
        session_id: `${prefix}-session`,
        message: { role: "assistant", content: [{ type: "text", text: `reply ${index + 1}` }] },
      },
    ]).flat();
  const dependencies = {
    getSessionInfo: vi.fn(async () => ({ cwd: directory })),
    readSessionMessages: vi.fn(async ({ sessionId }: { sessionId: string }) =>
      sessionId === "source-session" ? messages("source", 2) : messages("derived", 1),
    ),
    forkSession: vi.fn(async () => ({ sessionId: "derived-session" })),
    deleteSession: vi.fn(async () => undefined),
  };
  const run = (kind: "fork" | "rollbackLastTurn", cwd: string) => {
    const common = { cwd, dependencies, harnessId: sourceRef.harnessId, sourceRef };
    return forkClaudeSession(
      kind === "fork"
        ? { ...common, kind, checkpoint }
        : {
            ...common,
            kind,
            pendingSessions: new ClaudePendingSessions({ CLAUDE_CONFIG_DIR: root }),
            configuration: {},
          },
    );
  };
  return { root, directory, alias, dependencies, run };
}

describe.each(["fork", "rollbackLastTurn"] as const)("Claude %s directory identity", (kind) => {
  it.each(["source", "target"])("accepts a %s symlink to the same workspace", async (side) => {
    const f = await fixture();
    const cwd = side === "target" ? f.alias : f.directory;
    f.dependencies.getSessionInfo.mockResolvedValue({
      cwd: side === "source" ? f.alias : f.directory,
    });

    await expect(f.run(kind, cwd)).resolves.toEqual({
      ok: true,
      value: { sessionId: "derived-session" },
    });
    // Keep the caller's cwd for native history and Fork; canonicalization only compares identity.
    expect(f.dependencies.forkSession).toHaveBeenCalledWith({
      checkpointId: "source-assistant-1",
      cwd,
      sourceSessionId: "source-session",
    });
    expect(f.dependencies.deleteSession).not.toHaveBeenCalled();
  });

  it("rejects a symlink to a different workspace before reading or mutating history", async () => {
    const f = await fixture();
    const other = path.join(f.root, "other-project");
    const otherAlias = path.join(f.root, "other-alias");
    await mkdir(other);
    await symlink(other, otherAlias, "junction");

    await expect(f.run(kind, otherAlias)).resolves.toMatchObject({
      ok: false,
      error: { code: "unsupported" },
    });
    expect(f.dependencies.readSessionMessages).not.toHaveBeenCalled();
    expect(f.dependencies.forkSession).not.toHaveBeenCalled();
    expect(f.dependencies.deleteSession).not.toHaveBeenCalled();
  });

  it("does not equate two directories whose real paths cannot be resolved", async () => {
    const f = await fixture();
    f.dependencies.getSessionInfo.mockResolvedValue({ cwd: path.join(f.root, "missing-source") });

    await expect(f.run(kind, path.join(f.root, "missing-target"))).resolves.toMatchObject({
      ok: false,
      error: { code: "unsupported" },
    });
    expect(f.dependencies.readSessionMessages).not.toHaveBeenCalled();
    expect(f.dependencies.forkSession).not.toHaveBeenCalled();
  });
});
