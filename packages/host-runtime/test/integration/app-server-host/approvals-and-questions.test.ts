import { describe, expect, it, vi } from "vitest";
import type { JsonObject } from "@claude-in-codex/protocol-core";

import { createFixture, startPiThread, startPiTurn, stopFixture } from "./fixture.js";
import { method, requestId, turnEvent, writeRequest } from "./json-rpc.js";

describe("AppServerHost HarnessAdapter projection", () => {
  it("deletes an active external Thread after retiring its pending Question", async () => {
    const fixture = createFixture();
    const forwarded: string[] = [];
    fixture.official.stdin.setEncoding("utf8");
    fixture.official.stdin.on("data", (chunk: string) => forwarded.push(chunk));
    const threadId = await startPiThread(fixture);
    const session = fixture.adapter.sessions[0];
    if (!session) throw new Error("Fake Pi Session was not opened");
    await startPiTurn(fixture, threadId);
    session.askQuestion({
      id: "value",
      type: "text",
      prompt: "Value",
      multiline: false,
      secret: false,
      optional: false,
    });
    const questionRequest = await fixture.collector.waitFor((message) =>
      method(message, "item/tool/requestUserInput"),
    );
    if (typeof questionRequest.id !== "number" || !Number.isSafeInteger(questionRequest.id)) {
      throw new Error("Question request has no numeric Host ID");
    }

    writeRequest(fixture.desktopInput, {
      id: 3,
      method: "thread/delete",
      params: { threadId },
    });
    await expect(fixture.collector.waitFor((message) => requestId(message, 3))).resolves.toEqual({
      id: 3,
      result: {},
    });
    writeRequest(fixture.desktopInput, {
      id: questionRequest.id,
      result: { answers: { value: { answers: ["late"] } } },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(forwarded.join("")).not.toContain(questionRequest.id);
    await stopFixture(fixture);
  });

  it("round-trips an early Approval through the reviewed Codex native request", async () => {
    const fixture = createFixture();
    const threadId = await startPiThread(fixture);
    const session = fixture.adapter.sessions[0];
    if (!session) throw new Error("Fake Pi Session was not opened");
    session.requestApprovalOnNextTurn("Allow native action?", "One-shot approval");

    const turnId = await startPiTurn(fixture, threadId);
    const request = await fixture.collector.waitFor((message) =>
      method(message, "mcpServer/elicitation/request"),
    );
    expect(request).toEqual({
      id: -1_000_001,
      method: "mcpServer/elicitation/request",
      params: {
        serverName: "pi",
        threadId,
        turnId,
        mode: "form",
        message: "Allow native action?",
        requestedSchema: { type: "object", properties: {} },
        _meta: {
          codex_approval_kind: "mcp_tool_call",
          reason: "One-shot approval",
        },
      },
    });
    expect(
      fixture.collector.messages.some((message) => method(message, "item/tool/requestUserInput")),
    ).toBe(false);

    const approvalRequestId = request.id;
    if (typeof approvalRequestId !== "number") {
      throw new Error("Approval request has no numeric Host ID");
    }
    writeRequest(fixture.desktopInput, {
      id: approvalRequestId,
      result: { action: "accept", content: {}, _meta: null },
    });
    await vi.waitFor(() => {
      expect(session.interactionResponses).toMatchObject([
        { response: { type: "approval", actionId: "allowOnce" } },
      ]);
    });
    writeRequest(fixture.desktopInput, {
      id: approvalRequestId,
      result: { action: "accept" },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(session.interactionResponses).toHaveLength(1);

    session.appendText("continued");
    session.succeedTurn();
    await fixture.collector.waitFor((message) => turnEvent(message, "turn/completed", turnId));
    await stopFixture(fixture);
  });

  it("round-trips a declared native Approval scope without exposing a payload", async () => {
    const fixture = createFixture();
    const threadId = await startPiThread(fixture);
    const session = fixture.adapter.sessions[0];
    if (!session) throw new Error("Fake Pi Session was not opened");
    await startPiTurn(fixture, threadId);
    session.requestApproval("Remember native action?", undefined, "always");
    const request = await fixture.collector.waitFor((message) =>
      method(message, "mcpServer/elicitation/request"),
    );
    expect(request).toMatchObject({ params: { _meta: { persist: "always" } } });
    if (typeof request.id !== "number") throw new Error("Approval request has no numeric ID");
    writeRequest(fixture.desktopInput, {
      id: request.id,
      result: { action: "accept", content: {}, _meta: { persist: "always" } },
    });
    await vi.waitFor(() => {
      expect(session.interactionResponses).toMatchObject([
        { response: { type: "approval", actionId: "allowAlways" } },
      ]);
    });
    session.succeedTurn();
    await fixture.collector.waitFor((message) => method(message, "turn/completed"));
    await stopFixture(fixture);
  });

  it("fails closed for denied, cancelled, errored, and malformed native Approval responses", async () => {
    const responses: JsonObject[] = [
      { result: { action: "decline" } },
      { result: { action: "cancel" } },
      { error: { code: -1, message: "dismissed" } },
      { result: { action: "allowForSession" } },
      { result: { action: "accept", content: {}, _meta: { persist: "session" } } },
    ];
    for (const response of responses) {
      const fixture = createFixture();
      const threadId = await startPiThread(fixture);
      const session = fixture.adapter.sessions[0];
      if (!session) throw new Error("Fake Pi Session was not opened");
      await startPiTurn(fixture, threadId);
      session.requestApproval("Approve once");
      const request = await fixture.collector.waitFor((message) =>
        method(message, "mcpServer/elicitation/request"),
      );
      const approvalRequestId = request.id;
      if (typeof approvalRequestId !== "number") {
        throw new Error("Approval request has no numeric Host ID");
      }
      writeRequest(fixture.desktopInput, { id: approvalRequestId, ...response });
      await vi.waitFor(() => {
        expect(session.interactionResponses.at(-1)).toMatchObject({
          response: { type: "approval", actionId: "deny" },
        });
      });
      session.succeedTurn();
      await fixture.collector.waitFor((message) => method(message, "turn/completed"));
      await stopFixture(fixture);
    }
  });

  it("resolves cancelled Approval state and consumes its reserved late-response namespace", async () => {
    const fixture = createFixture();
    const forwarded: string[] = [];
    fixture.official.stdin.setEncoding("utf8");
    fixture.official.stdin.on("data", (chunk: string) => forwarded.push(chunk));
    const threadId = await startPiThread(fixture);
    const turnId = await startPiTurn(fixture, threadId);
    const session = fixture.adapter.sessions[0];
    if (!session) throw new Error("Fake Pi Session was not opened");
    session.requestApproval("Cancel pending Approval");
    const approvalRequest = await fixture.collector.waitFor((message) =>
      method(message, "mcpServer/elicitation/request"),
    );
    const approvalRequestId = approvalRequest.id;
    if (typeof approvalRequestId !== "number") {
      throw new Error("Approval request has no numeric Host ID");
    }
    session.completeCancellationOnRequest();

    writeRequest(fixture.desktopInput, {
      id: 3,
      method: "turn/interrupt",
      params: { threadId, turnId },
    });
    await fixture.collector.waitFor((message) => requestId(message, 3));
    const resolved = await fixture.collector.waitFor((message) =>
      method(message, "serverRequest/resolved"),
    );
    const completed = await fixture.collector.waitFor((message) =>
      method(message, "turn/completed"),
    );
    expect(resolved).toMatchObject({
      params: { threadId, requestId: approvalRequestId },
    });
    const responseIndex = fixture.collector.messages.findIndex((message) => requestId(message, 3));
    const resolvedIndex = fixture.collector.messages.indexOf(resolved);
    const terminalIndex = fixture.collector.messages.indexOf(completed);
    expect(resolvedIndex).toBeGreaterThan(responseIndex);
    expect(terminalIndex).toBeGreaterThan(resolvedIndex);

    writeRequest(fixture.desktopInput, {
      id: approvalRequestId,
      result: { action: "accept" },
    });
    writeRequest(fixture.desktopInput, {
      id: -1_500_000,
      result: { action: "accept" },
    });
    writeRequest(fixture.desktopInput, { id: 999, result: { official: true } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(forwarded.join("")).not.toContain(
      JSON.stringify({ id: 999, result: { official: true } }),
    );
    expect(forwarded.join("")).not.toContain(String(approvalRequestId));
    expect(forwarded.join("")).not.toContain("-1500000");
    expect(session.interactionResponses).toHaveLength(0);
    await stopFixture(fixture);
  });

  it("round-trips an early standalone Question through the Codex native request", async () => {
    const fixture = createFixture();
    const threadId = await startPiThread(fixture);
    const session = fixture.adapter.sessions[0];
    if (!session) throw new Error("Fake Pi Session was not opened");
    session.askQuestionOnNextTurn(
      {
        id: "decision",
        type: "choice",
        prompt: "Choose",
        options: [
          { value: "continue-value", label: "Continue" },
          { value: "stop-value", label: "Stop" },
        ],
        multiple: false,
        allowOther: false,
        optional: false,
      },
      { title: "Decision" },
    );

    const turnId = await startPiTurn(fixture, threadId);
    const request = await fixture.collector.waitFor((message) =>
      method(message, "item/tool/requestUserInput"),
    );
    expect(request).toMatchObject({
      id: -1,
      params: {
        threadId,
        turnId,
        itemId: expect.any(String),
        questions: [
          {
            id: "decision",
            header: "Decision",
            question: "Choose",
            options: [
              { label: "Continue", description: "" },
              { label: "Stop", description: "" },
            ],
          },
        ],
      },
    });
    const turnResponseIndex = fixture.collector.messages.findIndex((message) =>
      requestId(message, 2),
    );
    const questionIndex = fixture.collector.messages.indexOf(request);
    expect(questionIndex).toBeGreaterThan(turnResponseIndex);
    const requestIdValue = request.id;
    if (typeof requestIdValue !== "number") throw new Error("Question request has no numeric ID");
    writeRequest(fixture.desktopInput, {
      id: requestIdValue,
      result: { answers: { decision: { answers: ["Continue"] } } },
    });
    await fixture.collector.waitFor(
      (message) =>
        method(message, "item/completed") &&
        ((message.params as JsonObject).item as JsonObject | undefined)?.id ===
          (request.params as JsonObject).itemId,
    );
    expect(session.interactionResponses).toMatchObject([
      {
        response: { type: "question", answers: { decision: ["continue-value"] } },
      },
    ]);

    session.appendText("continued");
    const turnCompleted = fixture.collector.waitFor((message) =>
      turnEvent(message, "turn/completed", turnId),
    );
    session.succeedTurn();
    await turnCompleted;
    await stopFixture(fixture);
  });

  it("fails a secret Question closed without rendering visible Desktop input", async () => {
    const fixture = createFixture();
    const threadId = await startPiThread(fixture);
    const session = fixture.adapter.sessions[0];
    if (!session) throw new Error("Fake Pi Session was not opened");
    await startPiTurn(fixture, threadId);
    session.askQuestion({
      id: "secret",
      type: "text",
      prompt: "Secret value",
      multiline: false,
      secret: true,
      optional: false,
    });
    await vi.waitFor(() => {
      expect(session.interactionResponses.at(-1)).toMatchObject({
        response: { type: "question", answers: {}, cancelled: true },
      });
    });
    expect(
      fixture.collector.messages.filter((message) => method(message, "item/tool/requestUserInput")),
    ).toHaveLength(0);
    const turnCompleted = fixture.collector.waitFor((message) => method(message, "turn/completed"));
    session.succeedTurn();
    await turnCompleted;
    await stopFixture(fixture);
  });

  it("cancels malformed and dismissed Desktop Question responses", async () => {
    for (const result of [
      { answers: { decision: { answers: ["undeclared"] } } },
      { answers: {} },
    ]) {
      const fixture = createFixture();
      const threadId = await startPiThread(fixture);
      const session = fixture.adapter.sessions[0];
      if (!session) throw new Error("Fake Pi Session was not opened");
      await startPiTurn(fixture, threadId);
      session.askQuestion({
        id: "decision",
        type: "choice",
        prompt: "Choose",
        options: [{ value: "known", label: "Known" }],
        multiple: false,
        allowOther: false,
        optional: false,
      });
      const request = await fixture.collector.waitFor((message) =>
        method(message, "item/tool/requestUserInput"),
      );
      if (typeof request.id !== "number") throw new Error("Question request has no numeric ID");
      writeRequest(fixture.desktopInput, { id: request.id, result });
      await fixture.collector.waitFor((message) => method(message, "item/completed"));
      expect(session.interactionResponses.at(-1)).toMatchObject({
        response: { type: "question", answers: {}, cancelled: true },
      });
      session.succeedTurn();
      await fixture.collector.waitFor((message) => method(message, "turn/completed"));
      await stopFixture(fixture);
    }
  });

  it("cancels a Question at the Host expiry bound", async () => {
    const fixture = createFixture();
    const threadId = await startPiThread(fixture);
    const session = fixture.adapter.sessions[0];
    if (!session) throw new Error("Fake Pi Session was not opened");
    await startPiTurn(fixture, threadId);
    session.askQuestion(
      {
        id: "value",
        type: "text",
        prompt: "Value",
        multiline: false,
        secret: false,
        optional: false,
      },
      { expiresAt: new Date(Date.now() + 20).toISOString() },
    );
    const request = await fixture.collector.waitFor((message) =>
      method(message, "item/tool/requestUserInput"),
    );
    await expect(
      fixture.collector.waitFor((message) => method(message, "serverRequest/resolved")),
    ).resolves.toMatchObject({
      params: { threadId, requestId: request.id },
    });
    await fixture.collector.waitFor((message) => method(message, "item/completed"));
    expect(session.interactionResponses.at(-1)).toMatchObject({
      response: { type: "question", answers: {}, cancelled: true },
    });
    session.succeedTurn();
    await fixture.collector.waitFor((message) => method(message, "turn/completed"));
    await stopFixture(fixture);
  });

  it("forwards non-Host responses and consumes retired Host Question responses", async () => {
    const fixture = createFixture();
    const forwarded: string[] = [];
    fixture.official.stdin.setEncoding("utf8");
    fixture.official.stdin.on("data", (chunk: string) => forwarded.push(chunk));
    const threadId = await startPiThread(fixture);
    const session = fixture.adapter.sessions[0];
    if (!session) throw new Error("Fake Pi Session was not opened");
    await startPiTurn(fixture, threadId);
    const interactionId = session.askQuestion({
      id: "value",
      type: "text",
      prompt: "Value",
      multiline: false,
      secret: false,
      optional: false,
    });
    const request = await fixture.collector.waitFor((message) =>
      method(message, "item/tool/requestUserInput"),
    );
    if (typeof request.id !== "number") throw new Error("Question request has no numeric ID");
    session.expireQuestion(interactionId);
    await expect(
      fixture.collector.waitFor((message) => method(message, "serverRequest/resolved")),
    ).resolves.toMatchObject({
      params: { threadId, requestId: request.id },
    });
    await fixture.collector.waitFor((message) => method(message, "item/completed"));

    writeRequest(fixture.desktopInput, {
      id: request.id,
      result: { answers: { value: { answers: ["late"] } } },
    });
    writeRequest(fixture.desktopInput, { id: 999, result: { official: true } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(forwarded.join("")).not.toContain(
      JSON.stringify({ id: 999, result: { official: true } }),
    );
    expect(forwarded.join("")).not.toContain(String(request.id));

    session.succeedTurn();
    await fixture.collector.waitFor((message) => method(message, "turn/completed"));
    await stopFixture(fixture);
  });
});
