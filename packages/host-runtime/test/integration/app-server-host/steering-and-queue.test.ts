import { rmSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";
import type { JsonObject } from "@claude-in-codex/protocol-core";

import {
  createFixture,
  startPiThread,
  startPiTurn,
  stopFixture,
  bindOfficialThread,
} from "./fixture.js";
import {
  method,
  requestId,
  messageParams,
  turnEvent,
  writeRequest,
  readJsonLine,
} from "./json-rpc.js";

describe("AppServerHost HarnessAdapter projection", () => {
  it("cancels pending steering before draining operations after a Desktop input error", async () => {
    const fixture = createFixture();
    try {
      const threadId = await startPiThread(fixture);
      const oldTurnId = await startPiTurn(fixture, threadId);
      const session = fixture.adapter.sessions[0];
      if (!session) throw new Error("Fake Session was not opened");
      const execute = vi.spyOn(session, "execute");
      writeRequest(fixture.desktopInput, {
        id: 100,
        method: "turn/steer",
        params: {
          threadId,
          expectedTurnId: oldTurnId,
          input: [{ type: "text", text: "must not start during shutdown" }],
        },
      });
      await vi.waitFor(() =>
        expect(execute).toHaveBeenCalledWith({ type: "turn.cancel", turnId: oldTurnId }),
      );
      // No terminal event: only shutdown, not the 20-second steering timeout, can release this waiter.
      fixture.desktopInput.destroy(new Error("Synthetic Desktop input failure"));
      const response = await fixture.collector.waitFor((message) => requestId(message, 100));
      expect(response).toMatchObject({ error: { code: -32074 } });
      expect(JSON.stringify(response)).toContain("connection closed before replacement");
      expect(execute).not.toHaveBeenCalledWith(expect.objectContaining({ type: "turn.start" }));
      expect(await fixture.running).toBe(1);
    } finally {
      fixture.host.close();
      await fixture.running;
      rmSync(fixture.mappingStoreDirectory, { recursive: true, force: true });
    }
  });

  it("steers an external Thread by cancelling, waiting for terminal projection, and starting once", async () => {
    const fixture = createFixture();
    const threadId = await startPiThread(fixture);
    const oldTurnId = await startPiTurn(fixture, threadId);
    const session = fixture.adapter.sessions[0];
    if (!session) throw new Error("Fake Pi Session was not opened");
    const execute = vi.spyOn(session, "execute");
    const officialWrite = vi.fn();
    fixture.official.stdin.on("data", officialWrite);
    const params = {
      threadId,
      expectedTurnId: oldTurnId,
      clientUserMessageId: "steer-message",
      input: [{ type: "text", text: "new direction" }],
    };
    writeRequest(fixture.desktopInput, { id: 100, method: "turn/steer", params });
    await vi.waitFor(() =>
      expect(execute).toHaveBeenCalledWith({ type: "turn.cancel", turnId: oldTurnId }),
    );
    expect(fixture.collector.messages.some((message) => requestId(message, 100))).toBe(false);
    writeRequest(fixture.desktopInput, { id: 101, method: "turn/steer", params });
    writeRequest(fixture.desktopInput, {
      id: 102,
      method: "turn/start",
      params: { threadId, input: [{ type: "text", text: "competing" }] },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 102)),
    ).resolves.toMatchObject({ error: { code: -32072 } });
    session.completeCancellation();
    const response = await fixture.collector.waitFor((message) => requestId(message, 100));
    const replacementId = (response.result as JsonObject).turnId;
    expect(typeof replacementId).toBe("string");
    expect(replacementId).not.toBe(oldTurnId);
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 101)),
    ).resolves.toMatchObject({ result: { turnId: replacementId } });
    await fixture.collector.waitFor((message) =>
      turnEvent(message, "turn/started", String(replacementId)),
    );
    const index = (predicate: (message: JsonObject) => boolean) =>
      fixture.collector.messages.findIndex(predicate);
    expect(index((message) => turnEvent(message, "turn/completed", oldTurnId))).toBeLessThan(
      index((message) => requestId(message, 100)),
    );
    expect(index((message) => requestId(message, 100))).toBeLessThan(
      index((message) => turnEvent(message, "turn/started", String(replacementId))),
    );
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenNthCalledWith(2, {
      type: "turn.start",
      turnId: replacementId,
      input: [{ type: "text", text: "new direction" }],
    });
    expect(officialWrite).not.toHaveBeenCalled();
    session.succeedTurn();
    await fixture.collector.waitFor((message) =>
      turnEvent(message, "turn/completed", String(replacementId)),
    );
    await stopFixture(fixture);
  });

  it("handles synchronous external cancellation and rejects stale or unsupported steer input locally", async () => {
    const fixture = createFixture();
    const threadId = await startPiThread(fixture);
    const oldTurnId = await startPiTurn(fixture, threadId);
    const session = fixture.adapter.sessions[0];
    if (!session) throw new Error("Fake Pi Session was not opened");
    const execute = vi.spyOn(session, "execute");
    for (const [id, params] of [
      [100, { threadId, expectedTurnId: "stale", input: [{ type: "text", text: "new" }] }],
      [
        101,
        {
          threadId,
          expectedTurnId: oldTurnId,
          input: [
            { type: "text", text: "new" },
            { type: "image", url: "image" },
          ],
        },
      ],
    ] as const) {
      writeRequest(fixture.desktopInput, {
        id,
        method: "turn/steer",
        params: JSON.parse(JSON.stringify(params)),
      });
      await expect(
        fixture.collector.waitFor((message) => requestId(message, id)),
      ).resolves.toHaveProperty("error");
    }
    expect(execute).not.toHaveBeenCalled();
    session.completeCancellationOnRequest();
    writeRequest(fixture.desktopInput, {
      id: 102,
      method: "turn/steer",
      params: { threadId, expectedTurnId: oldTurnId, input: [{ type: "text", text: "new" }] },
    });
    const response = await fixture.collector.waitFor((message) => requestId(message, 102));
    expect(response).toHaveProperty("result.turnId");
    session.succeedTurn();
    await stopFixture(fixture);
  });

  it("passes an Account-bound official steer and its result through unchanged", async () => {
    const fixture = createFixture();
    await bindOfficialThread(fixture, "official-thread");
    const params = {
      threadId: "official-thread",
      expectedTurnId: "official-turn",
      clientUserMessageId: "message",
      input: [{ type: "text", text: "new direction" }],
    };
    writeRequest(fixture.desktopInput, { id: 100, method: "turn/steer", params });
    await expect(readJsonLine(fixture.official.stdin)).resolves.toEqual({
      id: 100,
      method: "turn/steer",
      params,
    });
    writeRequest(fixture.official.stdout, { id: 100, result: { turnId: "official-turn" } });
    await expect(fixture.collector.waitFor((message) => requestId(message, 100))).resolves.toEqual({
      id: 100,
      result: { turnId: "official-turn" },
    });
    expect(fixture.adapter.sessions).toHaveLength(0);
    await stopFixture(fixture);
  });

  it("writes the interrupt response before cancellation lifecycle notifications", async () => {
    const fixture = createFixture();
    const threadId = await startPiThread(fixture);
    const turnId = await startPiTurn(fixture, threadId);
    const session = fixture.adapter.sessions[0];
    if (!session) throw new Error("Fake Pi Session was not opened");
    session.startCommandExecution("sleep 10");
    session.askQuestion({
      id: "cancel-decision",
      type: "choice",
      prompt: "Continue?",
      options: [
        { value: "yes", label: "Yes" },
        { value: "no", label: "No" },
      ],
      multiple: false,
      allowOther: false,
      optional: false,
    });
    const questionRequest = await fixture.collector.waitFor((message) =>
      method(message, "item/tool/requestUserInput"),
    );
    session.completeCancellationOnRequest();

    writeRequest(fixture.desktopInput, {
      id: 3,
      method: "turn/interrupt",
      params: { threadId, turnId },
    });
    await expect(fixture.collector.waitFor((message) => requestId(message, 3))).resolves.toEqual({
      id: 3,
      result: {},
    });
    const completed = await fixture.collector.waitFor((message) =>
      method(message, "turn/completed"),
    );
    expect(completed).toMatchObject({ params: { turn: { status: "interrupted" } } });

    const responseIndex = fixture.collector.messages.findIndex((message) => requestId(message, 3));
    const questionItemId = (questionRequest.params as JsonObject).itemId;
    const questionClosedIndex = fixture.collector.messages.findIndex(
      (message) =>
        method(message, "item/completed") &&
        ((message.params as JsonObject).item as JsonObject | undefined)?.id === questionItemId,
    );
    const turnIndex = fixture.collector.messages.findIndex((message) =>
      method(message, "turn/completed"),
    );
    expect(questionClosedIndex).toBeGreaterThan(responseIndex);
    expect(turnIndex).toBeGreaterThan(questionClosedIndex);
    await stopFixture(fixture);
  });

  it("rejects an interrupt that does not reference the active Pi Turn", async () => {
    const fixture = createFixture();
    const officialWrite = vi.fn();
    fixture.official.stdin.on("data", officialWrite);
    const threadId = await startPiThread(fixture);

    writeRequest(fixture.desktopInput, {
      id: 2,
      method: "turn/interrupt",
      params: { threadId, turnId: "missing-turn" },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 2)),
    ).resolves.toMatchObject({
      error: { code: -32074, message: "External turn/interrupt must reference the active Turn" },
    });
    expect(officialWrite).not.toHaveBeenCalled();
    await stopFixture(fixture);
  });
});

describe("AppServerHost External Thread message queue", () => {
  function queueAdd(threadId: string, id: number, textValue: string, clientId = textValue) {
    return {
      id,
      method: "thread/queue/add",
      params: {
        threadId,
        input: [{ type: "text", text: textValue }],
        clientUserMessageId: clientId,
      },
    };
  }

  function turnStartText(call: unknown): string | null {
    const [command] = call as [JsonObject];
    if (!isRecordValue(command) || command.type !== "turn.start") return null;
    const input = command.input as Array<{ text: string }>;
    return input.map((item) => item.text).join("\n");
  }

  function isRecordValue(value: unknown): value is JsonObject {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  it("queues a message while an External Turn runs and drains it after the Turn completes", async () => {
    const fixture = createFixture();
    const threadId = await startPiThread(fixture);
    const firstTurnId = await startPiTurn(fixture, threadId);
    const session = fixture.adapter.sessions[0];
    if (!session) throw new Error("Fake Pi Session was not opened");
    await fixture.collector.waitFor((message) => turnEvent(message, "turn/started", firstTurnId));
    const execute = vi.spyOn(session, "execute");
    const officialWrite = vi.fn();
    fixture.official.stdin.on("data", officialWrite);

    writeRequest(fixture.desktopInput, queueAdd(threadId, 3, "queued one", "client-one"));
    const added = await fixture.collector.waitFor((message) => requestId(message, 3));
    const queued = (added.result as JsonObject).queuedSubmission as JsonObject;
    expect(queued).toMatchObject({
      input: [{ type: "text", text: "queued one" }],
      clientUserMessageId: "client-one",
    });
    expect(typeof queued.id).toBe("string");
    await fixture.collector.waitFor(
      (message) =>
        method(message, "thread/queue/changed") && messageParams(message).threadId === threadId,
    );
    expect(execute).not.toHaveBeenCalledWith(expect.objectContaining({ type: "turn.start" }));

    writeRequest(fixture.desktopInput, {
      id: 4,
      method: "thread/queue/list",
      params: { threadId },
    });
    await expect(fixture.collector.waitFor((message) => requestId(message, 4))).resolves.toEqual({
      id: 4,
      result: { data: [queued], nextCursor: null },
    });

    session.appendText("first answer");
    session.succeedTurn();
    await fixture.collector.waitFor((message) => turnEvent(message, "turn/completed", firstTurnId));
    await vi.waitFor(() => expect(execute.mock.calls.map(turnStartText)).toContain("queued one"));
    const secondStarted = await fixture.collector.waitFor(
      (message) =>
        method(message, "turn/started") &&
        (messageParams(message).turn as JsonObject).id !== firstTurnId,
    );
    const secondTurnId = (messageParams(secondStarted).turn as JsonObject).id as string;
    writeRequest(fixture.desktopInput, {
      id: 5,
      method: "thread/queue/list",
      params: { threadId },
    });
    await expect(fixture.collector.waitFor((message) => requestId(message, 5))).resolves.toEqual({
      id: 5,
      result: { data: [], nextCursor: null },
    });
    session.appendText("second answer");
    session.succeedTurn();
    await fixture.collector.waitFor((message) =>
      turnEvent(message, "turn/completed", secondTurnId),
    );
    expect(officialWrite).not.toHaveBeenCalled();
    await stopFixture(fixture);
  });

  it("dispatches a submission queued on an idle External Thread at once", async () => {
    const fixture = createFixture();
    const threadId = await startPiThread(fixture);
    const session = fixture.adapter.sessions[0];
    if (!session) throw new Error("Fake Pi Session was not opened");
    const execute = vi.spyOn(session, "execute");
    writeRequest(fixture.desktopInput, queueAdd(threadId, 2, "run now"));
    const added = await fixture.collector.waitFor((message) => requestId(message, 2));
    expect((added.result as JsonObject).queuedSubmission).toMatchObject({
      clientUserMessageId: "run now",
    });
    const started = await fixture.collector.waitFor((message) => method(message, "turn/started"));
    const turnId = (messageParams(started).turn as JsonObject).id as string;
    expect(execute.mock.calls.map(turnStartText)).toEqual(["run now"]);
    writeRequest(fixture.desktopInput, {
      id: 3,
      method: "thread/queue/list",
      params: { threadId },
    });
    await expect(fixture.collector.waitFor((message) => requestId(message, 3))).resolves.toEqual({
      id: 3,
      result: { data: [], nextCursor: null },
    });
    session.succeedTurn();
    await fixture.collector.waitFor((message) => turnEvent(message, "turn/completed", turnId));
    await stopFixture(fixture);
  });

  it("keeps the queue through an interrupt and starts a chosen submission on request", async () => {
    const fixture = createFixture();
    const threadId = await startPiThread(fixture);
    const firstTurnId = await startPiTurn(fixture, threadId);
    const session = fixture.adapter.sessions[0];
    if (!session) throw new Error("Fake Pi Session was not opened");
    await fixture.collector.waitFor((message) => turnEvent(message, "turn/started", firstTurnId));
    const execute = vi.spyOn(session, "execute");

    writeRequest(fixture.desktopInput, queueAdd(threadId, 3, "alpha"));
    writeRequest(fixture.desktopInput, queueAdd(threadId, 4, "beta"));
    const alpha = (await fixture.collector.waitFor((message) => requestId(message, 3)))
      .result as JsonObject;
    const beta = (await fixture.collector.waitFor((message) => requestId(message, 4)))
      .result as JsonObject;
    const alphaId = (alpha.queuedSubmission as JsonObject).id as string;
    const betaId = (beta.queuedSubmission as JsonObject).id as string;

    session.completeCancellationOnRequest();
    writeRequest(fixture.desktopInput, {
      id: 5,
      method: "turn/interrupt",
      params: { threadId, turnId: firstTurnId },
    });
    await fixture.collector.waitFor((message) => requestId(message, 5));
    const interrupted = await fixture.collector.waitFor((message) =>
      turnEvent(message, "turn/completed", firstTurnId),
    );
    expect((messageParams(interrupted).turn as JsonObject).status).toBe("interrupted");
    writeRequest(fixture.desktopInput, {
      id: 6,
      method: "thread/queue/list",
      params: { threadId },
    });
    const listed = await fixture.collector.waitFor((message) => requestId(message, 6));
    expect(((listed.result as JsonObject).data as JsonObject[]).map((entry) => entry.id)).toEqual([
      alphaId,
      betaId,
    ]);
    expect(execute).not.toHaveBeenCalledWith(expect.objectContaining({ type: "turn.start" }));

    writeRequest(fixture.desktopInput, {
      id: 7,
      method: "thread/queue/start",
      params: { threadId, queuedSubmissionId: betaId },
    });
    const startedResponse = await fixture.collector.waitFor((message) => requestId(message, 7));
    const betaTurnId = ((startedResponse.result as JsonObject).turn as JsonObject).id as string;
    expect(execute.mock.calls.map(turnStartText)).toEqual([null, "beta"]);
    await fixture.collector.waitFor((message) => turnEvent(message, "turn/started", betaTurnId));

    writeRequest(fixture.desktopInput, {
      id: 8,
      method: "thread/queue/start",
      params: { threadId },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 8)),
    ).resolves.toMatchObject({ error: { code: -32072 } });

    writeRequest(fixture.desktopInput, {
      id: 9,
      method: "thread/queue/reorder",
      params: { threadId, queuedSubmissionIds: [alphaId, betaId] },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 9)),
    ).resolves.toMatchObject({ error: { code: -32602 } });

    session.succeedTurn();
    await fixture.collector.waitFor((message) => turnEvent(message, "turn/completed", betaTurnId));
    await vi.waitFor(() => expect(execute.mock.calls.map(turnStartText)).toContain("alpha"));
    const alphaStarted = await fixture.collector.waitFor(
      (message) =>
        method(message, "turn/started") &&
        ![firstTurnId, betaTurnId].includes(
          (messageParams(message).turn as JsonObject).id as string,
        ),
    );
    session.succeedTurn();
    await fixture.collector.waitFor((message) =>
      turnEvent(
        message,
        "turn/completed",
        (messageParams(alphaStarted).turn as JsonObject).id as string,
      ),
    );
    await stopFixture(fixture);
  });

  it("forwards official Thread queue requests and edits queued External submissions", async () => {
    const fixture = createFixture();
    const threadId = await startPiThread(fixture);
    const officialWrite = vi.fn();
    fixture.official.stdin.on("data", officialWrite);
    writeRequest(fixture.desktopInput, {
      id: 2,
      method: "thread/queue/list",
      params: { threadId: "official-thread" },
    });
    await vi.waitFor(() =>
      expect(officialWrite.mock.calls.map(([chunk]) => String(chunk)).join("")).toContain(
        "thread/queue/list",
      ),
    );

    const turnId = await startPiTurn(fixture, threadId, 3);
    const session = fixture.adapter.sessions[0];
    if (!session) throw new Error("Fake Pi Session was not opened");
    await fixture.collector.waitFor((message) => turnEvent(message, "turn/started", turnId));
    writeRequest(fixture.desktopInput, queueAdd(threadId, 4, "draft"));
    const added = await fixture.collector.waitFor((message) => requestId(message, 4));
    const submissionId = ((added.result as JsonObject).queuedSubmission as JsonObject).id;
    if (typeof submissionId !== "string") throw new Error("Queued submission has no ID");
    writeRequest(fixture.desktopInput, {
      id: 5,
      method: "thread/queue/update",
      params: {
        threadId,
        queuedSubmissionId: submissionId,
        input: [{ type: "text", text: "edited" }],
      },
    });
    await expect(fixture.collector.waitFor((message) => requestId(message, 5))).resolves.toEqual({
      id: 5,
      result: {
        queuedSubmission: {
          id: submissionId,
          input: [{ type: "text", text: "edited" }],
          clientUserMessageId: "draft",
        },
      },
    });
    writeRequest(fixture.desktopInput, {
      id: 6,
      method: "thread/queue/delete",
      params: { threadId, queuedSubmissionId: submissionId },
    });
    await expect(fixture.collector.waitFor((message) => requestId(message, 6))).resolves.toEqual({
      id: 6,
      result: { deleted: true },
    });
    writeRequest(fixture.desktopInput, {
      id: 7,
      method: "thread/queue/bogus",
      params: { threadId },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 7)),
    ).resolves.toMatchObject({
      error: { code: -32076, message: "External Thread does not support thread/queue/bogus" },
    });
    session.succeedTurn();
    await fixture.collector.waitFor((message) => turnEvent(message, "turn/completed", turnId));
    expect(fixture.adapter.sessions).toHaveLength(1);
    await stopFixture(fixture);
  });
});
