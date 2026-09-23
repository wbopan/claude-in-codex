import path from "node:path";

import { describe, expect, it, vi } from "vitest";
import {
  harnessPermissionModeIdSchema,
  harnessThinkingOptionIdSchema,
  nativeCheckpointRefSchema,
  nativeSessionRefSchema,
} from "@claude-in-codex/shared-contracts";

import { encodeClaudeModelRef } from "../../src/model-catalog.js";
import { fixture, nextEvent, openSession, textTurn } from "./fixture.js";

describe("Claude Code HarnessAdapter", () => {
  it("passes per-Session delegation environment to the SDK transport", async () => {
    const { adapter, dependencies } = fixture();
    const session = await openSession(adapter, {
      CLAUDE_IN_CODEX_CLI_PATH: "/opt/claude-in-codex",
      CLAUDE_IN_CODEX_RUNTIME_ENDPOINT: "http://127.0.0.1:43123",
      CLAUDE_IN_CODEX_RUNTIME_TOKEN: "token",
      CLAUDE_IN_CODEX_THREAD_ID: "thread-1",
    });
    await session.execute(textTurn("environment-turn"));
    expect(dependencies.createTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        environment: expect.objectContaining({
          CLAUDE_IN_CODEX_CLI_PATH: "/opt/claude-in-codex",
          CLAUDE_IN_CODEX_RUNTIME_ENDPOINT: "http://127.0.0.1:43123",
          CLAUDE_IN_CODEX_RUNTIME_TOKEN: "token",
          CLAUDE_IN_CODEX_THREAD_ID: "thread-1",
        }),
      }),
    );
    await adapter.close();
  });
  it("opens and closes unused Sessions without creating a Transport", async () => {
    const { adapter, dependencies } = fixture();
    const session = await openSession(adapter);

    expect(dependencies.createTransport).not.toHaveBeenCalled();
    await session.close();
    expect(dependencies.createTransport).not.toHaveBeenCalled();
  });

  it("rolls back the last Turn through Claude's Native Fork", async () => {
    const { adapter, dependencies, history } = fixture();
    const sourceRef = nativeSessionRefSchema.parse({
      harnessId: "claude-code",
      nativeSessionId: "source-session",
      formatVersion: 1,
    });
    history.push(
      {
        type: "user",
        uuid: "user-1",
        session_id: "source-session",
        message: { role: "user", content: "first" },
      },
      {
        type: "assistant",
        uuid: "assistant-1",
        session_id: "source-session",
        message: { role: "assistant", content: [{ type: "text", text: "answer" }] },
      },
      {
        type: "user",
        uuid: "user-2",
        session_id: "source-session",
        message: { role: "user", content: "second" },
      },
      {
        type: "assistant",
        uuid: "assistant-2",
        session_id: "source-session",
        message: { role: "assistant", content: [{ type: "text", text: "answer" }] },
      },
    );
    vi.mocked(dependencies.readSessionMessages).mockImplementation(async ({ sessionId }) =>
      sessionId === "derived-session"
        ? [
            {
              type: "user",
              uuid: "derived-user-1",
              session_id: "derived-session",
              message: { role: "user", content: "first" },
            },
            {
              type: "assistant",
              uuid: "derived-assistant-1",
              session_id: "derived-session",
              message: { role: "assistant", content: [{ type: "text", text: "answer" }] },
            },
          ]
        : structuredClone(history),
    );

    const opened = await adapter.open({ kind: "rollbackLastTurn", sourceRef, cwd: "/synthetic" });
    if (!opened.ok) throw new Error(opened.error.message);
    expect(dependencies.forkSession).toHaveBeenCalledWith({
      checkpointId: "assistant-1",
      cwd: path.resolve("/synthetic"),
      sourceSessionId: "source-session",
    });
    await expect(opened.value.readSnapshot()).resolves.toMatchObject({
      ok: true,
      value: { turns: [{ nativeTurnRef: { nativeSessionId: "derived-session" } }] },
    });
    await opened.value.close();
    await adapter.close();
  });

  it("rejects an empty last-Turn rollback without creating a Transport", async () => {
    const { adapter, dependencies, transports } = fixture();
    const sourceRef = nativeSessionRefSchema.parse({
      harnessId: "claude-code",
      nativeSessionId: "source-session",
      formatVersion: 1,
    });

    await expect(
      adapter.open({ kind: "rollbackLastTurn", sourceRef, cwd: "/synthetic" }),
    ).resolves.toMatchObject({ ok: false, error: { code: "sessionNotFound" } });
    expect(dependencies.createTransport).not.toHaveBeenCalled();
    expect(transports).toHaveLength(0);
    await adapter.close();
  });

  it("restores a Subagent prompt from Parent history when native Child history omits it", async () => {
    const { adapter, dependencies, history } = fixture();
    history.push(
      {
        type: "assistant",
        uuid: "root-agent",
        session_id: "source-session",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "agent-call",
              name: "Agent",
              input: { prompt: "inspect files", description: "Inspect files" },
            },
          ],
        },
      },
      {
        type: "user",
        uuid: "root-agent-result",
        session_id: "source-session",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "agent-call",
              content: "done\nagentId: native-agent-1 (use SendMessage to continue)",
            },
          ],
        },
      },
    );
    vi.mocked(dependencies.readSubagentMessages).mockResolvedValueOnce([
      {
        type: "assistant",
        uuid: "subagent-answer",
        session_id: "source-session",
        message: { role: "assistant", content: [{ type: "text", text: "Inspection done" }] },
      },
    ]);

    await expect(
      adapter.subagents.readSnapshot({
        parent: nativeSessionRefSchema.parse({
          harnessId: "claude-code",
          nativeSessionId: "source-session",
          formatVersion: 1,
        }),
        nativeSubagentId: "native-agent-1",
        cwd: "/synthetic",
      }),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        turns: [
          {
            input: [{ type: "text", text: "inspect files" }],
            items: [{ item: { type: "agentMessage", text: "Inspection done" } }],
          },
        ],
      },
    });
    expect(dependencies.readSessionMessages).toHaveBeenCalledWith({
      cwd: "/synthetic",
      sessionId: "source-session",
    });
  });

  it("reads and resumes Native history without starting a Transport until the next Turn", async () => {
    const { adapter, dependencies, history, transports } = fixture();
    const sourceRef = nativeSessionRefSchema.parse({
      harnessId: "claude-code",
      nativeSessionId: "source-session",
      formatVersion: 1,
    });
    history.push(
      {
        type: "user",
        uuid: "source-user",
        session_id: "source-session",
        message: { role: "user", content: "source prompt" },
      },
      {
        type: "assistant",
        uuid: "source-assistant",
        session_id: "source-session",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "source response" }],
          stop_reason: "end_turn",
        },
      },
    );

    const opened = await adapter.open({ kind: "resume", cwd: "/synthetic", nativeRef: sourceRef });
    if (!opened.ok) throw new Error(opened.error.message);
    expect(opened.value.initialState).toEqual({ nativeRef: sourceRef });
    await expect(opened.value.readSnapshot()).resolves.toMatchObject({
      ok: true,
      value: {
        turns: [
          {
            nativeTurnRef: { nativeTurnKey: "source-user" },
            input: [{ type: "text", text: "source prompt" }],
            items: [{ item: { type: "agentMessage", text: "source response" } }],
          },
        ],
      },
    });
    expect(dependencies.createTransport).not.toHaveBeenCalled();

    const iterator = opened.value.outputs[Symbol.asyncIterator]();
    await expect(opened.value.execute(textTurn("continued"))).resolves.toMatchObject({ ok: true });
    expect(dependencies.createTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: path.resolve("/synthetic"),
        sessionId: "source-session",
        openMode: "resume",
      }),
    );
    expect(await nextEvent(iterator)).toMatchObject({
      type: "session.state.changed",
      state: { nativeRef: sourceRef },
    });
    expect((await nextEvent(iterator)).type).toBe("turn.started");
    expect((await nextEvent(iterator)).type).toBe("item.started");
    transports[0]?.finish({ status: "succeeded" });
    await nextEvent(iterator);
    await nextEvent(iterator);
    await opened.value.close();
  });

  it("defers resumed Query startup until the next Turn and applies the final configuration", async () => {
    const { adapter, dependencies, transports } = fixture();
    const sourceRef = nativeSessionRefSchema.parse({
      harnessId: "claude-code",
      nativeSessionId: "resume-for-selection",
      formatVersion: 1,
    });
    const opened = await adapter.open({ kind: "resume", cwd: "/synthetic", nativeRef: sourceRef });
    if (!opened.ok) throw new Error(opened.error.message);
    const session = opened.value;
    const iterator = session.outputs[Symbol.asyncIterator]();
    const alias = encodeClaudeModelRef("sonnet");

    await expect(session.execute({ type: "model.select", model: alias })).resolves.toEqual({
      ok: true,
      value: { completed: true },
    });
    await expect(nextEvent(iterator)).resolves.toMatchObject({
      type: "session.state.changed",
      state: { nativeRef: sourceRef, effectiveModel: alias },
    });
    await expect(
      session.execute({
        type: "thinking.select",
        thinkingOptionId: harnessThinkingOptionIdSchema.parse("high"),
      }),
    ).resolves.toEqual({ ok: true, value: { completed: true } });
    await nextEvent(iterator);
    await expect(
      session.execute({
        type: "permissionMode.select",
        permissionModeId: harnessPermissionModeIdSchema.parse("auto"),
      }),
    ).resolves.toEqual({ ok: true, value: { completed: true } });
    await nextEvent(iterator);
    expect(dependencies.createTransport).not.toHaveBeenCalled();

    await expect(session.execute(textTurn("configured-turn"))).resolves.toMatchObject({ ok: true });
    expect(dependencies.createTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "sonnet",
        openMode: "resume",
        sessionId: "resume-for-selection",
        thinkingOptionId: "high",
        permissionMode: "auto",
      }),
    );
    expect(transports[0]?.setModel).not.toHaveBeenCalled();
    expect(transports[0]?.setThinkingOption).not.toHaveBeenCalled();
    expect(transports[0]?.setPermissionMode).not.toHaveBeenCalled();
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    transports[0]?.finish({ status: "succeeded" });
    await nextEvent(iterator);
    await nextEvent(iterator);
    await session.close();
  });

  it("forks an exact Native prefix while later source history continues", async () => {
    const { adapter, dependencies } = fixture();
    const sourceRef = nativeSessionRefSchema.parse({
      harnessId: "claude-code",
      nativeSessionId: "source-session",
      formatVersion: 1,
    });
    const checkpoint = nativeCheckpointRefSchema.parse({
      harnessId: "claude-code",
      nativeSessionId: "source-session",
      checkpointId: "source-assistant-1",
      formatVersion: 1,
    });
    const histories = new Map<string, unknown[]>([
      [
        "source-session",
        [
          {
            type: "user",
            uuid: "source-user-1",
            session_id: "source-session",
            message: { role: "user", content: "first prompt" },
          },
          {
            type: "assistant",
            uuid: "source-assistant-1",
            session_id: "source-session",
            message: { role: "assistant", content: [{ type: "text", text: "first response" }] },
          },
          {
            type: "user",
            uuid: "source-user-2",
            session_id: "source-session",
            message: { role: "user", content: "second prompt" },
          },
          {
            type: "assistant",
            uuid: "source-assistant-2",
            session_id: "source-session",
            message: { role: "assistant", content: [{ type: "text", text: "second response" }] },
          },
        ],
      ],
    ]);
    vi.mocked(dependencies.readSessionMessages).mockImplementation(async ({ sessionId }) =>
      structuredClone(histories.get(sessionId) ?? []),
    );
    vi.mocked(dependencies.forkSession).mockImplementationOnce(async () => {
      histories.get("source-session")?.push(
        {
          type: "user",
          uuid: "source-user-3",
          session_id: "source-session",
          message: { role: "user", content: "active prompt" },
        },
        {
          type: "assistant",
          uuid: "source-assistant-3",
          session_id: "source-session",
          message: { role: "assistant", content: [{ type: "text", text: "active response" }] },
        },
      );
      histories.set("derived-session", [
        {
          type: "user",
          uuid: "derived-user-1",
          session_id: "derived-session",
          message: { role: "user", content: "first prompt" },
        },
        {
          type: "assistant",
          uuid: "derived-assistant-1",
          session_id: "derived-session",
          message: { role: "assistant", content: [{ type: "text", text: "first response" }] },
        },
      ]);
      return { sessionId: "derived-session" };
    });

    const opened = await adapter.open({ kind: "fork", cwd: "/synthetic", sourceRef, checkpoint });
    if (!opened.ok) throw new Error(opened.error.message);
    expect(opened.value.initialState).toMatchObject({
      nativeRef: { nativeSessionId: "derived-session" },
    });
    await expect(opened.value.readSnapshot()).resolves.toMatchObject({
      ok: true,
      value: {
        turns: [
          {
            nativeTurnRef: { nativeTurnKey: "derived-user-1" },
            checkpoint: { checkpointId: "derived-assistant-1" },
            input: [{ text: "first prompt" }],
          },
        ],
      },
    });
    expect(dependencies.forkSession).toHaveBeenCalledWith({
      checkpointId: "source-assistant-1",
      cwd: path.resolve("/synthetic"),
      sourceSessionId: "source-session",
    });
    expect(dependencies.deleteSession).not.toHaveBeenCalled();
    expect(dependencies.createTransport).not.toHaveBeenCalled();
    await opened.value.close();
  });

  it("rejects missing resumed history and stale Fork Checkpoints without a Native Fork", async () => {
    const { adapter, dependencies, history } = fixture();
    const sourceRef = nativeSessionRefSchema.parse({
      harnessId: "claude-code",
      nativeSessionId: "source-session",
      formatVersion: 1,
    });
    const checkpoint = nativeCheckpointRefSchema.parse({
      harnessId: "claude-code",
      nativeSessionId: "source-session",
      checkpointId: "stale-checkpoint",
      formatVersion: 1,
    });

    const resumed = await adapter.open({ kind: "resume", cwd: "/synthetic", nativeRef: sourceRef });
    if (!resumed.ok) throw new Error(resumed.error.message);
    await expect(resumed.value.readSnapshot()).resolves.toMatchObject({
      ok: false,
      error: { code: "sessionNotFound" },
    });
    const foreignCheckpoint = nativeCheckpointRefSchema.parse({
      harnessId: "claude-code",
      nativeSessionId: "other-session",
      checkpointId: "foreign-checkpoint",
      formatVersion: 1,
    });
    await expect(
      adapter.open({
        kind: "fork",
        cwd: "/synthetic",
        sourceRef,
        checkpoint: foreignCheckpoint,
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "invalidRequest" } });
    vi.mocked(dependencies.getSessionInfo).mockResolvedValueOnce({ cwd: "/other-workspace" });
    await expect(
      adapter.open({ kind: "fork", cwd: "/synthetic", sourceRef, checkpoint }),
    ).resolves.toMatchObject({ ok: false, error: { code: "unsupported" } });
    history.push(
      {
        type: "user",
        uuid: "source-user",
        session_id: "source-session",
        message: { role: "user", content: "source prompt" },
      },
      {
        type: "assistant",
        uuid: "source-assistant",
        session_id: "source-session",
        message: { role: "assistant", content: [{ type: "text", text: "source response" }] },
      },
    );
    await expect(
      adapter.open({ kind: "fork", cwd: "/synthetic", sourceRef, checkpoint }),
    ).resolves.toMatchObject({ ok: false, error: { code: "checkpointNotFound" } });
    expect(dependencies.forkSession).not.toHaveBeenCalled();
    expect(dependencies.createTransport).not.toHaveBeenCalled();
    await resumed.value.close();
  });

  it("deletes a Native Fork whose remapped history is not the requested prefix", async () => {
    const { adapter, dependencies } = fixture();
    const sourceRef = nativeSessionRefSchema.parse({
      harnessId: "claude-code",
      nativeSessionId: "source-session",
      formatVersion: 1,
    });
    const checkpoint = nativeCheckpointRefSchema.parse({
      harnessId: "claude-code",
      nativeSessionId: "source-session",
      checkpointId: "source-assistant",
      formatVersion: 1,
    });
    const sourceHistory = [
      {
        type: "user",
        uuid: "source-user",
        session_id: "source-session",
        message: { role: "user", content: "source prompt" },
      },
      {
        type: "assistant",
        uuid: "source-assistant",
        session_id: "source-session",
        message: { role: "assistant", content: [{ type: "text", text: "source response" }] },
      },
    ];
    const derivedHistory = [
      {
        type: "user",
        uuid: "derived-user",
        session_id: "derived-session",
        message: { role: "user", content: "wrong prompt" },
      },
      {
        type: "assistant",
        uuid: "derived-assistant",
        session_id: "derived-session",
        message: { role: "assistant", content: [{ type: "text", text: "wrong response" }] },
      },
    ];
    vi.mocked(dependencies.readSessionMessages).mockImplementation(async ({ sessionId }) =>
      structuredClone(sessionId === "derived-session" ? derivedHistory : sourceHistory),
    );

    await expect(
      adapter.open({ kind: "fork", cwd: "/synthetic", sourceRef, checkpoint }),
    ).resolves.toMatchObject({ ok: false, error: { code: "protocolError" } });
    expect(dependencies.deleteSession).toHaveBeenCalledWith({
      cwd: path.resolve("/synthetic"),
      sessionId: "derived-session",
    });
    expect(dependencies.createTransport).not.toHaveBeenCalled();
  });
});
