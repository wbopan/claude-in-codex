import { describe, expect, it, vi } from "vitest";
import { hostTurnIdSchema } from "@claude-in-codex/shared-contracts";

import type { HostEvent } from "@claude-in-codex/harness-adapter";
import { CLAUDE_DEFAULT_MODEL_REF } from "../../src/model-catalog.js";
import { fixture, nextEvent, openSession, textTurn } from "./fixture.js";

describe("Claude Code HarnessAdapter", () => {
  it("starts lazily and emits a complete text lifecycle", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();

    await expect(session.execute(textTurn("turn-1"))).resolves.toEqual({
      ok: true,
      value: { turnId: "turn-1" },
    });
    expect(transports[0]?.start).toHaveBeenCalledOnce();
    expect(await nextEvent(iterator)).toMatchObject({
      type: "session.state.changed",
      state: { effectiveModel: CLAUDE_DEFAULT_MODEL_REF },
    });
    expect((await nextEvent(iterator)).type).toBe("turn.started");
    expect((await nextEvent(iterator)).type).toBe("item.started");
    transports[0]?.delta("hello");
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.updated",
      update: { type: "text.append", text: "hello" },
    });
    transports[0]?.event({
      type: "message.completed",
      messageId: "synthetic-assistant",
      checkpointId: "native-assistant",
    });
    transports[0]?.finish({ status: "succeeded" });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: { item: { text: "hello" }, outcome: { status: "succeeded" } },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "turn.completed",
      nativeTurnRef: {
        harnessId: "claude-code",
        nativeSessionId: transports[0]?.sessionId,
        nativeTurnKey: transports[0]?.turns[0]?.userMessageId,
        formatVersion: 1,
      },
      outcome: {
        status: "succeeded",
        checkpoint: {
          harnessId: "claude-code",
          nativeSessionId: transports[0]?.sessionId,
          checkpointId: "native-assistant",
          formatVersion: 1,
        },
      },
    });
    await session.close();
  });

  it("mirrors Claude memory into Codex after each completed Turn and on close", async () => {
    const { adapter, dependencies, transports } = fixture();
    const exportMemory = vi.fn(async () => undefined);
    dependencies.exportMemory = exportMemory;
    const environment = { CODEX_HOME: "/synthetic-codex" };
    const session = await openSession(adapter, environment);
    const iterator = session.outputs[Symbol.asyncIterator]();

    await session.execute(textTurn("turn-1"));
    transports[0]?.finish({ status: "succeeded" });
    while ((await nextEvent(iterator)).type !== "turn.completed");
    await vi.waitFor(() => expect(exportMemory).toHaveBeenCalledOnce());
    expect(exportMemory).toHaveBeenCalledWith({ cwd: "/synthetic", environment });

    await session.close();
    expect(exportMemory).toHaveBeenCalledTimes(2);
  });

  it("keeps a failing memory export away from the Turn and the close", async () => {
    const { adapter, dependencies, transports } = fixture();
    dependencies.exportMemory = vi.fn(async () => {
      throw new Error("disk full");
    });
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();

    await session.execute(textTurn("turn-1"));
    transports[0]?.finish({ status: "succeeded" });
    let event: HostEvent;
    do event = await nextEvent(iterator);
    while (event.type !== "turn.completed");
    expect(event).toMatchObject({ outcome: { status: "succeeded" } });
    await expect(session.close()).resolves.toBeUndefined();
  });

  it("exposes Claude compact as a command whose native events drive the standard UI lifecycle", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();
    const commands = session.commands;
    if (!commands) throw new Error("Claude Code Session did not expose commands");

    await expect(commands.list()).resolves.toMatchObject({
      ok: true,
      value: {
        commands: [
          { id: "claude.compact", invocation: "/compact" },
          { id: "claude.init", invocation: "/init", argumentMode: "none" },
          { id: "claude.recap", invocation: "/recap", argumentMode: "none" },
        ],
      },
    });
    await expect(
      commands.execute({
        turnId: hostTurnIdSchema.parse("manual-compact"),
        commandId: "claude.compact",
        arguments: { text: "Keep implementation details" },
      }),
    ).resolves.toEqual({ ok: true, value: { turnId: "manual-compact" } });

    expect((await nextEvent(iterator)).type).toBe("session.state.changed");
    expect(await nextEvent(iterator)).toEqual({
      type: "turn.started",
      turnId: "manual-compact",
    });
    const transport = transports[0];
    if (!transport) throw new Error("Fake Claude transport was not created");
    transport.contextUsage = { usedTokens: 30, maxTokens: 200, model: "runtime-default" };
    transport.event({ type: "compaction.started" });
    const started = await nextEvent(iterator);
    if (started.type !== "item.started" || started.item.type !== "contextCompaction") {
      throw new Error("Manual compaction did not start a Context Compaction Item");
    }
    expect(started).toMatchObject({
      type: "item.started",
      turnId: "manual-compact",
      item: { type: "contextCompaction" },
    });
    transport.event({ type: "compaction.completed", outcome: "succeeded" });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      turnId: "manual-compact",
      snapshot: {
        item: { type: "contextCompaction", itemId: started.item.itemId },
        outcome: { status: "succeeded" },
      },
    });
    transport.finish({ status: "succeeded" });
    expect(await nextEvent(iterator)).toEqual({
      type: "turn.completed",
      turnId: "manual-compact",
      outcome: { status: "succeeded" },
    });
    expect(transport.compactCalls).toEqual([
      {
        userMessageId: expect.any(String),
        customInstructions: "Keep implementation details",
      },
    ]);
    expect(transport.turns).toEqual([]);
    await session.close();
  });

  it("validates Claude compact arguments and rejects it while busy", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const commands = session.commands;
    if (!commands) throw new Error("Claude Code Session did not expose commands");

    await expect(
      commands.execute({
        turnId: hostTurnIdSchema.parse("invalid-compact"),
        commandId: "claude.compact",
        arguments: { text: 1 },
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "invalidRequest" } });
    await expect(
      commands.execute({
        turnId: hostTurnIdSchema.parse("unknown-argument"),
        commandId: "claude.compact",
        arguments: { text: "ok", extra: true },
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "invalidRequest" } });
    await expect(
      commands.execute({
        turnId: hostTurnIdSchema.parse("init-with-args"),
        commandId: "claude.init",
        arguments: { text: "nope" },
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "invalidRequest" } });
    await expect(
      commands.execute({
        turnId: hostTurnIdSchema.parse("unknown-command"),
        commandId: "claude.unknown",
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "unsupported" } });

    const iterator = session.outputs[Symbol.asyncIterator]();
    await session.execute(textTurn("busy"));
    expect((await nextEvent(iterator)).type).toBe("session.state.changed");
    expect((await nextEvent(iterator)).type).toBe("turn.started");
    await expect(
      commands.execute({
        turnId: hostTurnIdSchema.parse("rejected-compact"),
        commandId: "claude.compact",
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "sessionBusy" } });
    transports[0]?.finish({ status: "succeeded" });
    for (;;) {
      if ((await nextEvent(iterator)).type === "turn.completed") break;
    }
    await session.close();
  });

  it("cancels a running Claude compact temporary Turn", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();
    const commands = session.commands;
    if (!commands) throw new Error("Claude Code Session did not expose commands");
    const turnId = hostTurnIdSchema.parse("cancel-compact");

    await commands.execute({ turnId, commandId: "claude.compact" });
    expect((await nextEvent(iterator)).type).toBe("session.state.changed");
    expect(await nextEvent(iterator)).toEqual({ type: "turn.started", turnId });
    const transport = transports[0];
    if (!transport) throw new Error("Fake Claude transport was not created");
    transport.event({ type: "compaction.started" });
    await nextEvent(iterator);

    await expect(session.execute({ type: "turn.cancel", turnId })).resolves.toEqual({
      ok: true,
      value: { cancellationRequested: true },
    });
    transport.finish({ status: "cancelled", reason: "aborted_streaming" });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: {
        item: { type: "contextCompaction" },
        outcome: { status: "cancelled" },
      },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "turn.completed",
      turnId,
      outcome: { status: "cancelled" },
    });
    expect(transport.abort).toHaveBeenCalledOnce();
    await session.close();
  });

  it("runs Claude init as a command Turn that writes through native tools", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();
    const commands = session.commands;
    if (!commands) throw new Error("Claude Code Session did not expose commands");
    const turnId = hostTurnIdSchema.parse("manual-init");

    await expect(commands.execute({ turnId, commandId: "claude.init" })).resolves.toEqual({
      ok: true,
      value: { turnId },
    });
    expect((await nextEvent(iterator)).type).toBe("session.state.changed");
    expect(await nextEvent(iterator)).toEqual({ type: "turn.started", turnId });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.started",
      turnId,
      item: { type: "agentMessage", text: "" },
    });
    const transport = transports[0];
    if (!transport) throw new Error("Fake Claude transport was not created");
    transport.delta("Created CLAUDE.md", "init-assistant");
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.updated",
      update: { type: "text.append", text: "Created CLAUDE.md" },
    });
    transport.finish({ status: "succeeded" });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: { item: { type: "agentMessage", text: "Created CLAUDE.md" } },
    });
    expect(await nextEvent(iterator)).toEqual({
      type: "turn.completed",
      turnId,
      outcome: { status: "succeeded" },
    });
    expect(transport.initCalls).toEqual([expect.any(String)]);
    expect(transport.turns).toEqual([]);
    expect(transport.compactCalls).toEqual([]);
    await session.close();
  });

  it("projects Claude recap local output as a one-line Agent Message", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();
    const commands = session.commands;
    if (!commands) throw new Error("Claude Code Session did not expose commands");
    const turnId = hostTurnIdSchema.parse("manual-recap");

    await expect(commands.execute({ turnId, commandId: "claude.recap" })).resolves.toEqual({
      ok: true,
      value: { turnId },
    });
    expect((await nextEvent(iterator)).type).toBe("session.state.changed");
    expect(await nextEvent(iterator)).toEqual({ type: "turn.started", turnId });
    expect((await nextEvent(iterator)).type).toBe("item.started");
    const transport = transports[0];
    if (!transport) throw new Error("Fake Claude transport was not created");
    transport.delta("Built compact command and subagent projection.", "recap-assistant");
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.updated",
      update: { type: "text.append", text: "Built compact command and subagent projection." },
    });
    transport.finish({ status: "succeeded" });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: {
        item: {
          type: "agentMessage",
          text: "Built compact command and subagent projection.",
        },
      },
    });
    expect(await nextEvent(iterator)).toEqual({
      type: "turn.completed",
      turnId,
      outcome: { status: "succeeded" },
    });
    expect(transport.recapCalls).toEqual([expect.any(String)]);
    expect(transport.turns).toEqual([]);
    await session.close();
  });

  it("uses one Item identity for a live response and its native history snapshot", async () => {
    const { adapter, history, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();

    await session.execute(textTurn("stable-live-history-item"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    const liveStarted = await nextEvent(iterator);
    if (liveStarted.type !== "item.started" || liveStarted.item.type !== "agentMessage") {
      throw new Error("Claude live Agent Message did not start");
    }
    const transport = transports[0];
    const nativeTurnKey = transport?.turns[0]?.userMessageId;
    if (!transport || !nativeTurnKey) throw new Error("Fake Claude Turn did not start");

    transport.reasoning("native-message", "one thought");
    const liveReasoningStarted = await nextEvent(iterator);
    if (
      liveReasoningStarted.type !== "item.started" ||
      liveReasoningStarted.item.type !== "reasoning"
    ) {
      throw new Error("Claude live Reasoning did not start");
    }
    await nextEvent(iterator);
    transport.completeReasoning("native-message");
    await nextEvent(iterator);
    transport.delta("one response", "native-message");
    await nextEvent(iterator);
    transport.event({
      type: "message.completed",
      messageId: "native-message",
      checkpointId: "native-assistant",
    });
    transport.finish({ status: "succeeded" });
    await nextEvent(iterator);
    await nextEvent(iterator);

    history.push(
      {
        type: "user",
        uuid: nativeTurnKey,
        session_id: transport.sessionId,
        message: { role: "user", content: "stable-live-history-item" },
      },
      {
        type: "assistant",
        uuid: "native-thinking",
        session_id: transport.sessionId,
        message: {
          id: "native-message",
          role: "assistant",
          content: [{ type: "thinking", thinking: "one thought" }],
          stop_reason: "end_turn",
        },
      },
      {
        type: "assistant",
        uuid: "native-assistant",
        session_id: transport.sessionId,
        message: {
          id: "native-message",
          role: "assistant",
          content: [{ type: "text", text: "one response" }],
          stop_reason: "end_turn",
        },
      },
    );

    const snapshot = await session.readSnapshot();
    if (!snapshot.ok) throw new Error(snapshot.error.message);
    expect(snapshot.value.turns[0]?.items.map(({ item }) => item.itemId)).toEqual([
      liveReasoningStarted.item.itemId,
      liveStarted.item.itemId,
    ]);
    await session.close();
  });

  it.each([false, true])("waits for transcript persistence (timeout: %s)", async (timeout) => {
    const { adapter, transports, history, dependencies } = fixture();
    const session = await openSession(adapter);
    try {
      await session.execute(textTurn("delayed-history"));
      const transport = transports[0];
      if (!transport) throw new Error("Fake Claude transport was not created");
      transport.event({ type: "message.completed", messageId: "answer", checkpointId: "answer" });
      transport.finish({ status: "succeeded" });
      await Promise.resolve();
      const sent = transport.turns[0];
      if (!sent) throw new Error("Fake Claude Turn was not submitted");
      const persisted = [
        {
          type: "user",
          uuid: sent.userMessageId,
          session_id: transport.sessionId,
          message: { role: "user", content: "delayed-history" },
        },
        {
          type: "assistant",
          uuid: "answer",
          session_id: transport.sessionId,
          message: { role: "assistant", content: "done" },
        },
      ];
      vi.mocked(dependencies.readSessionMessages).mockClear();
      if (!timeout)
        vi.mocked(dependencies.readSessionMessages)
          .mockResolvedValueOnce([])
          .mockResolvedValue(persisted);
      const result = await session.readSnapshot();
      if (timeout) {
        expect(result).toMatchObject({
          ok: false,
          error: { code: "sessionBusy", retryable: true },
        });
        history.push(...persisted);
        await expect(session.readSnapshot()).resolves.toMatchObject({
          ok: true,
          value: { turns: [{ input: [{ text: "delayed-history" }] }] },
        });
      } else {
        expect(result).toMatchObject({
          ok: true,
          value: { turns: [{ input: [{ text: "delayed-history" }] }] },
        });
        expect(dependencies.readSessionMessages).toHaveBeenCalledTimes(2);
      }
    } finally {
      await adapter.close();
    }
  });

  it("reuses one Transport and Native Session for sequential Turns", async () => {
    const { adapter, dependencies, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();

    await session.execute(textTurn("turn-1"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    transports[0]?.finish({ status: "succeeded" });
    await nextEvent(iterator);
    await nextEvent(iterator);

    await session.execute(textTurn("turn-2"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    transports[0]?.finish({ status: "succeeded" });
    await nextEvent(iterator);
    await nextEvent(iterator);

    expect(dependencies.createTransport).toHaveBeenCalledOnce();
    expect(transports[0]?.start).toHaveBeenCalledOnce();
    expect(transports[0]?.turns.map(({ text }) => text)).toEqual(["turn-1", "turn-2"]);
    expect(new Set(transports[0]?.turns.map(({ userMessageId }) => userMessageId)).size).toBe(2);
    await session.close();
  });

  it("rejects a concurrent Turn without disturbing the active Turn", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);

    await session.execute(textTurn("turn-1"));
    await expect(session.execute(textTurn("turn-2"))).resolves.toMatchObject({
      ok: false,
      error: { code: "sessionBusy" },
    });
    transports[0]?.finish({ status: "succeeded" });
    await session.close();
  });
});
