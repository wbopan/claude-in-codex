import path from "node:path";

import { describe, expect, it } from "vitest";
import { hostTurnIdSchema } from "@claude-in-codex/shared-contracts";

import { fixture, nextEvent, openSession, textTurn } from "./fixture.js";

describe("Claude Code HarnessAdapter", () => {
  it("projects automatic Compaction and defers Usage refresh until Turn completion", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();

    await session.execute(textTurn("automatic-compaction"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    const transport = transports[0];
    if (!transport) throw new Error("Fake Claude transport was not created");

    transport.event({ type: "compaction.started" });
    const started = await nextEvent(iterator);
    if (started.type !== "item.started" || started.item.type !== "contextCompaction") {
      throw new Error("Claude Context Compaction Item did not start");
    }

    transport.contextUsage = { usedTokens: 30, maxTokens: 200, model: "runtime-default" };
    transport.event({ type: "compaction.completed", outcome: "succeeded" });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: {
        item: { type: "contextCompaction", itemId: started.item.itemId },
        outcome: { status: "succeeded" },
      },
    });
    expect(transport.getContextUsage).not.toHaveBeenCalled();

    transport.delta("continued", "assistant-after-compaction");
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.updated",
      update: { type: "text.append", text: "continued" },
    });
    transport.finish({ status: "succeeded" });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: { item: { type: "agentMessage", text: "continued" } },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "turn.completed",
      outcome: { status: "succeeded" },
    });
    expect(transport.getContextUsage).not.toHaveBeenCalled();
    await session.close();
  });

  it("closes an active Compaction Item when the Turn is cancelled", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();

    await session.execute(textTurn("cancel-compaction"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    const transport = transports[0];
    if (!transport) throw new Error("Fake Claude transport was not created");
    transport.event({ type: "compaction.started" });
    await nextEvent(iterator);

    await session.execute({ type: "turn.cancel", turnId: textTurn("cancel-compaction").turnId });
    transport.finish({ status: "cancelled", reason: "aborted_streaming" });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: {
        item: { type: "contextCompaction" },
        outcome: { status: "cancelled" },
      },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: { item: { type: "agentMessage" }, outcome: { status: "cancelled" } },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "turn.completed",
      outcome: { status: "cancelled" },
    });
    await session.close();
  });

  it("keeps native Assistant responses in separate Agent Items", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();

    await session.execute(textTurn("message-boundaries"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    const firstStarted = await nextEvent(iterator);
    const transport = transports[0];
    if (!transport || firstStarted.type !== "item.started") {
      throw new Error("Fake Claude transport or first Agent Item was not created");
    }

    transport.delta("first", "assistant-1");
    await nextEvent(iterator);
    transport.delta("second", "assistant-2");
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: { item: { itemId: firstStarted.item.itemId, text: "first" } },
    });
    const secondStarted = await nextEvent(iterator);
    expect(secondStarted).toMatchObject({
      type: "item.started",
      item: { type: "agentMessage", text: "" },
    });
    await nextEvent(iterator);

    transport.delta("third", "assistant-3");
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: { item: { type: "agentMessage", text: "second" } },
    });
    const thirdStarted = await nextEvent(iterator);
    await nextEvent(iterator);
    if (secondStarted.type !== "item.started" || thirdStarted.type !== "item.started") {
      throw new Error("Expected Agent Item starts");
    }
    expect(
      new Set([firstStarted.item.itemId, secondStarted.item.itemId, thirdStarted.item.itemId]).size,
    ).toBe(3);

    transport.finish({ status: "succeeded" });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: { item: { itemId: thirdStarted.item.itemId, text: "third" } },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "turn.completed",
      outcome: { status: "succeeded" },
    });
    await session.close();
  });

  it("projects distinct visible Reasoning lifecycles before final text", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();

    await session.execute(textTurn("reasoning"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    const transport = transports[0];
    if (!transport) throw new Error("Fake Claude transport was not created");

    transport.reasoning("assistant-1", "first ");
    const firstStarted = await nextEvent(iterator);
    expect(firstStarted).toMatchObject({ type: "item.started", item: { type: "reasoning" } });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.updated",
      update: { type: "text.append", text: "first " },
    });
    transport.reasoning("assistant-1", "analysis");
    await nextEvent(iterator);
    transport.completeReasoning("assistant-1");
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: { item: { type: "reasoning", text: "first analysis" } },
    });

    transport.reasoning("assistant-2", "second analysis");
    const secondStarted = await nextEvent(iterator);
    expect(secondStarted).toMatchObject({ type: "item.started", item: { type: "reasoning" } });
    if (firstStarted.type !== "item.started" || secondStarted.type !== "item.started") {
      throw new Error("Expected Reasoning Item starts");
    }
    expect(secondStarted.item.itemId).not.toBe(firstStarted.item.itemId);
    await nextEvent(iterator);
    transport.completeReasoning("assistant-2");
    await nextEvent(iterator);
    transport.delta("answer");
    await nextEvent(iterator);
    transport.finish({ status: "succeeded" });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: { item: { type: "agentMessage", text: "answer" } },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "turn.completed",
      outcome: { status: "succeeded" },
    });
    await session.close();
  });

  it("projects bounded Bash and failed Generic Tool lifecycles in native order", async () => {
    const { adapter, transports } = fixture({ toolOutputLimit: 4 });
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();

    await session.execute(textTurn("tools"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    const transport = transports[0];
    if (!transport) throw new Error("Fake Claude transport was not created");

    transport.delta("before", "assistant-before-tool");
    await nextEvent(iterator);
    transport.event({
      type: "tool.started",
      callId: "bash-1",
      toolName: "Bash",
      arguments: { command: "printf complete" },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: { item: { type: "agentMessage", text: "before" } },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.started",
      item: {
        type: "commandExecution",
        command: "printf complete",
        cwd: path.resolve("/synthetic"),
      },
    });
    transport.event({ type: "tool.progress", callId: "bash-1", elapsedMs: 20 });
    transport.event({
      type: "tool.completed",
      callId: "bash-1",
      toolName: "Bash",
      outputText: "complete",
      isError: false,
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: {
        item: {
          type: "commandExecution",
          output: "comp",
          outputTruncated: true,
          durationMs: expect.any(Number),
        },
        outcome: { status: "succeeded" },
      },
    });

    transport.event({
      type: "tool.started",
      callId: "read-1",
      toolName: "Read",
      arguments: { file_path: "sample.txt" },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.started",
      item: { type: "toolExecution", toolName: "Read" },
    });
    transport.event({
      type: "tool.completed",
      callId: "read-1",
      toolName: "Read",
      outputText: "failed output",
      isError: true,
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: {
        item: {
          type: "toolExecution",
          output: { content: [{ type: "text", text: "fail" }], truncated: true },
        },
        outcome: { status: "failed", error: { code: "nativeFailure" } },
      },
    });

    transport.finish({ status: "succeeded" });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "turn.completed",
      outcome: { status: "succeeded" },
    });
    await session.close();
  });

  it("projects Claude Task tools as accumulated Todo snapshots", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();

    await session.execute(textTurn("tasks"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    const transport = transports[0];
    if (!transport) throw new Error("Fake Claude transport was not created");

    transport.event({
      type: "tool.started",
      callId: "create-1",
      toolName: "TaskCreate",
      arguments: {
        subject: "Run tests",
        description: "Run focused tests",
        activeForm: "Running tests",
      },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.started",
      item: { type: "toolExecution", toolName: "Todo", arguments: {} },
    });
    transport.event({
      type: "tool.completed",
      callId: "create-1",
      toolName: "TaskCreate",
      structuredResult: { task: { id: "1", subject: "Run tests" } },
      isError: false,
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: {
        item: {
          type: "toolExecution",
          toolName: "Todo",
          arguments: { todos: [{ id: "1", content: "Run tests", status: "pending" }] },
        },
      },
    });

    transport.event({
      type: "tool.started",
      callId: "update-1",
      toolName: "TaskUpdate",
      arguments: { taskId: "1", status: "in_progress" },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.started",
      item: { type: "toolExecution", toolName: "Todo", arguments: {} },
    });
    transport.event({
      type: "tool.completed",
      callId: "update-1",
      toolName: "TaskUpdate",
      isError: false,
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: {
        item: {
          type: "toolExecution",
          toolName: "Todo",
          arguments: { todos: [{ id: "1", content: "Run tests", status: "in_progress" }] },
        },
      },
    });

    transport.finish({ status: "succeeded" });
    await nextEvent(iterator);
    await session.close();
  });

  it("emits a reliable File Change immediately after a successful Edit", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();

    await session.execute(textTurn("edit"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    const transport = transports[0];
    if (!transport) throw new Error("Fake Claude transport was not created");

    transport.event({
      type: "tool.started",
      callId: "edit-1",
      toolName: "Edit",
      arguments: { file_path: "/synthetic/sample.txt" },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.started",
      item: { type: "toolExecution", toolName: "Edit" },
    });
    transport.event({
      type: "tool.completed",
      callId: "edit-1",
      toolName: "Edit",
      outputText: "edited",
      isError: false,
      fileChange: {
        path: "/synthetic/sample.txt",
        kind: "update",
        hunks: [
          {
            oldStart: 1,
            oldLines: 1,
            newStart: 1,
            newLines: 1,
            lines: ["-old", "+new"],
          },
        ],
      },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: { item: { type: "toolExecution", toolName: "Edit" } },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.started",
      item: {
        type: "fileChange",
        changes: [
          {
            path: "sample.txt",
            kind: "update",
            unifiedDiff: "--- a/sample.txt\n+++ b/sample.txt\n@@ -1,1 +1,1 @@\n-old\n+new\n",
          },
        ],
      },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: { item: { type: "fileChange" }, outcome: { status: "succeeded" } },
    });

    transport.finish({ status: "succeeded" });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: { item: { type: "agentMessage", text: "" } },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "turn.completed",
      outcome: { status: "succeeded" },
    });
    await session.close();
  });

  it("keeps successful Edit without native patch evidence Tool-only", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();

    await session.execute(textTurn("edit-no-patch"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    const transport = transports[0];
    if (!transport) throw new Error("Fake Claude transport was not created");
    transport.event({
      type: "tool.started",
      callId: "edit-1",
      toolName: "Edit",
      arguments: { file_path: "sample.txt" },
    });
    await nextEvent(iterator);
    transport.event({
      type: "tool.completed",
      callId: "edit-1",
      toolName: "Edit",
      isError: false,
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: { item: { type: "toolExecution" } },
    });
    transport.finish({ status: "succeeded" });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: { item: { type: "agentMessage" } },
    });
    expect(await nextEvent(iterator)).toMatchObject({ type: "turn.completed" });
    await session.close();
  });

  it("closes active Tools before cancellation and continues on the same Session", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();

    await session.execute(textTurn("cancel-tool"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    const transport = transports[0];
    if (!transport) throw new Error("Fake Claude transport was not created");
    transport.event({
      type: "tool.started",
      callId: "bash-1",
      toolName: "Bash",
      arguments: { command: "sleep 10" },
    });
    await nextEvent(iterator);
    await expect(
      session.execute({ type: "turn.cancel", turnId: hostTurnIdSchema.parse("cancel-tool") }),
    ).resolves.toEqual({ ok: true, value: { cancellationRequested: true } });
    transport.finish({ status: "cancelled", reason: "aborted_tools" });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: {
        item: { type: "commandExecution" },
        outcome: { status: "cancelled" },
      },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: { item: { type: "agentMessage" }, outcome: { status: "cancelled" } },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "turn.completed",
      outcome: { status: "cancelled" },
    });

    await expect(session.execute(textTurn("after-cancel-tool"))).resolves.toMatchObject({
      ok: true,
    });
    await nextEvent(iterator);
    await nextEvent(iterator);
    transport.delta("continued");
    await nextEvent(iterator);
    transport.finish({ status: "succeeded" });
    await nextEvent(iterator);
    expect(await nextEvent(iterator)).toMatchObject({
      type: "turn.completed",
      outcome: { status: "succeeded" },
    });
    expect(transports).toHaveLength(1);
    await session.close();
  });

  it("fails a successful native result that leaves a Tool unresolved", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();

    await session.execute(textTurn("unresolved-tool"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    const transport = transports[0];
    if (!transport) throw new Error("Fake Claude transport was not created");
    transport.event({
      type: "tool.started",
      callId: "read-1",
      toolName: "Read",
      arguments: {},
    });
    await nextEvent(iterator);
    transport.finish({ status: "succeeded" });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: { item: { type: "toolExecution" }, outcome: { status: "failed" } },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: { item: { type: "agentMessage" }, outcome: { status: "failed" } },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "turn.completed",
      outcome: { status: "failed", error: { code: "protocolError" } },
    });
    await session.close();
  });
});
