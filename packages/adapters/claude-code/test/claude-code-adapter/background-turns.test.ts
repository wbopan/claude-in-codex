import { describe, expect, it, vi } from "vitest";

import type { HarnessOutput, HostEvent } from "@claude-in-codex/harness-adapter";
import { fixture, nextEvent, openSession, textTurn } from "./fixture.js";

describe("Claude Code HarnessAdapter", () => {
  it("publishes an autonomous Root Turn after background task completion", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();

    await session.execute(textTurn("background"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    const transport = transports[0];
    if (!transport) throw new Error("Fake Claude transport was not created");
    transport.delta("Background task launched");
    await nextEvent(iterator);
    transport.finish({ status: "succeeded" });
    await nextEvent(iterator);
    await nextEvent(iterator);

    transport.autonomous({
      nativeTurnKey: "task-notification-1",
      events: [
        {
          type: "subagent.settled",
          nativeSubagentId: "native-agent-1",
          status: "completed",
          resultSummary: "Analysis complete",
        },
        {
          type: "text.delta",
          messageId: "autonomous-assistant",
          delta: "Background analysis result",
        },
        {
          type: "message.completed",
          messageId: "autonomous-assistant",
          checkpointId: "autonomous-checkpoint",
        },
      ],
      result: { status: "succeeded" },
    });
    expect(await nextEvent(iterator)).toMatchObject({ type: "turn.autonomous.started", input: [] });
    expect(await nextEvent(iterator)).toMatchObject({ type: "turn.started" });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.started",
      item: { type: "agentMessage", text: "" },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "subagent.state.changed",
      nativeSubagentId: "native-agent-1",
      status: "completed",
      resultSummary: "Analysis complete",
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.updated",
      update: { type: "text.append", text: "Background analysis result" },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: { item: { type: "agentMessage", text: "Background analysis result" } },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "turn.completed",
      outcome: { status: "succeeded" },
      nativeTurnRef: { nativeTurnKey: "task-notification-1" },
    });
    await session.close();
  });

  it("opens an autonomous Turn at its first output and refuses turn.start until it ends", async () => {
    // Regression: the Turn only appeared once the Segment ended, so the Host let a
    // follow-up start mid-Segment and Claude absorbed it into the running work.
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();

    await session.execute(textTurn("background"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    const transport = transports[0];
    if (!transport) throw new Error("Fake Claude transport was not created");
    transport.finish({ status: "succeeded" });
    await nextEvent(iterator);
    await nextEvent(iterator);

    const handler = transport.autonomousTurnHandler;
    if (!handler) throw new Error("Autonomous Turn handler was not registered");
    handler.onStart("task-notification-live");
    expect(await nextEvent(iterator)).toMatchObject({ type: "turn.autonomous.started", input: [] });
    expect(await nextEvent(iterator)).toMatchObject({ type: "turn.started" });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.started",
      item: { type: "agentMessage", text: "" },
    });
    handler.onEvent({
      type: "tool.started",
      callId: "regress-run",
      toolName: "Bash",
      arguments: { command: "pytest" },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.started",
      item: { type: "commandExecution" },
    });

    await expect(session.execute(textTurn("follow-up"))).resolves.toMatchObject({
      ok: false,
      error: { code: "sessionBusy" },
    });
    expect(transport.turns.map((turn) => turn.text)).toEqual(["background"]);

    handler.onEvent({
      type: "tool.completed",
      callId: "regress-run",
      toolName: "Bash",
      isError: false,
      outputText: "ok",
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: { item: { type: "commandExecution" }, outcome: { status: "succeeded" } },
    });
    handler.onEvent({ type: "text.delta", messageId: "continuation", delta: "All green" });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.updated",
      update: { type: "text.append", text: "All green" },
    });
    handler.onEvent({ type: "message.completed", messageId: "continuation" });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: { item: { type: "agentMessage", text: "All green" } },
    });
    handler.onTerminal({ status: "succeeded" });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "turn.completed",
      outcome: { status: "succeeded" },
      nativeTurnRef: { nativeTurnKey: "task-notification-live" },
    });

    await expect(session.execute(textTurn("follow-up"))).resolves.toMatchObject({ ok: true });
    expect(transport.turns.map((turn) => turn.text)).toEqual(["background", "follow-up"]);
    await session.close();
  });

  it.each(["completed", "failed", "interrupted"] as const)(
    "finishes an autonomous Turn after its newly created child is %s",
    async (status) => {
      const { adapter, transports } = fixture();
      const session = await openSession(adapter);
      const events: Array<Extract<HarnessOutput, { kind: "event" }>["event"]> = [];
      const drain = (async () => {
        for await (const output of session.outputs) {
          if (output.kind === "event") events.push(output.event);
        }
      })();
      try {
        await session.execute(textTurn("initial"));
        const transport = transports[0];
        if (!transport) throw new Error("Fake Claude transport was not created");
        transport.finish({ status: "succeeded" });
        await vi.waitFor(() =>
          expect(events.some((event) => event.type === "turn.completed")).toBe(true),
        );
        events.length = 0;
        transport.autonomous({
          nativeTurnKey: "continuation-with-child",
          events: [
            {
              type: "subagent.started",
              operation: "spawn",
              callId: "spawn-child",
              description: "Inspect",
              background: true,
            },
            {
              type: "subagent.completed",
              callId: "spawn-child",
              isError: false,
              continuesInBackground: true,
              nativeSubagentId: "fast-child",
            },
            {
              type: "subagent.settled",
              nativeSubagentId: "fast-child",
              status,
              resultSummary: "Child finished",
            },
          ],
          result: { status: "succeeded" },
        });
        await vi.waitFor(() =>
          expect(events.some((event) => event.type === "turn.completed")).toBe(true),
        );
        expect(events.filter((event) => event.type === "subagent.state.changed")).toEqual([
          {
            type: "subagent.state.changed",
            nativeSubagentId: "fast-child",
            status,
            resultSummary: "Child finished",
          },
        ]);
        const creation = events.findIndex(
          (event) =>
            event.type === "item.completed" && event.snapshot.item.type === "subagentDelegation",
        );
        const settlement = events.findIndex((event) => event.type === "subagent.state.changed");
        expect(creation).toBeGreaterThanOrEqual(0);
        expect(settlement).toBeGreaterThan(creation);
        expect(await session.execute(textTurn("next-user-turn"))).toMatchObject({ ok: true });
        transport.finish({ status: "succeeded" });
      } finally {
        await session.close();
        await drain;
      }
    },
  );

  it("publishes a background Subagent settlement that arrives outside any Turn", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();

    await session.execute(textTurn("delegate in background"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    const transport = transports[0];
    if (!transport) throw new Error("Fake Claude transport was not created");
    transport.delta("Background task launched");
    await nextEvent(iterator);
    transport.finish({ status: "succeeded" });
    await nextEvent(iterator);
    await nextEvent(iterator);

    // The Turn is complete and idle. Claude may enqueue the task notification
    // without a continuation, so the settlement no longer rides a Turn.
    transport.threadEvent({
      type: "subagent.settled",
      nativeSubagentId: "native-agent-late",
      status: "completed",
      resultSummary: "Analysis complete",
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "subagent.state.changed",
      nativeSubagentId: "native-agent-late",
      status: "completed",
      resultSummary: "Analysis complete",
    });
    await session.close();
  });

  it("holds the Root Turn until background Subagents and continuations finish", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();

    await session.execute(textTurn("launch three agents"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    const transport = transports[0];
    if (!transport) throw new Error("Fake Claude transport was not created");
    transport.delta("Started three agents");
    await nextEvent(iterator);
    for (const [index, nativeSubagentId] of [
      "native-agent-a",
      "native-agent-b",
      "native-agent-c",
    ].entries()) {
      const callId = `agent-${index + 1}`;
      transport.event({
        type: "subagent.started",
        operation: "spawn",
        callId,
        description: `Inspect ${nativeSubagentId}`,
        background: true,
      });
      await nextEvent(iterator);
      if (index === 0) await nextEvent(iterator);
      transport.event({
        type: "subagent.completed",
        callId,
        isError: false,
        continuesInBackground: true,
        nativeSubagentId,
        resultSummary: "Async agent launched successfully",
      });
      await nextEvent(iterator);
      await nextEvent(iterator);
    }
    transport.finish({ status: "succeeded" });
    await expect(session.execute(textTurn("follow-up"))).resolves.toMatchObject({
      ok: false,
      error: { code: "sessionBusy" },
    });

    for (const [index, nativeSubagentId] of [
      "native-agent-a",
      "native-agent-b",
      "native-agent-c",
    ].entries()) {
      transport.autonomous({
        nativeTurnKey: `task-notification-${index + 1}`,
        events: [
          {
            type: "subagent.settled",
            nativeSubagentId,
            status: "completed",
            resultSummary: `${nativeSubagentId} done`,
          },
          {
            type: "text.delta",
            messageId: `continuation-${index + 1}`,
            delta: `${nativeSubagentId} done`,
          },
          { type: "message.completed", messageId: `continuation-${index + 1}` },
        ],
        result: { status: "succeeded" },
      });
      expect(await nextEvent(iterator)).toMatchObject({
        type: "subagent.state.changed",
        nativeSubagentId,
        status: "completed",
      });
      expect(await nextEvent(iterator)).toMatchObject({
        type: "item.started",
        item: { type: "agentMessage" },
      });
      expect(await nextEvent(iterator)).toMatchObject({
        type: "item.updated",
        update: { type: "text.append", text: `${nativeSubagentId} done` },
      });
      expect(await nextEvent(iterator)).toMatchObject({
        type: "item.completed",
        snapshot: { item: { type: "agentMessage", text: `${nativeSubagentId} done` } },
      });
      if (index < 2) {
        continue;
      }
      expect(await nextEvent(iterator)).toMatchObject({
        type: "turn.completed",
        outcome: { status: "succeeded" },
        nativeTurnRef: { nativeTurnKey: transport.turns[0]?.userMessageId },
      });
    }
    await session.close();
  });

  it("releases a held Root Turn when a background Subagent settles without a continuation", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();

    await session.execute(textTurn("launch in background"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    const transport = transports[0];
    if (!transport) throw new Error("Fake Claude transport was not created");
    transport.event({
      type: "subagent.started",
      operation: "spawn",
      callId: "agent-1",
      description: "Inspect directory",
      background: true,
    });
    await nextEvent(iterator);
    transport.event({
      type: "subagent.completed",
      callId: "agent-1",
      isError: false,
      continuesInBackground: true,
      nativeSubagentId: "native-agent-1",
    });
    await nextEvent(iterator);
    await nextEvent(iterator);
    transport.delta("The Subagent is running", "root-1");
    await nextEvent(iterator);
    transport.event({ type: "message.completed", messageId: "root-1" });
    await nextEvent(iterator);
    transport.finish({ status: "succeeded" });
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });

    // The idle notification may carry only the original callId. It still has to
    // release the held Turn after the native Root result has already arrived.
    transport.event({ type: "subagent.updated", callId: "agent-1", status: "completed" });
    let event: HostEvent;
    do event = await nextEvent(iterator);
    while (event.type !== "turn.completed");
    expect(event).toMatchObject({ outcome: { status: "succeeded" } });

    await expect(session.execute(textTurn("after-settlement"))).resolves.toMatchObject({
      ok: true,
    });
    transport.finish({ status: "succeeded" });
    await session.close();
  });

  it("holds the Root Turn when background Subagents settle before the native result", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();

    await session.execute(textTurn("launch three agents"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    const transport = transports[0];
    if (!transport) throw new Error("Fake Claude transport was not created");
    const nativeSubagentIds = ["a419753fbeb78d5bd", "a4c17172923f00231", "a78414260bd2f9554"];
    for (const [index, nativeSubagentId] of nativeSubagentIds.entries()) {
      const callId = `agent-${index + 1}`;
      transport.event({
        type: "subagent.started",
        operation: "spawn",
        callId,
        description: nativeSubagentId,
        background: true,
      });
      await nextEvent(iterator);
      transport.event({
        type: "subagent.completed",
        callId,
        isError: false,
        continuesInBackground: true,
        nativeSubagentId,
        resultSummary: "Async agent launched successfully",
      });
      await nextEvent(iterator);
      await nextEvent(iterator);
    }
    // Claude reports every Subagent as settled before the Root Segment ends, but
    // it answers for each of them in a later Segment.
    for (const nativeSubagentId of [...nativeSubagentIds].reverse()) {
      transport.event({
        type: "subagent.settled",
        nativeSubagentId,
        status: "completed",
        resultSummary: `${nativeSubagentId} finished`,
      });
      expect(await nextEvent(iterator)).toMatchObject({
        type: "subagent.state.changed",
        nativeSubagentId,
        status: "completed",
      });
    }
    transport.delta("三个agent全部启动完毕");
    await nextEvent(iterator);
    transport.finish({ status: "succeeded" });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: { item: { type: "agentMessage", text: "三个agent全部启动完毕" } },
    });
    await expect(session.execute(textTurn("follow-up"))).resolves.toMatchObject({
      ok: false,
      error: { code: "sessionBusy" },
    });

    for (const [index, nativeSubagentId] of nativeSubagentIds.entries()) {
      transport.event({ type: "segment.started" });
      transport.delta(`${nativeSubagentId} 已完成`, `continuation-${index + 1}`);
      expect(await nextEvent(iterator)).toMatchObject({ type: "item.started" });
      expect(await nextEvent(iterator)).toMatchObject({
        type: "item.updated",
        update: { type: "text.append", text: `${nativeSubagentId} 已完成` },
      });
      transport.event({ type: "message.completed", messageId: `continuation-${index + 1}` });
      expect(await nextEvent(iterator)).toMatchObject({ type: "item.completed" });
      transport.finish({ status: "succeeded" });
    }
    expect(await nextEvent(iterator)).toMatchObject({
      type: "turn.completed",
      outcome: { status: "succeeded" },
    });
    await session.close();
  });

  it("does not complete the Root Turn when a Subagent settles during a continuation", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();

    await session.execute(textTurn("launch two agents"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    const transport = transports[0];
    if (!transport) throw new Error("Fake Claude transport was not created");
    for (const [index, nativeSubagentId] of ["native-agent-1", "native-agent-2"].entries()) {
      transport.event({
        type: "subagent.started",
        operation: "spawn",
        callId: `agent-${index + 1}`,
        description: `Inspect ${nativeSubagentId}`,
        background: true,
      });
      await nextEvent(iterator);
      transport.event({
        type: "subagent.completed",
        callId: `agent-${index + 1}`,
        isError: false,
        continuesInBackground: true,
        nativeSubagentId,
        resultSummary: "Async agent launched successfully",
      });
      await nextEvent(iterator);
      await nextEvent(iterator);
    }
    transport.event({
      type: "subagent.settled",
      nativeSubagentId: "native-agent-1",
      callId: "agent-1",
      status: "completed",
    });
    await nextEvent(iterator);
    transport.finish({ status: "succeeded" });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: { item: { type: "agentMessage" } },
    });
    await expect(session.execute(textTurn("follow-up"))).resolves.toMatchObject({
      ok: false,
      error: { code: "sessionBusy" },
    });

    transport.event({ type: "segment.started" });
    transport.delta("Agent 1 已完成，等待 Agent 2", "continuation-1");
    expect(await nextEvent(iterator)).toMatchObject({ type: "item.started" });
    await nextEvent(iterator);
    // The second Subagent settles while Claude is still answering for the first.
    transport.event({
      type: "subagent.settled",
      nativeSubagentId: "native-agent-2",
      callId: "agent-2",
      status: "completed",
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "subagent.state.changed",
      nativeSubagentId: "native-agent-2",
    });
    transport.event({ type: "message.completed", messageId: "continuation-1" });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: { item: { text: "Agent 1 已完成，等待 Agent 2" } },
    });
    transport.finish({ status: "succeeded" });
    await expect(session.execute(textTurn("follow-up"))).resolves.toMatchObject({
      ok: false,
      error: { code: "sessionBusy" },
    });

    transport.event({ type: "segment.started" });
    transport.delta("Agent 2 已完成", "continuation-2");
    expect(await nextEvent(iterator)).toMatchObject({ type: "item.started" });
    await nextEvent(iterator);
    transport.event({ type: "message.completed", messageId: "continuation-2" });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: { item: { text: "Agent 2 已完成" } },
    });
    transport.finish({ status: "succeeded" });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "turn.completed",
      outcome: { status: "succeeded" },
    });
    await session.close();
  });

  it("does not complete a held Turn when Root output arrives without a new Segment", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();

    await session.execute(textTurn("launch in background"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    const transport = transports[0];
    if (!transport) throw new Error("Fake Claude transport was not created");
    transport.event({
      type: "subagent.started",
      operation: "spawn",
      callId: "agent-1",
      description: "Inspect directory",
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
    transport.event({
      type: "subagent.settled",
      nativeSubagentId: "native-agent-1",
      callId: "agent-1",
      status: "completed",
    });
    await nextEvent(iterator);
    transport.delta("started", "root-1");
    await nextEvent(iterator);
    transport.event({ type: "message.completed", messageId: "root-1" });
    await nextEvent(iterator);
    transport.finish({ status: "succeeded" });
    await expect(session.execute(textTurn("follow-up"))).resolves.toMatchObject({
      ok: false,
      error: { code: "sessionBusy" },
    });

    transport.delta("Inspection complete", "continuation");
    expect(await nextEvent(iterator)).toMatchObject({ type: "item.started" });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.updated",
      update: { type: "text.append", text: "Inspection complete" },
    });
    await new Promise((resolve) => {
      setTimeout(resolve, 80);
    });
    await expect(session.execute(textTurn("still-busy"))).resolves.toMatchObject({
      ok: false,
      error: { code: "sessionBusy" },
    });
    transport.event({ type: "message.completed", messageId: "continuation" });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: { item: { type: "agentMessage", text: "Inspection complete" } },
    });
    transport.finish({ status: "succeeded" });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "turn.completed",
      outcome: { status: "succeeded" },
    });
    await session.close();
  });

  it("completes after interleaved Root end_turn once background Subagents settle", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();

    await session.execute(textTurn("launch three agents in background"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    const transport = transports[0];
    if (!transport) throw new Error("Fake Claude transport was not created");
    for (const [index, nativeSubagentId] of [
      "a8b5bcd3a4bf6c508",
      "a47086db7e0c568b6",
      "a372e8a990c9aadf9",
    ].entries()) {
      const callId = `agent-${index + 1}`;
      transport.event({
        type: "subagent.started",
        operation: "spawn",
        callId,
        description: nativeSubagentId,
        background: true,
      });
      await nextEvent(iterator);
      transport.event({
        type: "subagent.completed",
        callId,
        isError: false,
        continuesInBackground: true,
        nativeSubagentId,
        resultSummary: "Async agent launched successfully",
      });
      await nextEvent(iterator);
      await nextEvent(iterator);
    }

    transport.delta("已并行启动 3 个子 agent", "root-1");
    await nextEvent(iterator);
    transport.event({ type: "message.completed", messageId: "root-1" });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: { item: { text: "已并行启动 3 个子 agent" } },
    });
    transport.finish({ status: "succeeded" });
    await expect(session.execute(textTurn("follow-up"))).resolves.toMatchObject({
      ok: false,
      error: { code: "sessionBusy" },
    });

    transport.delta("等待三个子 agent 返回检查结果。", "root-2");
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.started",
      item: { type: "agentMessage", text: "" },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.updated",
      update: { type: "text.append", text: "等待三个子 agent 返回检查结果。" },
    });
    transport.event({ type: "message.completed", messageId: "root-2" });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: { item: { text: "等待三个子 agent 返回检查结果。" } },
    });
    transport.finish({ status: "succeeded" });
    await expect(session.execute(textTurn("still-busy"))).resolves.toMatchObject({
      ok: false,
      error: { code: "sessionBusy" },
    });

    for (const nativeSubagentId of [
      "a8b5bcd3a4bf6c508",
      "a47086db7e0c568b6",
      "a372e8a990c9aadf9",
    ]) {
      transport.event({
        type: "subagent.settled",
        nativeSubagentId,
        status: "completed",
        resultSummary: `${nativeSubagentId} finished`,
      });
      expect(await nextEvent(iterator)).toMatchObject({
        type: "subagent.state.changed",
        nativeSubagentId,
        status: "completed",
      });
    }

    transport.delta("三份子 agent 已完成，结果一致。", "root-3");
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.started",
      item: { type: "agentMessage", text: "" },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.updated",
      update: { type: "text.append", text: "三份子 agent 已完成，结果一致。" },
    });
    transport.event({ type: "message.completed", messageId: "root-3" });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: { item: { text: "三份子 agent 已完成，结果一致。" } },
    });
    await expect(session.execute(textTurn("after-items"))).resolves.toMatchObject({
      ok: false,
      error: { code: "sessionBusy" },
    });
    transport.finish({ status: "succeeded" });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "turn.completed",
      outcome: { status: "succeeded" },
    });
    await session.close();
  });

  it("does not complete a user Turn while launched background Agents are unsettled", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();
    const agents = ["a0e467bb4be68bd08", "a22cd5f001d3795e3", "a5eb0835279350422"] as const;

    await session.execute(textTurn("launch three agents"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    const transport = transports[0];
    if (!transport) throw new Error("Fake Claude transport was not created");
    for (const [index, nativeSubagentId] of agents.entries()) {
      const callId = `agent-${index + 1}`;
      transport.event({
        type: "subagent.started",
        operation: "spawn",
        callId,
        description: nativeSubagentId,
        background: true,
      });
      await nextEvent(iterator);
      transport.event({
        type: "subagent.completed",
        callId,
        isError: false,
        continuesInBackground: true,
        nativeSubagentId,
        resultSummary: "Async agent launched successfully",
      });
      await nextEvent(iterator);
      await nextEvent(iterator);
    }
    transport.delta("已启动 3 个子 agent", "root-1");
    await nextEvent(iterator);
    transport.event({ type: "message.completed", messageId: "root-1" });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: { item: { text: "已启动 3 个子 agent" } },
    });
    transport.finish({ status: "succeeded" });
    await expect(session.execute(textTurn("follow-up"))).resolves.toMatchObject({
      ok: false,
      error: { code: "sessionBusy" },
    });

    transport.event({
      type: "subagent.settled",
      nativeSubagentId: agents[0],
      status: "completed",
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "subagent.state.changed",
      nativeSubagentId: agents[0],
      status: "completed",
    });
    transport.delta("第 1 个子 agent 已完成，另外 2 个仍在执行中。", "root-2");
    expect(await nextEvent(iterator)).toMatchObject({ type: "item.started" });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.updated",
      update: { type: "text.append", text: "第 1 个子 agent 已完成，另外 2 个仍在执行中。" },
    });
    transport.event({ type: "message.completed", messageId: "root-2" });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: { item: { text: "第 1 个子 agent 已完成，另外 2 个仍在执行中。" } },
    });
    transport.finish({ status: "succeeded" });
    await expect(session.execute(textTurn("still-busy"))).resolves.toMatchObject({
      ok: false,
      error: { code: "sessionBusy" },
    });

    for (const nativeSubagentId of agents.slice(1)) {
      transport.event({ type: "subagent.settled", nativeSubagentId, status: "completed" });
      expect(await nextEvent(iterator)).toMatchObject({
        type: "subagent.state.changed",
        nativeSubagentId,
        status: "completed",
      });
    }
    transport.delta("第 3 个子 agent 已完成。", "root-3");
    expect(await nextEvent(iterator)).toMatchObject({ type: "item.started" });
    expect(await nextEvent(iterator)).toMatchObject({ type: "item.updated" });
    transport.event({ type: "message.completed", messageId: "root-3" });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: { item: { text: "第 3 个子 agent 已完成。" } },
    });
    await expect(session.execute(textTurn("after-items"))).resolves.toMatchObject({
      ok: false,
      error: { code: "sessionBusy" },
    });
    transport.finish({ status: "succeeded" });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "turn.completed",
      outcome: { status: "succeeded" },
    });
    await session.close();
  });

  it("occupies a background spawn from Tool Use and settles it by callId", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();

    await session.execute(textTurn("launch without agent id"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    const transport = transports[0];
    if (!transport) throw new Error("Fake Claude transport was not created");
    transport.event({
      type: "subagent.started",
      operation: "spawn",
      callId: "call_without_id",
      description: "Inspect directory",
      background: true,
    });
    await nextEvent(iterator);
    transport.event({
      type: "subagent.completed",
      callId: "call_without_id",
      isError: false,
      continuesInBackground: true,
      resultSummary: "Async agent launched successfully",
    });
    await nextEvent(iterator);
    await nextEvent(iterator);
    transport.delta("started", "root-1");
    await nextEvent(iterator);
    transport.event({ type: "message.completed", messageId: "root-1" });
    await nextEvent(iterator);
    transport.finish({ status: "succeeded" });
    await expect(session.execute(textTurn("follow-up"))).resolves.toMatchObject({
      ok: false,
      error: { code: "sessionBusy" },
    });

    transport.event({
      type: "subagent.settled",
      nativeSubagentId: "late-agent-id",
      callId: "call_without_id",
      status: "completed",
      resultSummary: "Inspection complete",
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "subagent.state.changed",
      nativeSubagentId: "late-agent-id",
      status: "completed",
    });
    transport.delta("done", "root-2");
    expect(await nextEvent(iterator)).toMatchObject({ type: "item.started" });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.updated",
      update: { type: "text.append", text: "done" },
    });
    transport.event({ type: "message.completed", messageId: "root-2" });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: { item: { text: "done" } },
    });
    transport.finish({ status: "succeeded" });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "turn.completed",
      outcome: { status: "succeeded" },
    });
    await session.close();
  });
});
