import { describe, expect, it, vi } from "vitest";
import { FakeHarnessAdapter } from "@claude-in-codex/harness-adapter/testing";
import {
  CLAUDE_CODE_NATIVE_TRANSPORT_MODEL_ID,
  encodeClaudeTransportModel,
  encodeExternalTransportSelection,
  type ExternalHarnessId,
  type JsonObject,
} from "@claude-in-codex/protocol-core";
import { harnessIdSchema } from "@claude-in-codex/shared-contracts";

import { SingleNativeCodexAccount } from "../../../src/account/codex-account-control.js";

import {
  PI_NATIVE_TRANSPORT_MODEL_ID,
  createFixture,
  startExternalThread,
  startPiThread,
  stopFixture,
  bindOfficialThread,
} from "./fixture.js";
import { method, requestId, writeRequest, readJsonLine } from "./json-rpc.js";

describe("AppServerHost official forwarding", () => {
  it.each([
    { method: "claude-in-codex/unknown", params: {} },
    {
      method: "thread/start",
      params: { model: "gpt-5", cwd: "/synthetic", unknownParam: "opaque" },
    },
    {
      method: "turn/start",
      params: {
        threadId: "official-thread",
        input: [{ type: "text", text: "synthetic" }],
        unknownParam: "opaque",
      },
    },
  ])("forwards $method unchanged and relays backend errors", async ({ method, params }) => {
    const fixture = createFixture();
    try {
      await fixture.ready;
      const request = { id: 1, method, params };
      writeRequest(fixture.desktopInput, request);
      expect(await readJsonLine(fixture.official.stdin)).toEqual(request);
      const response = { id: 1, error: { code: -32601, message: "Synthetic backend error" } };
      writeRequest(fixture.official.stdout, response);
      expect(await fixture.collector.waitFor((message) => requestId(message, 1))).toEqual(response);
    } finally {
      await stopFixture(fixture);
    }
  });
});

describe("AppServerHost HarnessAdapter projection", () => {
  it.each([false, true])("preserves native auth with account management=%s", async (managed) => {
    const accountControl = Object.assign(
      new SingleNativeCodexAccount(() => ({
        version: 2,
        currentAccountId: null,
        phase: "ready",
        revision: 7,
        accounts: [],
      })),
      {
        refresh: vi.fn(async () => {
          throw new Error("synthetic identity refresh failure");
        }),
      },
    );
    const fixture = createFixture(managed ? { accountControl } : {});
    try {
      await fixture.ready;
      const requests: JsonObject[] = [
        { id: 903, method: "account/logout" },
        { id: 904, method: "account/logout", params: null },
        { id: 905, method: "account/logout", params: {} },
        { id: 906, method: "account/login/start", params: { type: "chatgpt", futureField: true } },
        { id: 907, method: "account/login/start", params: { type: "future-native-mode" } },
        {
          id: 908,
          method: "account/login/cancel",
          params: { loginId: "native-id", futureField: 1 },
        },
        { id: 909, method: "account/login/future", params: {} },
        { id: 910, method: "account/login/start" },
        { id: 911, method: "account/logout", params: false },
        { id: 913, method: "account/logout", params: [] },
        { id: 914, method: "account/login/cancel" },
      ];
      for (const request of requests) {
        writeRequest(fixture.desktopInput, request);
        expect(await readJsonLine(fixture.official.stdin)).toEqual(request);
        const response =
          request.id === 906
            ? {
                id: request.id,
                result: { type: "chatgpt", loginId: "native-id", futureField: "kept" },
              }
            : request.id === 908
              ? { id: request.id, result: { status: "canceled", futureField: true } }
              : request.id === 907 || request.id === 910 || request.id === 911
                ? {
                    id: request.id,
                    error: {
                      code: -32602,
                      message: "native rejection",
                      data: { futureField: true },
                    },
                  }
                : { id: request.id, result: {} };
        fixture.official.stdout.write(`${JSON.stringify(response)}\n`);
        expect(await fixture.collector.waitFor((message) => message.id === request.id)).toEqual(
          response,
        );
      }
      for (const notification of [
        {
          method: "account/login/completed",
          params: { loginId: "native-id", success: true, futureField: true },
        },
        { method: "account/updated", params: { authMode: null, futureField: "kept" } },
      ]) {
        fixture.official.stdout.write(`${JSON.stringify(notification)}\n`);
        expect(
          await fixture.collector.waitFor((message) => message.method === notification.method),
        ).toEqual(notification);
      }
      if (managed) await vi.waitFor(() => expect(accountControl.refresh).toHaveBeenCalled());
      writeRequest(fixture.desktopInput, { id: 912, method: "account/read", params: {} });
      expect(await readJsonLine(fixture.official.stdin)).toEqual({
        id: 912,
        method: "account/read",
        params: {},
      });
      fixture.official.stdout.write(`${JSON.stringify({ id: 912, result: { account: null } })}\n`);
      await expect(
        fixture.collector.waitFor((message) => message.id === 912),
      ).resolves.toMatchObject({ result: { account: null } });
    } finally {
      await stopFixture(fixture);
    }
  });

  it.each([
    "claude-in-codex/account/switch",
    "claude-in-codex/account/logout",
    "claude-in-codex/account/login/start",
    "claude-in-codex/account/login/cancel",
    "claude-in-codex/account/delete",
    "claude-in-codex/account/recover",
    "claude-in-codex/account/rate-limit-reset/consume",
  ])("forwards leftover Host account method %s as an unknown method", async (methodName) => {
    const fixture = createFixture();
    try {
      await fixture.ready;
      const request = { id: 910, method: methodName, params: { accountId: "account-b" } };
      writeRequest(fixture.desktopInput, request);
      expect(await readJsonLine(fixture.official.stdin)).toEqual(request);
      fixture.official.stdout.write(
        `${JSON.stringify({ id: 910, error: { code: -32601, message: "Method not found" } })}\n`,
      );
      await expect(fixture.collector.waitFor((message) => message.id === 910)).resolves.toEqual({
        id: 910,
        error: { code: -32601, message: "Method not found" },
      });
    } finally {
      await stopFixture(fixture);
    }
  });

  it("answers the remote Host update-status discriminator locally", async () => {
    const fixture = createFixture();
    writeRequest(fixture.desktopInput, {
      id: 24,
      method: "claude-in-codex/update/status",
      params: {},
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 24)),
    ).resolves.toMatchObject({ error: { code: -32090 } });
    await stopFixture(fixture);
  });

  it("passes Runtime connection and current Thread identity when manually creating an external Thread", async () => {
    class RecordingAdapter extends FakeHarnessAdapter {
      openedInputs: Parameters<FakeHarnessAdapter["open"]>[0][] = [];

      override async open(input: Parameters<FakeHarnessAdapter["open"]>[0]) {
        this.openedInputs.push(input);
        return super.open(input);
      }
    }
    const adapter = new RecordingAdapter(harnessIdSchema.parse("pi"));
    const fixture = createFixture({
      environment: {
        CLAUDE_IN_CODEX_CLI_PATH: "/opt/claude-in-codex",
        CLAUDE_IN_CODEX_RUNTIME_ENDPOINT: "http://127.0.0.1:43123",
        CLAUDE_IN_CODEX_RUNTIME_TOKEN: "token",
      },
      externalAdapters: new Map([["pi", adapter]]),
    });
    await startPiThread(fixture);
    expect(adapter.openedInputs[0]).toMatchObject({
      environment: {
        CLAUDE_IN_CODEX_CLI_PATH: "/opt/claude-in-codex",
        CLAUDE_IN_CODEX_RUNTIME_ENDPOINT: "http://127.0.0.1:43123",
        CLAUDE_IN_CODEX_RUNTIME_TOKEN: "token",
      },
    });
    await stopFixture(fixture);
  });

  it("continues an existing Pi Thread without requiring a Renderer Model carrier", async () => {
    const fixture = createFixture();
    const threadId = await startPiThread(fixture);
    const session = fixture.adapter.sessions[0];
    if (!session) throw new Error("Fake Pi Session was not opened");
    const effectiveModel = session.state.effectiveModel;

    writeRequest(fixture.desktopInput, {
      id: 42,
      method: "turn/start",
      params: {
        threadId,
        model: "gpt-5.6-luna",
        input: [{ type: "text", text: "existing Pi turn" }],
      },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 42)),
    ).resolves.toMatchObject({ result: { turn: { status: "inProgress" } } });
    expect(session.state.effectiveModel).toEqual(effectiveModel);
    session.succeedTurn();
    await stopFixture(fixture);
  });

  it("binds a selected Pi Model and Thinking carrier to create and later Turn routing", async () => {
    const fixture = createFixture();
    const model = fixture.adapter.catalog.models[1]?.ref;
    if (!model) throw new Error("Fake catalog has no secondary Model");
    const low = fixture.adapter.catalog.thinkingOptions.find(({ id }) => id === "low")?.id;
    if (!low) throw new Error("Fake catalog has no Low Thinking option");
    const carrier = encodeExternalTransportSelection("pi", { model: model, thinkingOptionId: low });
    const threadId = await startPiThread(fixture, carrier);

    expect(fixture.adapter.sessions[0]?.initialState).toMatchObject({
      effectiveModel: model,
      effectiveThinkingOptionId: low,
    });
    // The response names the picker entry; Thinking travels as the official reasoning effort.
    expect(
      fixture.collector.messages.find((message) => requestId(message, 1))?.result,
    ).toMatchObject({
      model: encodeExternalTransportSelection("pi", { model: model }),
      reasoningEffort: "low",
    });
    writeRequest(fixture.desktopInput, {
      id: 33,
      method: "turn/start",
      params: {
        threadId,
        model: carrier,
        input: [{ type: "text", text: "selected" }],
      },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 33)),
    ).resolves.toMatchObject({ result: { turn: { status: "inProgress" } } });
    fixture.adapter.sessions[0]?.succeedTurn();
    await stopFixture(fixture);
  });

  it("rejects malformed selected plugin carriers without forwarding or stopping Host", async () => {
    const fixture = createFixture();
    const officialWrite = vi.fn();
    fixture.official.stdin.on("data", officialWrite);

    writeRequest(fixture.desktopInput, {
      id: 34,
      method: "thread/start",
      params: { model: `${PI_NATIVE_TRANSPORT_MODEL_ID}ff`, cwd: "/synthetic" },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 34)),
    ).resolves.toMatchObject({
      error: { code: -32602, message: expect.stringContaining("Harness plugin route") },
    });
    expect(fixture.adapter.sessions).toHaveLength(0);
    expect(officialWrite).not.toHaveBeenCalled();
    await stopFixture(fixture);
  });

  it("isolates Pi and Claude Threads behind the same registered Harness path", async () => {
    const piAdapter = new FakeHarnessAdapter(harnessIdSchema.parse("pi"));
    const claudeAdapter = new FakeHarnessAdapter(harnessIdSchema.parse("claude-code"));
    const fixture = createFixture({
      externalAdapters: new Map<ExternalHarnessId, FakeHarnessAdapter>([
        ["pi", piAdapter],
        ["claude-code", claudeAdapter],
      ]),
    });
    const claudeThreadId = await startExternalThread(
      fixture,
      CLAUDE_CODE_NATIVE_TRANSPORT_MODEL_ID,
      10,
    );
    const piThreadId = await startExternalThread(fixture, PI_NATIVE_TRANSPORT_MODEL_ID, 11);
    expect(claudeThreadId).not.toBe(piThreadId);
    expect(claudeAdapter.sessions).toHaveLength(1);
    expect(piAdapter.sessions).toHaveLength(1);

    writeRequest(fixture.desktopInput, {
      id: 12,
      method: "turn/start",
      params: { threadId: claudeThreadId, input: [{ type: "text", text: "synthetic" }] },
    });
    await fixture.collector.waitFor((message) => requestId(message, 12));
    const claudeSession = claudeAdapter.sessions[0];
    if (!claudeSession) throw new Error("Fake Claude Session was not opened");
    claudeSession.appendText("claude output");
    const claudeStarted = await fixture.collector.waitFor(
      (message) =>
        method(message, "item/started") &&
        (message.params as JsonObject).threadId === claudeThreadId,
    );
    expect(claudeStarted).toBeDefined();
    claudeSession.succeedTurn();
    await fixture.collector.waitFor(
      (message) =>
        method(message, "turn/completed") &&
        (message.params as JsonObject).threadId === claudeThreadId,
    );

    expect(piAdapter.sessions[0]?.initialState.effectiveModel).toEqual(
      piAdapter.catalog.defaultModel,
    );
    expect(claudeAdapter.sessions).toHaveLength(1);
    const responseIndex = fixture.collector.messages.findIndex((message) => requestId(message, 12));
    const startedIndex = fixture.collector.messages.findIndex(
      (message) =>
        method(message, "turn/started") &&
        (message.params as JsonObject).threadId === claudeThreadId,
    );
    expect(startedIndex).toBeGreaterThan(responseIndex);
    await stopFixture(fixture);
  });

  it("keeps selected Claude Models request-scoped and projects confirmed actual state", async () => {
    const piAdapter = new FakeHarnessAdapter(harnessIdSchema.parse("pi"));
    const claudeAdapter = new FakeHarnessAdapter(harnessIdSchema.parse("claude-code"));
    const fixture = createFixture({
      externalAdapters: new Map<ExternalHarnessId, FakeHarnessAdapter>([
        ["pi", piAdapter],
        ["claude-code", claudeAdapter],
      ]),
    });
    const firstModel = claudeAdapter.catalog.models[0]?.ref;
    const secondModel = claudeAdapter.catalog.models[1]?.ref;
    if (!firstModel || !secondModel) throw new Error("Fake Claude catalog is incomplete");
    const foreignModel = piAdapter.catalog.defaultModel;
    if (!foreignModel) throw new Error("Fake Pi catalog has no default Model");

    await startExternalThread(fixture, encodeClaudeTransportModel(secondModel), 20);
    const secondThreadId = await startExternalThread(
      fixture,
      encodeClaudeTransportModel(firstModel),
      21,
    );
    expect(claudeAdapter.sessions[0]?.initialState.effectiveModel).toEqual(secondModel);
    expect(claudeAdapter.sessions[1]?.initialState.effectiveModel).toEqual(firstModel);

    writeRequest(fixture.desktopInput, {
      id: 24,
      method: "turn/start",
      params: {
        threadId: secondThreadId,
        model: encodeExternalTransportSelection("pi", { model: foreignModel }),
        input: [{ type: "text", text: "foreign" }],
      },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 24)),
    ).resolves.toMatchObject({
      error: {
        code: -32602,
        message: "Turn Model carrier does not belong to the Thread Harness",
      },
    });
    expect(claudeAdapter.sessions[1]?.state.effectiveModel).toEqual(firstModel);
    await stopFixture(fixture);
  });

  it("fails closed when a valid Claude token has no registered Adapter", async () => {
    const fixture = createFixture();
    const officialWrite = vi.fn();
    fixture.official.stdin.on("data", officialWrite);

    writeRequest(fixture.desktopInput, {
      id: 20,
      method: "thread/start",
      params: { model: CLAUDE_CODE_NATIVE_TRANSPORT_MODEL_ID, cwd: "/synthetic" },
    });

    await expect(
      fixture.collector.waitFor((message) => requestId(message, 20)),
    ).resolves.toMatchObject({
      error: { code: -32070, message: "External Harness 'claude-code' is unavailable" },
    });
    expect(officialWrite).not.toHaveBeenCalled();
    expect(fixture.adapter.sessions).toHaveLength(0);
    await stopFixture(fixture);
  });

  it("does not pass internal Harness controls to the official app-server", async () => {
    const fixture = createFixture({
      environment: {
        VISIBLE_TO_OFFICIAL: "yes",
        CLAUDE_IN_CODEX_DATA_DIR: "/synthetic/claude-in-codex-data",
        CLAUDE_IN_CODEX_ENABLE_CLAUDE_CODE: "1",
        CLAUDE_IN_CODEX_CLAUDE_COMMAND: "/synthetic/claude",
      },
    });

    await vi.waitFor(() => {
      expect(fixture.spawnOfficial).toHaveBeenCalledWith(
        "/synthetic/codex",
        ["app-server"],
        expect.objectContaining({
          env: expect.objectContaining({ VISIBLE_TO_OFFICIAL: "yes" }),
        }),
      );
    });
    await stopFixture(fixture);
  });

  it("forwards a Codex-owned interrupt without invoking Pi", async () => {
    const fixture = createFixture();
    await bindOfficialThread(fixture, "official-thread");
    fixture.official.stdin.once("data", (chunk: Buffer) => {
      const request = JSON.parse(chunk.toString("utf8")) as JsonObject;
      fixture.official.stdout.write(`${JSON.stringify({ id: request.id, result: {} })}\n`);
    });

    writeRequest(fixture.desktopInput, {
      id: 8,
      method: "turn/interrupt",
      params: { threadId: "official-thread", turnId: "official-turn" },
    });
    await expect(fixture.collector.waitFor((message) => requestId(message, 8))).resolves.toEqual({
      id: 8,
      result: {},
    });
    expect(fixture.adapter.sessions).toHaveLength(0);
    await stopFixture(fixture);
  });

  it("forwards Codex-owned history pagination without opening a Pi Session", async () => {
    const fixture = createFixture();
    await bindOfficialThread(fixture, "official-thread");
    const request = {
      id: 8,
      method: "thread/turns/list",
      params: {
        threadId: "official-thread",
        cursor: "official-cursor",
        limit: 7,
        sortDirection: "desc",
        itemsView: "summary",
        extraOfficialField: { keep: true },
      },
    };
    const forwarded = new Promise<JsonObject>((resolve) => {
      fixture.official.stdin.once("data", (chunk: Buffer) => {
        const value = JSON.parse(chunk.toString("utf8")) as JsonObject;
        resolve(value);
        fixture.official.stdout.write(`${JSON.stringify({ id: 8, result: { data: [] } })}\n`);
      });
    });

    writeRequest(fixture.desktopInput, request);
    await expect(forwarded).resolves.toEqual(request);
    await expect(fixture.collector.waitFor((message) => requestId(message, 8))).resolves.toEqual({
      id: 8,
      result: { data: [] },
    });
    expect(fixture.adapter.sessions).toHaveLength(0);
    await stopFixture(fixture);
  });

  it("forwards official Codex Usage notifications without external projection", async () => {
    const fixture = createFixture();
    const notification = {
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "official-thread",
        turnId: "official-turn",
        tokenUsage: {
          total: {
            totalTokens: 11,
            inputTokens: 5,
            cachedInputTokens: 1,
            cacheWriteInputTokens: 0,
            outputTokens: 5,
            reasoningOutputTokens: 0,
          },
          last: {
            totalTokens: 4,
            inputTokens: 4,
            cachedInputTokens: 0,
            cacheWriteInputTokens: 0,
            outputTokens: 0,
            reasoningOutputTokens: 0,
          },
          modelContextWindow: 100,
        },
      },
    };
    fixture.official.stdout.write(`${JSON.stringify(notification)}\n`);

    await expect(
      fixture.collector.waitFor((message) => method(message, "thread/tokenUsage/updated")),
    ).resolves.toEqual(notification);
    expect(fixture.adapter.sessions).toHaveLength(0);
    await stopFixture(fixture);
  });

  it("forwards Codex-owned requests without opening a Pi Session", async () => {
    const fixture = createFixture();
    await bindOfficialThread(fixture, "official-thread");
    fixture.official.stdin.once("data", (chunk: Buffer) => {
      const request = JSON.parse(chunk.toString("utf8")) as JsonObject;
      fixture.official.stdout.write(
        `${JSON.stringify({ id: request.id, result: { source: "official" } })}\n`,
      );
    });

    writeRequest(fixture.desktopInput, {
      id: 9,
      method: "thread/read",
      params: { threadId: "official-thread" },
    });
    await expect(fixture.collector.waitFor((message) => requestId(message, 9))).resolves.toEqual({
      id: 9,
      result: { source: "official" },
    });
    expect(fixture.adapter.sessions).toHaveLength(0);
    await stopFixture(fixture);
  });
});
