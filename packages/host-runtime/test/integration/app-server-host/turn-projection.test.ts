import { describe, expect, it, vi } from "vitest";
import { FakeHarnessAdapter } from "@claude-in-codex/harness-adapter/testing";
import type { JsonObject } from "@claude-in-codex/protocol-core";
import {
  harnessCommandDescriptorSchema,
  harnessIdSchema,
  harnessPermissionModeCatalogSchema,
  harnessPermissionModeIdSchema,
  hostItemIdSchema,
  hostTurnIdSchema,
} from "@claude-in-codex/shared-contracts";

import {
  PI_NATIVE_TRANSPORT_MODEL_ID,
  createFixture,
  startPiThread,
  startPiTurn,
  completePiTurn,
  stopFixture,
} from "./fixture.js";
import {
  method,
  requestId,
  messageParams,
  threadStatus,
  turnEvent,
  writeRequest,
} from "./json-rpc.js";

describe("AppServerHost HarnessAdapter projection", () => {
  it("pages external Turns and Items with paginated resume bootstrap", async () => {
    const fixture = createFixture();
    const officialWrite = vi.fn();
    fixture.official.stdin.on("data", officialWrite);
    writeRequest(fixture.desktopInput, {
      id: 10,
      method: "thread/start",
      params: {
        model: PI_NATIVE_TRANSPORT_MODEL_ID,
        cwd: "/synthetic",
        historyMode: "paginated",
      },
    });
    const started = await fixture.collector.waitFor((message) => requestId(message, 10));
    const threadId = ((started.result as JsonObject).thread as JsonObject).id;
    if (typeof threadId !== "string") throw new Error("Paginated Thread has no ID");
    const firstTurnId = await completePiTurn(fixture, threadId, 11);
    const secondTurnId = await completePiTurn(fixture, threadId, 12);
    const thirdTurnId = await completePiTurn(fixture, threadId, 13);
    const session = fixture.adapter.sessions[0];
    if (!session) throw new Error("Paginated Session was not opened");

    writeRequest(fixture.desktopInput, {
      id: 14,
      method: "thread/read",
      params: { threadId, includeTurns: true },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 14)),
    ).resolves.toMatchObject({ error: { code: -32602 } });

    writeRequest(fixture.desktopInput, {
      id: 15,
      method: "thread/turns/list",
      params: { threadId, limit: 2, itemsView: "summary" },
    });
    const turnsPage = await fixture.collector.waitFor((message) => requestId(message, 15));
    expect(turnsPage).toMatchObject({
      result: {
        data: [
          {
            id: thirdTurnId,
            itemsView: "summary",
            items: [{ type: "userMessage" }, { type: "agentMessage" }],
          },
          {
            id: secondTurnId,
            itemsView: "summary",
            items: [{ type: "userMessage" }, { type: "agentMessage" }],
          },
        ],
        nextCursor: expect.any(String),
        backwardsCursor: expect.any(String),
      },
    });
    expect(session.snapshotReads).toBe(1);

    writeRequest(fixture.desktopInput, {
      id: 16,
      method: "thread/items/list",
      params: { threadId, turnId: thirdTurnId },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 16)),
    ).resolves.toMatchObject({
      result: {
        data: [
          { turnId: thirdTurnId, item: { type: "userMessage" } },
          { turnId: thirdTurnId, item: { type: "agentMessage" } },
        ],
      },
    });
    expect(session.snapshotReads).toBe(1);

    writeRequest(fixture.desktopInput, {
      id: 17,
      method: "thread/resume",
      params: {
        threadId,
        excludeTurns: true,
        initialTurnsPage: { limit: 1, itemsView: "summary" },
      },
    });
    const resumed = await fixture.collector.waitFor((message) => requestId(message, 17));
    expect(resumed).toMatchObject({
      result: {
        thread: { id: threadId, turns: [] },
        initialTurnsPage: { data: [{ id: thirdTurnId }] },
        turnsBackwardsCursor: expect.any(String),
        itemsBackwardsCursor: expect.any(String),
      },
    });
    expect(session.snapshotReads).toBe(2);

    const itemsBackwardsCursor = (resumed.result as JsonObject).itemsBackwardsCursor;
    if (typeof itemsBackwardsCursor !== "string") {
      throw new Error("Paginated resume did not return an Item head cursor");
    }
    writeRequest(fixture.desktopInput, {
      id: 18,
      method: "thread/items/list",
      params: {
        threadId,
        turnId: firstTurnId,
        cursor: itemsBackwardsCursor,
      },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 18)),
    ).resolves.toMatchObject({
      result: { data: [], nextCursor: null, backwardsCursor: null },
    });

    expect(officialWrite).not.toHaveBeenCalled();
    await stopFixture(fixture);
  });

  it("projects early Adapter outputs after the turn/start response and supports thread/read", async () => {
    const fixture = createFixture();
    const threadId = await startPiThread(fixture);
    const session = fixture.adapter.sessions[0];
    if (!session) throw new Error("Fake Pi Session was not opened");

    writeRequest(fixture.desktopInput, {
      id: 2,
      method: "turn/start",
      params: { threadId, input: [{ type: "text", text: "synthetic" }] },
    });
    await fixture.collector.waitFor((message) => requestId(message, 2));
    session.appendText("fake output");
    await fixture.collector.waitFor((message) => method(message, "item/started"));
    session.succeedTurn();
    await fixture.collector.waitFor((message) => method(message, "turn/completed"));

    const responseIndex = fixture.collector.messages.findIndex((message) => requestId(message, 2));
    const startedIndex = fixture.collector.messages.findIndex((message) =>
      method(message, "turn/started"),
    );
    expect(responseIndex).toBeGreaterThanOrEqual(0);
    expect(startedIndex).toBeGreaterThan(responseIndex);

    writeRequest(fixture.desktopInput, {
      id: 3,
      method: "thread/read",
      params: { threadId, includeTurns: true },
    });
    const readResponse = await fixture.collector.waitFor((message) => requestId(message, 3));
    expect(readResponse).toMatchObject({
      result: { thread: { turns: [{ status: "completed" }] } },
    });
    await stopFixture(fixture);
  });

  it("projects autonomous Harness Turn input in the live turn/started payload", async () => {
    const fixture = createFixture();
    await startPiThread(fixture);
    const session = fixture.adapter.sessions[0];
    if (!session) throw new Error("Fake Pi Session was not opened");
    const turnId = hostTurnIdSchema.parse("autonomous-turn");

    session.publishAutonomousTurn(turnId, [
      { type: "text", text: "native follow-up" },
      { type: "text", text: "second line" },
    ]);

    await expect(
      fixture.collector.waitFor((message) => turnEvent(message, "turn/started", turnId)),
    ).resolves.toMatchObject({
      params: {
        turn: {
          id: turnId,
          items: [
            {
              type: "userMessage",
              content: [
                { type: "text", text: "native follow-up" },
                { type: "text", text: "second line" },
              ],
            },
          ],
        },
      },
    });
    await fixture.collector.waitFor((message) => turnEvent(message, "turn/completed", turnId));
    await stopFixture(fixture);
  });

  it("preserves ordinary prompt whitespace without command discovery", async () => {
    const fixture = createFixture();
    const threadId = await startPiThread(fixture);
    const session = fixture.adapter.sessions[0];
    if (!session) throw new Error("Fake Pi Session was not opened");
    const list = vi.fn();
    const executeCommand = vi.fn();
    session.commands = { list, execute: executeCommand };
    const execute = vi.spyOn(session, "execute");
    const text = " \ntext /compact text \n";

    writeRequest(fixture.desktopInput, {
      id: 2,
      method: "turn/start",
      params: { threadId, input: [{ type: "text", text }] },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 2)),
    ).resolves.toMatchObject({ result: { turn: { status: "inProgress" } } });
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ type: "turn.start", input: [{ type: "text", text }] }),
    );
    expect(list).not.toHaveBeenCalled();
    expect(executeCommand).not.toHaveBeenCalled();
    await stopFixture(fixture);
  });

  it.each([
    ["bare", "/compact"],
    ["space", "/compact "],
    ["newline", "/compact\n"],
    ["space before newline", "/compact \n"],
    ["surrounding whitespace", " \n/compact\t\r\n"],
  ])("recognizes compact without instructions: %s", async (_name, text) => {
    const fixture = createFixture();
    try {
      const threadId = await startPiThread(fixture);
      const session = fixture.adapter.sessions[0];
      if (!session) throw new Error("Fake Pi Session was not opened");
      session.commands = {
        list: async () => ({
          ok: true,
          value: {
            commands: [
              harnessCommandDescriptorSchema.parse({
                id: "fake.compact",
                invocation: "/compact",
                label: "Compact",
                argumentMode: "text",
              }),
            ],
          },
        }),
        execute: async ({ turnId, arguments: arguments_ }) => {
          expect(arguments_).toBeUndefined();
          session.publishEphemeralCommand(turnId, {
            type: "contextCompaction",
            itemId: hostItemIdSchema.parse("compact-whitespace-test"),
          });
          return { ok: true, value: { turnId } };
        },
      };
      writeRequest(fixture.desktopInput, {
        id: 2,
        method: "turn/start",
        params: { threadId, input: [{ type: "text", text }] },
      });
      await expect(
        fixture.collector.waitFor((message) => requestId(message, 2)),
      ).resolves.toMatchObject({ result: { turn: { status: "inProgress" } } });
    } finally {
      await stopFixture(fixture);
    }
  });

  it("projects a Harness command's native compaction Item through the existing UI lane", async () => {
    const fixture = createFixture();
    const threadId = await startPiThread(fixture);
    const session = fixture.adapter.sessions[0];
    if (!session) throw new Error("Fake Pi Session was not opened");
    session.commands = {
      list: async () => ({
        ok: true,
        value: {
          commands: [
            harnessCommandDescriptorSchema.parse({
              id: "fake.compact",
              invocation: "/compact",
              label: "Compact",
              argumentMode: "text" as const,
            }),
          ],
        },
      }),
      execute: async ({ turnId, commandId, arguments: arguments_ }) => {
        expect(commandId).toBe("fake.compact");
        expect(arguments_).toEqual({ text: "Keep implementation details" });
        session.publishEphemeralCommand(turnId, {
          type: "contextCompaction",
          itemId: hostItemIdSchema.parse("fake-compaction-item"),
        });
        return { ok: true, value: { turnId } };
      },
    };

    writeRequest(fixture.desktopInput, {
      id: 2,
      method: "turn/start",
      params: {
        threadId,
        input: [{ type: "text", text: "/compact Keep implementation details" }],
      },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 2)),
    ).resolves.toMatchObject({ result: { turn: { status: "inProgress" } } });
    await expect(
      fixture.collector.waitFor(
        (message) =>
          method(message, "item/started") &&
          (messageParams(message).item as JsonObject | undefined)?.type === "contextCompaction",
      ),
    ).resolves.toMatchObject({ params: { item: { type: "contextCompaction" } } });
    await expect(
      fixture.collector.waitFor(
        (message) =>
          method(message, "item/completed") &&
          (messageParams(message).item as JsonObject | undefined)?.type === "contextCompaction",
      ),
    ).resolves.toMatchObject({ params: { item: { type: "contextCompaction" } } });
    await fixture.collector.waitFor((message) => method(message, "turn/completed"));
    expect(session.persistedSnapshot().turns).toHaveLength(0);
    await stopFixture(fixture);
  });

  it("projects live and historical Reasoning through the native summary lane", async () => {
    const fixture = createFixture();
    const threadId = await startPiThread(fixture);
    const session = fixture.adapter.sessions[0];
    if (!session) throw new Error("Fake Pi Session was not opened");

    writeRequest(fixture.desktopInput, {
      id: 2,
      method: "turn/start",
      params: { threadId, input: [{ type: "text", text: "reasoning" }] },
    });
    await fixture.collector.waitFor((message) => requestId(message, 2));
    const reasoningId = session.startReasoning("visible ");
    await expect(
      fixture.collector.waitFor(
        (message) =>
          method(message, "item/started") &&
          ((message.params as JsonObject).item as JsonObject | undefined)?.id === reasoningId,
      ),
    ).resolves.toMatchObject({
      params: { item: { type: "reasoning", summary: [], content: [] } },
    });
    await expect(
      fixture.collector.waitFor((message) => method(message, "item/reasoning/summaryPartAdded")),
    ).resolves.toMatchObject({ params: { itemId: reasoningId, summaryIndex: 0 } });
    session.appendReasoning(reasoningId, "analysis");
    await expect(
      fixture.collector.waitFor(
        (message) =>
          method(message, "item/reasoning/summaryTextDelta") &&
          (message.params as JsonObject).delta === "analysis",
      ),
    ).resolves.toMatchObject({ params: { itemId: reasoningId, summaryIndex: 0 } });
    session.completeItem(reasoningId, { status: "succeeded" });
    await fixture.collector.waitFor(
      (message) =>
        method(message, "item/completed") &&
        ((message.params as JsonObject).item as JsonObject | undefined)?.id === reasoningId,
    );
    session.appendText("answer");
    session.succeedTurn();
    const completed = await fixture.collector.waitFor((message) =>
      method(message, "turn/completed"),
    );
    expect(completed).toMatchObject({
      params: {
        turn: {
          items: [
            {
              id: reasoningId,
              type: "reasoning",
              summary: ["visible analysis"],
              content: [],
            },
            { type: "agentMessage", text: "answer" },
          ],
        },
      },
    });

    writeRequest(fixture.desktopInput, {
      id: 3,
      method: "thread/read",
      params: { threadId, includeTurns: true },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 3)),
    ).resolves.toMatchObject({
      result: {
        thread: {
          turns: [
            {
              items: [
                { type: "userMessage" },
                {
                  id: reasoningId,
                  type: "reasoning",
                  summary: ["visible analysis"],
                  content: [],
                },
                { type: "agentMessage", text: "answer" },
              ],
            },
          ],
        },
      },
    });
    await stopFixture(fixture);
  });

  it("follows a Harness-initiated Plan mode change and flips the Desktop's Plan toggle", async () => {
    const permissionModes = harnessPermissionModeCatalogSchema.parse({
      modes: [
        { id: "plan", label: "Plan mode" },
        { id: "default", label: "Default" },
      ],
      defaultModeId: "default",
    });
    const adapter = new FakeHarnessAdapter(
      harnessIdSchema.parse("pi"),
      undefined,
      true,
      true,
      null,
      permissionModes,
    );
    const fixture = createFixture({ externalAdapters: new Map([["pi", adapter]]) });
    const threadId = await startPiThread(fixture);
    const session = adapter.sessions[0];
    if (!session) throw new Error("Fake Pi Session was not opened");
    const settingsUpdates = (): JsonObject[] =>
      fixture.collector.messages.filter((message) => message.method === "thread/settings/updated");

    // The Harness enters Plan mode on its own, the way Claude's EnterPlanMode does.
    await session.execute({
      type: "permissionMode.select",
      permissionModeId: harnessPermissionModeIdSchema.parse("plan"),
    });
    const notified = await fixture.collector.waitFor(
      (message) => message.method === "thread/settings/updated",
    );
    expect(notified).toMatchObject({
      params: {
        threadId,
        threadSettings: {
          cwd: "/synthetic",
          modelProvider: "claude-in-codex",
          collaborationMode: { mode: "plan", settings: {} },
        },
      },
    });
    const threadSettings = (notified.params as JsonObject).threadSettings as JsonObject;
    expect(typeof threadSettings.model).toBe("string");
    expect((threadSettings.collaborationMode as JsonObject).settings).toMatchObject({
      model: threadSettings.model,
    });

    // The Desktop now shows Plan on. Turning it off on the next Turn must leave Plan mode,
    // which only works when the Host compared against the mode the Harness really had.
    writeRequest(fixture.desktopInput, {
      id: 2,
      method: "turn/start",
      params: {
        threadId,
        input: [{ type: "text", text: "synthetic" }],
        collaborationMode: { mode: "default", settings: {} },
      },
    });
    const response = await fixture.collector.waitFor((message) => requestId(message, 2));
    const turnId = ((response.result as JsonObject).turn as JsonObject).id;
    expect(session.state.effectivePermissionModeId).toBe("default");
    await fixture.collector.waitFor((message) =>
      turnEvent(message, "turn/started", turnId as string),
    );
    session.succeedTurn();
    await fixture.collector.waitFor((message) =>
      turnEvent(message, "turn/completed", turnId as string),
    );

    // A Host-driven selection is recorded before the Session reports it: no second notification.
    expect(settingsUpdates()).toHaveLength(1);
    await stopFixture(fixture);
  });

  it("returns the Thread to idle after every Turn in the same Session", async () => {
    const fixture = createFixture();
    const threadId = await startPiThread(fixture);
    const session = fixture.adapter.sessions[0];
    if (!session) throw new Error("Fake Pi Session was not opened");
    const turnIds: string[] = [];

    for (const requestIdValue of [2, 3]) {
      const turnId = await startPiTurn(fixture, threadId, requestIdValue);
      turnIds.push(turnId);
      await fixture.collector.waitFor((message) => turnEvent(message, "turn/started", turnId));
      session.appendText(`output ${requestIdValue}`);
      session.succeedTurn();
      await fixture.collector.waitFor((message) => turnEvent(message, "turn/completed", turnId));
      const completedTurnCount = requestIdValue - 1;
      await fixture.collector.waitFor(
        (message) =>
          threadStatus(message, threadId, "idle") &&
          fixture.collector.messages.filter((candidate) =>
            threadStatus(candidate, threadId, "idle"),
          ).length >= completedTurnCount,
      );
    }

    const statuses = fixture.collector.messages.flatMap((message) => {
      if (!method(message, "thread/status/changed")) return [];
      const params = messageParams(message);
      if (params.threadId !== threadId) return [];
      const status = params.status as JsonObject | undefined;
      return typeof status?.type === "string" ? [status.type] : [];
    });
    expect(statuses).toEqual(["active", "idle", "active", "idle"]);
    for (const [turnIndex, turnId] of turnIds.entries()) {
      const completedIndex = fixture.collector.messages.findIndex((message) =>
        turnEvent(message, "turn/completed", turnId),
      );
      const idleIndexes = fixture.collector.messages.flatMap((message, messageIndex) =>
        threadStatus(message, threadId, "idle") ? [messageIndex] : [],
      );
      expect(completedIndex).toBeGreaterThanOrEqual(0);
      expect(idleIndexes[turnIndex]).toBeGreaterThan(completedIndex);
    }

    writeRequest(fixture.desktopInput, {
      id: 4,
      method: "thread/read",
      params: { threadId },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 4)),
    ).resolves.toMatchObject({ result: { thread: { status: { type: "idle" } } } });
    await stopFixture(fixture);
  });

  it("returns a command error without lifecycle notifications for a rejected Turn", async () => {
    const fixture = createFixture();
    const threadId = await startPiThread(fixture);
    const session = fixture.adapter.sessions[0];
    if (!session) throw new Error("Fake Pi Session was not opened");
    session.rejectNextTurn({
      code: "unavailable",
      message: "synthetic rejection",
      retryable: true,
    });

    writeRequest(fixture.desktopInput, {
      id: 2,
      method: "turn/start",
      params: { threadId, input: [{ type: "text", text: "rejected" }] },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 2)),
    ).resolves.toMatchObject({
      error: { code: -32073, message: "synthetic rejection" },
    });
    expect(fixture.collector.messages.some((message) => method(message, "turn/started"))).toBe(
      false,
    );
    await stopFixture(fixture);
  });

  it("projects a visible native failure before the failed Turn terminal", async () => {
    const fixture = createFixture();
    const threadId = await startPiThread(fixture);
    const session = fixture.adapter.sessions[0];
    if (!session) throw new Error("Fake Pi Session was not opened");

    writeRequest(fixture.desktopInput, {
      id: 2,
      method: "turn/start",
      params: { threadId, input: [{ type: "text", text: "failed" }] },
    });
    await fixture.collector.waitFor((message) => requestId(message, 2));
    session.startReasoning("visible failure context");
    await fixture.collector.waitFor(
      (message) =>
        method(message, "item/started") &&
        ((message.params as JsonObject).item as JsonObject | undefined)?.type === "reasoning",
    );
    session.failTurn({
      code: "nativeFailure",
      message: '503: {"message":"Service temporarily unavailable","type":"api_error"}',
      retryable: false,
    });
    const completed = await fixture.collector.waitFor((message) =>
      method(message, "turn/completed"),
    );
    expect(completed).toMatchObject({
      params: {
        turn: {
          status: "failed",
          error: {
            message: expect.stringContaining("Service temporarily unavailable"),
            codexErrorInfo: "other",
            additionalDetails: null,
          },
        },
      },
    });
    const visibleError = fixture.collector.messages.find((message) => method(message, "error"));
    expect(visibleError).toMatchObject({
      params: {
        error: {
          message: expect.stringContaining("Service temporarily unavailable"),
          codexErrorInfo: "other",
          additionalDetails: null,
        },
        willRetry: false,
        threadId,
      },
    });

    const itemIndex = fixture.collector.messages.findIndex((message) =>
      method(message, "item/completed"),
    );
    const errorIndex = fixture.collector.messages.findIndex((message) => method(message, "error"));
    const turnIndex = fixture.collector.messages.findIndex((message) =>
      method(message, "turn/completed"),
    );
    expect(itemIndex).toBeGreaterThanOrEqual(0);
    expect(errorIndex).toBeGreaterThan(itemIndex);
    expect(turnIndex).toBeGreaterThan(errorIndex);
    await stopFixture(fixture);
  });

  it("projects Command, Generic Tool, reliable File Change, and Turn Diff output", async () => {
    const fixture = createFixture();
    const threadId = await startPiThread(fixture);
    await startPiTurn(fixture, threadId);
    const session = fixture.adapter.sessions[0];
    if (!session) throw new Error("Fake Pi Session was not opened");

    const commandId = session.startCommandExecution("printf done", "/synthetic");
    await fixture.collector.waitFor(
      (message) =>
        method(message, "item/started") &&
        (message.params as JsonObject).item !== undefined &&
        ((message.params as JsonObject).item as JsonObject).id === commandId,
    );
    session.appendCommandOutput(commandId, "done\n");
    await fixture.collector.waitFor((message) =>
      method(message, "item/commandExecution/outputDelta"),
    );
    session.completeItem(commandId, { status: "succeeded" });

    const toolId = session.startToolExecution("custom", { value: 1 });
    session.replaceToolOutput(toolId, {
      content: [{ type: "text", text: "custom output" }],
    });
    session.completeItem(toolId, { status: "succeeded" });
    const toolCompleted = await fixture.collector.waitFor(
      (message) =>
        method(message, "item/completed") &&
        ((message.params as JsonObject).item as JsonObject | undefined)?.id === toolId,
    );
    expect(toolCompleted).toMatchObject({
      params: { item: { type: "dynamicToolCall", tool: "custom", success: true } },
    });

    session.emitFileChange([
      {
        path: "sample.txt",
        kind: "update",
        unifiedDiff: "--- a/sample.txt\n+++ b/sample.txt\n@@ -1 +1 @@\n-old\n+new\n",
      },
    ]);
    await fixture.collector.waitFor((message) => method(message, "item/fileChange/patchUpdated"));
    await expect(
      fixture.collector.waitFor((message) => method(message, "turn/diff/updated")),
    ).resolves.toMatchObject({ params: { diff: expect.stringContaining("+new") } });

    session.appendText("finished");
    session.succeedTurn();
    const completed = await fixture.collector.waitFor((message) =>
      method(message, "turn/completed"),
    );
    expect(completed).toMatchObject({
      params: {
        turn: {
          status: "completed",
          items: [{ type: "fileChange" }, { type: "agentMessage" }],
        },
      },
    });
    await stopFixture(fixture);
  });
});
