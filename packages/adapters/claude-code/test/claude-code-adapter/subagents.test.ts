import { describe, expect, it } from "vitest";
import { hostTurnIdSchema, nativeSessionRefSchema } from "@claude-in-codex/shared-contracts";

import { fixture, nextEvent, openSession, textTurn } from "./fixture.js";

describe("Claude Code HarnessAdapter", () => {
  it("projects Claude Agent delegation as one common Subagent Item", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();

    await session.execute(textTurn("delegate"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    const transport = transports[0];
    if (!transport) throw new Error("Fake Claude transport was not created");

    transport.delta("delegating", "assistant-before-agent");
    await nextEvent(iterator);
    transport.event({
      type: "subagent.started",
      operation: "spawn",
      callId: "agent-1",
      description: "Inspect implementation",
      role: "Explore",
      background: true,
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: { item: { type: "agentMessage", text: "delegating" } },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.started",
      item: {
        type: "subagentDelegation",
        operation: "spawn",
        subagents: [
          {
            subagentId: "agent-1",
            description: "Inspect implementation",
            role: "Explore",
            background: true,
            status: "running",
          },
        ],
      },
    });
    transport.event({ type: "subagent.transcript.changed", callId: "agent-1" });
    transport.event({
      type: "subagent.updated",
      callId: "agent-1",
      status: "running",
      nativeSubagentId: "native-agent-1",
      resultSummary: "Reading files",
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.updated",
      update: {
        type: "subagents.replace",
        subagents: [
          {
            status: "running",
            nativeSubagentId: "native-agent-1",
            resultSummary: "Reading files",
          },
        ],
      },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "subagent.transcript.changed",
      nativeSubagentId: "native-agent-1",
    });
    transport.event({ type: "subagent.transcript.changed", callId: "agent-1" });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "subagent.transcript.changed",
      nativeSubagentId: "native-agent-1",
    });
    transport.event({
      type: "subagent.completed",
      callId: "agent-1",
      isError: false,
      resultSummary: "Agent launched successfully",
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.updated",
      update: {
        type: "subagents.replace",
        subagents: [{ status: "completed", resultSummary: "Agent launched successfully" }],
      },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: {
        item: { type: "subagentDelegation", subagents: [{ status: "completed" }] },
        outcome: { status: "succeeded" },
      },
    });

    transport.finish({ status: "succeeded" });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "turn.completed",
      outcome: { status: "succeeded" },
    });
    await session.close();
  });

  it("keeps an async Agent spawn running after its launch Tool Result", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();

    await session.execute(textTurn("delegate in background"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    const transport = transports[0];
    if (!transport) throw new Error("Fake Claude transport was not created");
    transport.event({
      type: "subagent.started",
      operation: "spawn",
      callId: "agent-1",
      description: "Inspect implementation",
      background: true,
    });
    await nextEvent(iterator);
    transport.event({
      type: "subagent.completed",
      callId: "agent-1",
      isError: false,
      continuesInBackground: true,
      nativeSubagentId: "native-agent-1",
      resultSummary: "Async agent launched successfully",
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.updated",
      update: {
        type: "subagents.replace",
        subagents: [
          {
            status: "running",
            nativeSubagentId: "native-agent-1",
            resultSummary: "Async agent launched successfully",
          },
        ],
      },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: {
        item: { type: "subagentDelegation", subagents: [{ status: "running" }] },
        outcome: { status: "succeeded" },
      },
    });
    transport.finish({ status: "succeeded" });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: { item: { type: "agentMessage" } },
    });
    await expect(session.execute(textTurn("follow-up"))).resolves.toMatchObject({
      ok: false,
      error: { code: "sessionBusy" },
    });
    transport.autonomous({
      nativeTurnKey: "task-notification-1",
      events: [
        {
          type: "subagent.settled",
          nativeSubagentId: "native-agent-1",
          status: "completed",
          resultSummary: "Inspection complete",
        },
        {
          type: "text.delta",
          messageId: "continuation-assistant",
          delta: "Inspection complete",
        },
        {
          type: "message.completed",
          messageId: "continuation-assistant",
          checkpointId: "continuation-checkpoint",
        },
      ],
      result: { status: "succeeded" },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "subagent.state.changed",
      nativeSubagentId: "native-agent-1",
      status: "completed",
      resultSummary: "Inspection complete",
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.started",
      item: { type: "agentMessage", text: "" },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.updated",
      update: { type: "text.append", text: "Inspection complete" },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: { item: { type: "agentMessage", text: "Inspection complete" } },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "turn.completed",
      outcome: { status: "succeeded" },
      nativeTurnRef: { nativeTurnKey: transport.turns[0]?.userMessageId },
    });
    await session.close();
  });

  it("publishes background Subagent transcript changes once the delegation has returned", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();

    await session.execute(textTurn("delegate in background"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    const transport = transports[0];
    if (!transport) throw new Error("Fake Claude transport was not created");
    transport.event({
      type: "subagent.started",
      operation: "spawn",
      callId: "agent-1",
      description: "Inspect implementation",
      background: true,
    });
    await nextEvent(iterator);
    transport.event({
      type: "subagent.completed",
      callId: "agent-1",
      isError: false,
      continuesInBackground: true,
      nativeSubagentId: "native-agent-1",
      resultSummary: "Async agent launched successfully",
    });
    await nextEvent(iterator);
    await nextEvent(iterator);
    transport.finish({ status: "succeeded" });
    await nextEvent(iterator);
    expect(transport.idleLive).toBe(true);

    // Held Root Turn: the delegation left the Turn when the Agent call returned.
    transport.idleHandler?.onEvent({ type: "subagent.transcript.changed", callId: "agent-1" });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "subagent.transcript.changed",
      nativeSubagentId: "native-agent-1",
    });

    // Cancelled Root Turn: no Turn is open, the Session occupancy still knows the Subagent.
    await session.execute({
      type: "turn.cancel",
      turnId: hostTurnIdSchema.parse("delegate in background"),
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "turn.completed",
      outcome: { status: "cancelled" },
    });
    transport.threadHandler?.({ type: "subagent.transcript.changed", callId: "agent-1" });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "subagent.transcript.changed",
      nativeSubagentId: "native-agent-1",
    });
    transport.idleHandler?.onEvent({ type: "subagent.transcript.changed", callId: "agent-1" });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "subagent.transcript.changed",
      nativeSubagentId: "native-agent-1",
    });
  });

  it.each(["held", "streaming", "continuation", "launch-race"] as const)(
    "preserves background Subagents across %s cancellation and the replacement Turn",
    async (phase) => {
      const { adapter, transports, dependencies } = fixture();
      const session = await openSession(adapter);
      const iterator = session.outputs[Symbol.asyncIterator]();

      await session.execute(textTurn("delegate in background"));
      await nextEvent(iterator);
      await nextEvent(iterator);
      await nextEvent(iterator);
      const transport = transports[0];
      if (!transport) throw new Error("Fake Claude transport was not created");
      transport.event({
        type: "subagent.started",
        operation: "spawn",
        callId: "agent-1",
        description: "Inspect implementation",
        background: true,
      });
      await nextEvent(iterator);
      if (phase === "launch-race") {
        await session.execute({
          type: "turn.cancel",
          turnId: textTurn("delegate in background").turnId,
        });
      }
      transport.event({
        type: "subagent.completed",
        callId: "agent-1",
        isError: false,
        continuesInBackground: true,
        nativeSubagentId: "native-agent-1",
        resultSummary: "Async agent launched successfully",
      });
      await nextEvent(iterator);
      await nextEvent(iterator);
      if (phase === "held" || phase === "continuation") {
        transport.finish({ status: "succeeded" });
        await nextEvent(iterator);
      }
      if (phase === "continuation") transport.event({ type: "segment.started" });

      await expect(
        session.execute({
          type: "turn.cancel",
          turnId: hostTurnIdSchema.parse("delegate in background"),
        }),
      ).resolves.toEqual({ ok: true, value: { cancellationRequested: true } });
      if (phase !== "held") {
        transport.finish({ status: "cancelled", reason: "aborted_streaming" });
        if (phase !== "continuation")
          expect(await nextEvent(iterator)).toMatchObject({ type: "item.completed" });
      }
      expect(await nextEvent(iterator)).toMatchObject({
        type: "turn.completed",
        outcome: { status: "cancelled" },
      });
      expect(transport.abort).toHaveBeenCalledTimes(phase === "held" ? 0 : 1);
      expect(transport.close).not.toHaveBeenCalled();

      const parent = nativeSessionRefSchema.parse({
        harnessId: "claude-code",
        nativeSessionId: transport.sessionId,
        formatVersion: 1,
      });
      await expect(
        adapter.open({ kind: "rollbackLastTurn", sourceRef: parent, cwd: "/synthetic" }),
      ).resolves.toMatchObject({
        ok: false,
        error: { code: "sessionBusy" },
      });
      expect(dependencies.forkSession).not.toHaveBeenCalled();

      await expect(
        adapter.subagents.stop({ parent, cwd: "/synthetic", nativeSubagentId: "native-agent-1" }),
      ).resolves.toMatchObject({ ok: true });
      expect(transport.stopTask).toHaveBeenCalledExactlyOnceWith("native-agent-1");
      expect(transport.close).not.toHaveBeenCalled();

      await expect(session.execute(textTurn("replacement"))).resolves.toMatchObject({ ok: true });
      await nextEvent(iterator);
      await nextEvent(iterator);
      transport.finish({ status: "succeeded" });
      await nextEvent(iterator);
      expect(transport.idleLive).toBe(true);
      transport.event({
        type: "subagent.settled",
        nativeSubagentId: "native-agent-1",
        status: "completed",
      });
      expect(await nextEvent(iterator)).toMatchObject({
        type: "subagent.state.changed",
        status: "completed",
      });
      expect(await nextEvent(iterator)).toMatchObject({
        type: "turn.completed",
        turnId: "replacement",
        outcome: { status: "succeeded" },
      });
      expect(transports).toHaveLength(1);
      await session.close();
    },
  );

  it("keeps an existing Agent running when SendMessage returns", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();

    await session.execute(textTurn("send"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    const transport = transports[0];
    if (!transport) throw new Error("Fake Claude transport was not created");
    transport.event({
      type: "subagent.started",
      operation: "send",
      callId: "send-1",
      nativeSubagentId: "native-agent-1",
      description: "Analyze directory",
      background: true,
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.started",
      item: { type: "subagentDelegation", operation: "send" },
    });
    transport.event({
      type: "subagent.completed",
      callId: "send-1",
      isError: false,
      resultSummary: "Message sent successfully",
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.updated",
      update: { type: "subagents.replace", subagents: [{ status: "running" }] },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: {
        item: { type: "subagentDelegation", subagents: [{ status: "running" }] },
        outcome: { status: "succeeded" },
      },
    });
    transport.finish({ status: "succeeded" });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: { item: { type: "agentMessage" } },
    });
    transport.autonomous({
      nativeTurnKey: "task-notification-send",
      events: [
        {
          type: "subagent.settled",
          nativeSubagentId: "native-agent-1",
          status: "completed",
          resultSummary: "Directory analyzed",
        },
        {
          type: "text.delta",
          messageId: "send-continuation",
          delta: "Directory analyzed",
        },
        { type: "message.completed", messageId: "send-continuation" },
      ],
      result: { status: "succeeded" },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "subagent.state.changed",
      nativeSubagentId: "native-agent-1",
      status: "completed",
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.started",
      item: { type: "agentMessage", text: "" },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.updated",
      update: { type: "text.append", text: "Directory analyzed" },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: { item: { type: "agentMessage", text: "Directory analyzed" } },
    });
    expect(await nextEvent(iterator)).toMatchObject({ type: "turn.completed" });
    await session.close();
  });
});
