import { describe, expect, it, vi } from "vitest";
import { FakeHarnessAdapter } from "@claude-in-codex/harness-adapter/testing";
import { MappingStore } from "@claude-in-codex/mapping-store";
import { encodeExternalTransportSelection, type JsonObject } from "@claude-in-codex/protocol-core";
import {
  harnessIdSchema,
  harnessModelRefIdSchema,
  harnessPermissionModeCatalogSchema,
  harnessPermissionModeIdSchema,
  harnessThinkingOptionIdSchema,
  hostThreadIdSchema,
  hostTurnIdSchema,
} from "@claude-in-codex/shared-contracts";

import { tempDir } from "../../../../../tests/helpers/temp-dir.js";

import { rollbackCapableAdapter, ResumeStateRollbackAdapter } from "./fakes.js";
import {
  PI_NATIVE_TRANSPORT_MODEL_ID,
  createFixture,
  startExternalThread,
  startPiThread,
  startPiTurn,
  completePiTurn,
  stopFixture,
} from "./fixture.js";
import { method, requestId, messageParams, turnEvent, writeRequest } from "./json-rpc.js";

describe("AppServerHost HarnessAdapter projection", () => {
  it("forks external inclusive, exclusive, and tail boundaries without reusing Host Turn IDs", async () => {
    const fixture = createFixture();
    const officialWrite = vi.fn();
    fixture.official.stdin.on("data", officialWrite);
    const sourceThreadId = await startPiThread(fixture);
    const sourceTurnIds: [string, string, string] = [
      await completePiTurn(fixture, sourceThreadId, 2),
      await completePiTurn(fixture, sourceThreadId, 3),
      await completePiTurn(fixture, sourceThreadId, 4),
    ];

    const forkRequest = async (id: number, params: JsonObject): Promise<JsonObject> => {
      writeRequest(fixture.desktopInput, {
        id,
        method: "thread/fork",
        params: { threadId: sourceThreadId, ...params },
      });
      const response = await fixture.collector.waitFor((message) => requestId(message, id));
      const result = response.result as JsonObject;
      return result.thread as JsonObject;
    };

    const inclusive = await forkRequest(10, {
      lastTurnId: sourceTurnIds[0],
      cwd: "/synthetic-worktree/inclusive",
      runtimeWorkspaceRoots: ["/synthetic-worktree/inclusive", "/synthetic"],
    });
    const exclusive = await forkRequest(11, { beforeTurnId: sourceTurnIds[1] });
    const tail = await forkRequest(12, {});
    const excluded = await forkRequest(13, { excludeTurns: true });

    expect(inclusive).toMatchObject({
      forkedFromId: sourceThreadId,
      parentThreadId: null,
      cwd: "/synthetic-worktree/inclusive",
      turns: [expect.objectContaining({ status: "completed" })],
    });
    expect(exclusive.turns).toHaveLength(1);
    expect(tail.turns).toHaveLength(3);
    expect(excluded.turns).toEqual([]);
    const inclusiveTurnId = (inclusive.turns as JsonObject[])[0]?.id;
    expect(inclusiveTurnId).not.toBe(sourceTurnIds[0]);
    expect(inclusive.id).not.toBe(sourceThreadId);
    expect(exclusive.id).not.toBe(inclusive.id);

    const responseIndex = fixture.collector.messages.findIndex((message) => requestId(message, 10));
    const notificationIndex = fixture.collector.messages.findIndex(
      (message) =>
        method(message, "thread/started") &&
        (messageParams(message).thread as JsonObject | undefined)?.id === inclusive.id,
    );
    expect(notificationIndex).toBeGreaterThan(responseIndex);

    await completePiTurn(fixture, inclusive.id as string, 20, 1);
    await completePiTurn(fixture, sourceThreadId, 21, 0);
    await expect(fixture.adapter.sessions[1]?.readSnapshot()).resolves.toMatchObject({
      ok: true,
      value: { turns: [{}, {}] },
    });
    await expect(fixture.adapter.sessions[0]?.readSnapshot()).resolves.toMatchObject({
      ok: true,
      value: { turns: [{}, {}, {}, {}] },
    });
    expect(officialWrite).not.toHaveBeenCalled();
    await stopFixture(fixture);
  });

  it("forks a completed boundary while a later source Turn is still running", async () => {
    const fixture = createFixture();
    const sourceThreadId = await startPiThread(fixture);
    const completedTurnId = await completePiTurn(fixture, sourceThreadId, 2);
    const activeTurnId = await startPiTurn(fixture, sourceThreadId, 3);
    await fixture.collector.waitFor((message) => turnEvent(message, "turn/started", activeTurnId));

    writeRequest(fixture.desktopInput, {
      id: 10,
      method: "thread/fork",
      params: { threadId: sourceThreadId, lastTurnId: completedTurnId },
    });
    const response = await fixture.collector.waitFor((message) => requestId(message, 10));
    expect(response).toMatchObject({ result: { thread: { turns: [{}] } } });
    expect(fixture.adapter.sessions).toHaveLength(2);

    const sourceSession = fixture.adapter.sessions[0];
    if (!sourceSession) throw new Error("Fake source Session was not opened");
    sourceSession.succeedTurn();
    await fixture.collector.waitFor((message) =>
      turnEvent(message, "turn/completed", activeTurnId),
    );
    await expect(sourceSession.readSnapshot()).resolves.toMatchObject({
      ok: true,
      value: { turns: [{}, {}] },
    });
    await stopFixture(fixture);
  });

  it("uses only completed source Turns for tail Fork and Desktop rollback while running", async () => {
    const fixture = createFixture();
    const sourceThreadId = await startPiThread(fixture);
    await completePiTurn(fixture, sourceThreadId, 2);
    await completePiTurn(fixture, sourceThreadId, 3);
    await completePiTurn(fixture, sourceThreadId, 4);
    const activeTurnId = await startPiTurn(fixture, sourceThreadId, 5);
    await fixture.collector.waitFor((message) => turnEvent(message, "turn/started", activeTurnId));

    writeRequest(fixture.desktopInput, {
      id: 10,
      method: "thread/fork",
      params: { threadId: sourceThreadId },
    });
    const forkResponse = await fixture.collector.waitFor((message) => requestId(message, 10));
    expect(forkResponse).toMatchObject({ result: { thread: { turns: [{}, {}, {}] } } });
    const derivedId = ((forkResponse.result as JsonObject).thread as JsonObject).id;
    if (typeof derivedId !== "string") throw new Error("Fork response has no derived Thread ID");

    writeRequest(fixture.desktopInput, {
      id: 11,
      method: "thread/rollback",
      params: { threadId: derivedId, numTurns: 3 },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 11)),
    ).resolves.toMatchObject({ result: { thread: { id: derivedId, turns: [{}] } } });

    const sourceSession = fixture.adapter.sessions[0];
    if (!sourceSession) throw new Error("Fake source Session was not opened");
    sourceSession.succeedTurn();
    await fixture.collector.waitFor((message) =>
      turnEvent(message, "turn/completed", activeTurnId),
    );
    await expect(sourceSession.readSnapshot()).resolves.toMatchObject({
      ok: true,
      value: { turns: [{}, {}, {}, {}] },
    });
    await stopFixture(fixture);
  });

  it("rejects a running source that has no completed Fork Checkpoint", async () => {
    const fixture = createFixture();
    const sourceThreadId = await startPiThread(fixture);
    const activeTurnId = await startPiTurn(fixture, sourceThreadId, 2);
    await fixture.collector.waitFor((message) => turnEvent(message, "turn/started", activeTurnId));

    writeRequest(fixture.desktopInput, {
      id: 10,
      method: "thread/fork",
      params: { threadId: sourceThreadId },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 10)),
    ).resolves.toMatchObject({
      error: { code: -32080, message: "External Fork Checkpoint is unavailable" },
    });
    expect(fixture.adapter.sessions).toHaveLength(1);

    const sourceSession = fixture.adapter.sessions[0];
    if (!sourceSession) throw new Error("Fake source Session was not opened");
    sourceSession.succeedTurn();
    await fixture.collector.waitFor((message) =>
      turnEvent(message, "turn/completed", activeTurnId),
    );
    await stopFixture(fixture);
  });

  it("opens a side chat on a running source that has no completed Fork Checkpoint", async () => {
    const fixture = createFixture();
    const sourceThreadId = await startPiThread(fixture);
    const activeTurnId = await startPiTurn(fixture, sourceThreadId, 2);
    await fixture.collector.waitFor((message) => turnEvent(message, "turn/started", activeTurnId));

    writeRequest(fixture.desktopInput, {
      id: 10,
      method: "thread/fork",
      params: { threadId: sourceThreadId, ephemeral: true, excludeTurns: true },
    });
    const forkResponse = await fixture.collector.waitFor((message) => requestId(message, 10));
    expect(forkResponse).toMatchObject({ result: { thread: { ephemeral: true, turns: [] } } });
    const derivedId = ((forkResponse.result as JsonObject).thread as JsonObject).id;
    expect(derivedId).not.toBe(sourceThreadId);
    expect(fixture.adapter.sessions).toHaveLength(2);

    const sourceSession = fixture.adapter.sessions[0];
    if (!sourceSession) throw new Error("Fake source Session was not opened");
    sourceSession.succeedTurn();
    await fixture.collector.waitFor((message) =>
      turnEvent(message, "turn/completed", activeTurnId),
    );
    await stopFixture(fixture);
  });

  it("rolls back the current External Thread by exactly one Turn", async () => {
    const adapter = rollbackCapableAdapter();
    const fixture = createFixture({ externalAdapters: new Map([["pi", adapter]]) });
    const officialWrite = vi.fn();
    fixture.official.stdin.on("data", officialWrite);
    const threadId = await startPiThread(fixture);
    const firstTurnId = await completePiTurn(fixture, threadId, 2);
    await completePiTurn(fixture, threadId, 3);
    const before = await fixture.mappingStore.getThread(hostThreadIdSchema.parse(threadId));

    writeRequest(fixture.desktopInput, {
      id: 10,
      method: "thread/rollback",
      params: { threadId, numTurns: 1 },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 10)),
    ).resolves.toMatchObject({
      result: { thread: { id: threadId, turns: [{ id: firstTurnId }] } },
    });
    await expect(
      fixture.mappingStore.getThread(hostThreadIdSchema.parse(threadId)),
    ).resolves.toMatchObject({
      hostThreadId: threadId,
      nativeSessionRef: { nativeSessionId: "fake-session-2" },
      transportModelId: before?.transportModelId,
      turnMappings: [{ hostTurnId: firstTurnId }],
    });
    expect(adapter.sessions[1]?.initialState).toMatchObject({
      effectiveModel: adapter.sessions[0]?.state.effectiveModel,
      effectiveThinkingOptionId: adapter.sessions[0]?.state.effectiveThinkingOptionId,
    });
    await expect(adapter.sessions[0]?.readSnapshot()).resolves.toMatchObject({
      ok: false,
      error: { code: "invalidState" },
    });
    await completePiTurn(fixture, threadId, 11, 1);
    expect(officialWrite).not.toHaveBeenCalled();
    await stopFixture(fixture);
  });

  it("restores configuration before reading a resume-state rollback replacement", async () => {
    const permissionModes = harnessPermissionModeCatalogSchema.parse({
      modes: [
        { id: "default", label: "Default" },
        { id: "auto", label: "Auto" },
      ],
      defaultModeId: "default",
    });
    const adapter = new ResumeStateRollbackAdapter(
      harnessIdSchema.parse("pi"),
      undefined,
      true,
      true,
      null,
      permissionModes,
      true,
    );
    const fixture = createFixture({ externalAdapters: new Map([["pi", adapter]]) });
    const threadId = await startPiThread(fixture);
    const model = adapter.catalog.models[1]?.ref;
    if (!model) throw new Error("Fake catalog has no secondary Model");
    const thinkingOptionId = harnessThinkingOptionIdSchema.parse("low");
    const permissionModeId = harnessPermissionModeIdSchema.parse("auto");
    const configured = adapter.sessions[0];
    if (!configured) throw new Error("Fake Pi Session was not opened");
    await configured.execute({ type: "model.select", model });
    await configured.execute({ type: "thinking.select", thinkingOptionId });
    await configured.execute({ type: "permissionMode.select", permissionModeId });

    const firstTurnId = await completePiTurn(fixture, threadId, 43);
    await completePiTurn(fixture, threadId, 44);
    writeRequest(fixture.desktopInput, {
      id: 45,
      method: "thread/rollback",
      params: { threadId, numTurns: 1 },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 45)),
    ).resolves.toMatchObject({
      result: { thread: { id: threadId, turns: [{ id: firstTurnId }] } },
    });

    const expectedConfiguration = {
      effectiveModel: model,
      effectiveThinkingOptionId: thinkingOptionId,
      effectivePermissionModeId: permissionModeId,
    };
    expect(adapter.rollbackReplacementStateAtFirstRead).toMatchObject(expectedConfiguration);
    expect(adapter.sessions[1]?.state).toMatchObject(expectedConfiguration);
    await stopFixture(fixture);
  });

  it("reverts the latest completed Turn of a paginated External Thread", async () => {
    const adapter = rollbackCapableAdapter();
    const fixture = createFixture({ externalAdapters: new Map([["pi", adapter]]) });
    const officialWrite = vi.fn();
    fixture.official.stdin.on("data", officialWrite);
    const threadId = await startExternalThread(fixture, PI_NATIVE_TRANSPORT_MODEL_ID, 1, {
      historyMode: "paginated",
    });
    const firstTurnId = await completePiTurn(fixture, threadId, 2);
    const lastTurnId = await completePiTurn(fixture, threadId, 3);

    writeRequest(fixture.desktopInput, {
      id: 10,
      method: "thread/revert",
      params: { threadId, beforeTurnId: lastTurnId },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 10)),
    ).resolves.toMatchObject({ result: { thread: { id: threadId, turns: [] } } });
    await expect(
      fixture.collector.waitFor((message) => method(message, "thread/reverted")),
    ).resolves.toEqual({ method: "thread/reverted", params: { threadId } });
    await expect(
      fixture.mappingStore.getThread(hostThreadIdSchema.parse(threadId)),
    ).resolves.toMatchObject({
      nativeSessionRef: { nativeSessionId: "fake-session-2" },
      turnMappings: [{ hostTurnId: firstTurnId }],
    });
    expect(adapter.sessions).toHaveLength(2);
    expect(officialWrite).not.toHaveBeenCalled();
    await stopFixture(fixture);
  });

  it("rejects a stale paginated Revert boundary without changing history", async () => {
    const adapter = rollbackCapableAdapter();
    const fixture = createFixture({ externalAdapters: new Map([["pi", adapter]]) });
    const threadId = await startExternalThread(fixture, PI_NATIVE_TRANSPORT_MODEL_ID, 1, {
      historyMode: "paginated",
    });
    await completePiTurn(fixture, threadId, 2);
    const before = await fixture.mappingStore.getThread(hostThreadIdSchema.parse(threadId));

    writeRequest(fixture.desktopInput, {
      id: 10,
      method: "thread/revert",
      params: { threadId, beforeTurnId: "stale-turn" },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 10)),
    ).resolves.toMatchObject({ error: { code: -32080 } });
    await expect(
      fixture.mappingStore.getThread(hostThreadIdSchema.parse(threadId)),
    ).resolves.toEqual(before);
    expect(adapter.sessions).toHaveLength(1);
    await stopFixture(fixture);
  });

  it("rolls the only current External Turn back to empty history", async () => {
    const adapter = rollbackCapableAdapter();
    const fixture = createFixture({ externalAdapters: new Map([["pi", adapter]]) });
    const threadId = await startPiThread(fixture);
    await completePiTurn(fixture, threadId, 2);

    writeRequest(fixture.desktopInput, {
      id: 10,
      method: "thread/rollback",
      params: { threadId, numTurns: 1 },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 10)),
    ).resolves.toMatchObject({ result: { thread: { id: threadId, turns: [] } } });
    await expect(
      fixture.mappingStore.getThread(hostThreadIdSchema.parse(threadId)),
    ).resolves.toMatchObject({
      nativeSessionRef: { nativeSessionId: "fake-session-2" },
      turnMappings: [],
    });
    await completePiTurn(fixture, threadId, 11, 1);
    await stopFixture(fixture);
  });

  it("rejects current last-Turn rollback while active or for multiple Turns", async () => {
    const adapter = rollbackCapableAdapter();
    const fixture = createFixture({ externalAdapters: new Map([["pi", adapter]]) });
    const threadId = await startPiThread(fixture);
    await completePiTurn(fixture, threadId, 2);

    writeRequest(fixture.desktopInput, {
      id: 10,
      method: "thread/rollback",
      params: { threadId, numTurns: 2 },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 10)),
    ).resolves.toMatchObject({ error: { code: -32076 } });

    const activeTurnId = await startPiTurn(fixture, threadId, 11);
    writeRequest(fixture.desktopInput, {
      id: 12,
      method: "thread/rollback",
      params: { threadId, numTurns: 1 },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 12)),
    ).resolves.toMatchObject({ error: { code: -32072 } });
    expect(adapter.sessions).toHaveLength(1);
    adapter.sessions[0]?.succeedTurn();
    await fixture.collector.waitFor((message) =>
      turnEvent(message, "turn/completed", activeTurnId),
    );
    await stopFixture(fixture);
  });

  it("keeps the current Session authoritative when last-Turn persistence fails", async () => {
    const directory = await tempDir("claude-in-codex-host-last-turn-failure-");
    let failRollbackCommit = false;
    const mappingStore = new MappingStore({
      directory,
      beforeReplace(record) {
        if (failRollbackCommit && record.state === "ready" && record.turnMappings.length === 1) {
          throw new Error("synthetic last-Turn rollback failure");
        }
      },
    });
    const adapter = rollbackCapableAdapter();
    const fixture = createFixture({
      externalAdapters: new Map([["pi", adapter]]),
      mappingStore,
      mappingStoreDirectory: directory,
    });
    const threadId = await startPiThread(fixture);
    await completePiTurn(fixture, threadId, 2);
    await completePiTurn(fixture, threadId, 3);
    const before = await mappingStore.getThread(hostThreadIdSchema.parse(threadId));
    failRollbackCommit = true;

    writeRequest(fixture.desktopInput, {
      id: 10,
      method: "thread/rollback",
      params: { threadId, numTurns: 1 },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 10)),
    ).resolves.toMatchObject({ error: { code: -32081 } });
    await expect(mappingStore.getThread(hostThreadIdSchema.parse(threadId))).resolves.toEqual(
      before,
    );
    await expect(adapter.sessions[0]?.readSnapshot()).resolves.toMatchObject({
      ok: true,
      value: { turns: [{}, {}] },
    });
    await expect(adapter.sessions[1]?.readSnapshot()).resolves.toMatchObject({
      ok: false,
      error: { code: "invalidState" },
    });
    await completePiTurn(fixture, threadId, 11, 0);
    await stopFixture(fixture);
  });

  it("realizes Desktop Worktree tail-Fork plus rollback as one exact derived prefix", async () => {
    const fixture = createFixture();
    const officialWrite = vi.fn();
    fixture.official.stdin.on("data", officialWrite);
    const sourceThreadId = await startPiThread(fixture);
    const sourceTurnIds = [
      await completePiTurn(fixture, sourceThreadId, 2),
      await completePiTurn(fixture, sourceThreadId, 3),
      await completePiTurn(fixture, sourceThreadId, 4),
    ];

    writeRequest(fixture.desktopInput, {
      id: 10,
      method: "thread/fork",
      params: {
        threadId: sourceThreadId,
        cwd: "/synthetic-worktree",
        runtimeWorkspaceRoots: ["/synthetic-worktree", "/synthetic"],
      },
    });
    const forkResponse = await fixture.collector.waitFor((message) => requestId(message, 10));
    expect(forkResponse.result).toMatchObject({
      cwd: "/synthetic-worktree",
      runtimeWorkspaceRoots: ["/synthetic-worktree", "/synthetic"],
    });
    const forkedThread = (forkResponse.result as JsonObject).thread as JsonObject;
    const derivedId = forkedThread.id;
    const initialDerivedTurns = forkedThread.turns as JsonObject[];
    if (typeof derivedId !== "string") throw new Error("Tail Fork response has no Thread ID");
    expect(forkedThread.cwd).toBe("/synthetic-worktree");
    expect(initialDerivedTurns).toHaveLength(3);

    writeRequest(fixture.desktopInput, {
      id: 11,
      method: "thread/rollback",
      params: { threadId: derivedId, numTurns: 2 },
    });
    const rollbackResponse = await fixture.collector.waitFor((message) => requestId(message, 11));
    const rolledBack = (rollbackResponse.result as JsonObject).thread as JsonObject;
    expect(rolledBack).toMatchObject({
      id: derivedId,
      forkedFromId: sourceThreadId,
      turns: [{ id: initialDerivedTurns[0]?.id, status: "completed" }],
    });
    const derivedRecord = await fixture.mappingStore.getThread(hostThreadIdSchema.parse(derivedId));
    expect(derivedRecord).toMatchObject({
      nativeSessionRef: { nativeSessionId: "fake-session-3" },
      cwd: "/synthetic-worktree",
      forkSource: { hostThreadId: sourceThreadId, hostTurnId: sourceTurnIds[0] },
      turnMappings: [
        {
          hostTurnId: initialDerivedTurns[0]?.id,
          nativeTurnRef: { nativeSessionId: "fake-session-3" },
          nativeCheckpointRef: { nativeSessionId: "fake-session-3" },
        },
      ],
    });
    expect(fixture.adapter.sessions[0]?.cwd).toBe("/synthetic");
    expect(fixture.adapter.sessions[1]?.cwd).toBe("/synthetic-worktree");
    expect(fixture.adapter.sessions[2]?.cwd).toBe("/synthetic-worktree");
    await expect(fixture.adapter.sessions[1]?.readSnapshot()).resolves.toMatchObject({
      ok: false,
      error: { code: "invalidState" },
    });
    await expect(fixture.adapter.sessions[0]?.readSnapshot()).resolves.toMatchObject({
      ok: true,
      value: { turns: [{}, {}, {}] },
    });

    await completePiTurn(fixture, derivedId, 20, 2);
    await completePiTurn(fixture, sourceThreadId, 21, 0);
    await expect(fixture.adapter.sessions[2]?.readSnapshot()).resolves.toMatchObject({
      ok: true,
      value: { turns: [{}, {}] },
    });
    await expect(fixture.adapter.sessions[0]?.readSnapshot()).resolves.toMatchObject({
      ok: true,
      value: { turns: [{}, {}, {}, {}] },
    });
    expect(officialWrite).not.toHaveBeenCalled();
    await stopFixture(fixture);
  });

  it("rejects rollback when an external Thread is not an untouched derived prefix", async () => {
    const fixture = createFixture();
    const officialWrite = vi.fn();
    fixture.official.stdin.on("data", officialWrite);
    const sourceThreadId = await startPiThread(fixture);
    await completePiTurn(fixture, sourceThreadId, 2);
    await completePiTurn(fixture, sourceThreadId, 3);

    writeRequest(fixture.desktopInput, {
      id: 10,
      method: "thread/rollback",
      params: { threadId: sourceThreadId, numTurns: 1 },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 10)),
    ).resolves.toMatchObject({ error: { code: -32076 } });

    writeRequest(fixture.desktopInput, {
      id: 11,
      method: "thread/fork",
      params: { threadId: sourceThreadId },
    });
    const forkResponse = await fixture.collector.waitFor((message) => requestId(message, 11));
    const derivedId = ((forkResponse.result as JsonObject).thread as JsonObject).id;
    if (typeof derivedId !== "string") throw new Error("Tail Fork response has no Thread ID");
    await completePiTurn(fixture, derivedId, 12, 1);

    writeRequest(fixture.desktopInput, {
      id: 13,
      method: "thread/rollback",
      params: { threadId: derivedId, numTurns: 1 },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 13)),
    ).resolves.toMatchObject({ error: { code: -32076 } });
    expect(fixture.adapter.sessions).toHaveLength(2);
    expect(officialWrite).not.toHaveBeenCalled();
    await stopFixture(fixture);
  });

  it("commits excluded Fork mappings before a later thread/read", async () => {
    const fixture = createFixture();
    const sourceThreadId = await startPiThread(fixture);
    await completePiTurn(fixture, sourceThreadId, 2);
    await completePiTurn(fixture, sourceThreadId, 3);

    writeRequest(fixture.desktopInput, {
      id: 10,
      method: "thread/fork",
      params: { threadId: sourceThreadId, excludeTurns: true },
    });
    const forked = await fixture.collector.waitFor((message) => requestId(message, 10));
    const derivedId = ((forked.result as JsonObject).thread as JsonObject).id;
    if (typeof derivedId !== "string") throw new Error("Fork response has no derived Thread ID");
    writeRequest(fixture.desktopInput, {
      id: 11,
      method: "thread/read",
      params: { threadId: derivedId, includeTurns: true },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 11)),
    ).resolves.toMatchObject({ result: { thread: { turns: [{}, {}] } } });
    await stopFixture(fixture);
  });

  it("restores Store-owned external read, resume, and Fork on demand", async () => {
    const directory = await tempDir("claude-in-codex-host-restart-test-");
    const adapter = new FakeHarnessAdapter(
      harnessIdSchema.parse("pi"),
      undefined,
      undefined,
      undefined,
      { totalTokens: 77, contextUsedTokens: 33, contextWindowTokens: 200 },
    );
    const opened = await adapter.open({ kind: "create", cwd: "/persisted" });
    if (!opened.ok) throw new Error(opened.error.message);
    const source = opened.value;
    const persistedTurnId = hostTurnIdSchema.parse("persisted-turn");
    await source.execute({
      type: "turn.start",
      turnId: persistedTurnId,
      input: [{ type: "text", text: "persisted question" }],
    });
    const fakeSource = adapter.sessions[0];
    if (!fakeSource) throw new Error("Fake persisted Session was not opened");
    fakeSource.appendText("persisted answer");
    fakeSource.succeedTurn();
    const snapshot = await source.readSnapshot();
    if (!snapshot.ok || !source.initialState.nativeRef || !snapshot.value.turns[0]) {
      throw new Error("Fake persisted Snapshot was not created");
    }

    const threadId = hostThreadIdSchema.parse("persisted-thread");
    const store = new MappingStore({ directory });
    await store.initialize();
    await store.createProvisional({
      hostThreadId: threadId,
      createRequestId: "persisted-create",
      harnessId: adapter.harnessId,
      cwd: "/persisted",
      title: "Persisted Pi",
      transportModelId: PI_NATIVE_TRANSPORT_MODEL_ID,
      ephemeral: false,
      historyMode: "legacy",
    });
    await store.commitReady({
      hostThreadId: threadId,
      nativeSessionRef: source.initialState.nativeRef,
      turnMappings: [
        {
          hostTurnId: persistedTurnId,
          nativeTurnRef: snapshot.value.turns[0].nativeTurnRef,
          nativeCheckpointRef: snapshot.value.turns[0].checkpoint,
        },
      ],
    });
    await store.close();

    const restoredModel = adapter.catalog.models[1]?.ref;
    if (!restoredModel) throw new Error("Fake Adapter has no restored Model");
    fakeSource.setStateForSnapshot({
      ...fakeSource.state,
      effectiveModel: restoredModel,
      resolvedModelLabel: "Fake Secondary",
    });

    const fixture = createFixture({
      externalAdapters: new Map([["pi", adapter]]),
      mappingStoreDirectory: directory,
    });
    const officialWrite = vi.fn();
    fixture.official.stdin.on("data", officialWrite);
    writeRequest(fixture.desktopInput, {
      id: 60,
      method: "thread/read",
      params: { threadId, includeTurns: true },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 60)),
    ).resolves.toMatchObject({
      result: {
        thread: {
          id: threadId,
          name: "Persisted Pi",
          turns: [{ id: persistedTurnId, status: "completed" }],
        },
      },
    });
    const restoredUsage = await fixture.collector.waitFor((message) =>
      method(message, "thread/tokenUsage/updated"),
    );
    expect(restoredUsage).toMatchObject({
      params: {
        threadId,
        turnId: persistedTurnId,
        tokenUsage: { total: { totalTokens: 77 }, modelContextWindow: 200 },
      },
    });
    expect(fixture.collector.messages.indexOf(restoredUsage)).toBeGreaterThan(
      fixture.collector.messages.findIndex((message) => requestId(message, 60)),
    );
    expect(fakeSource.snapshotReads).toBe(2);

    writeRequest(fixture.desktopInput, {
      id: 64,
      method: "claude-in-codex/thread/usage/inspect",
      params: { threadId },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 64)),
    ).resolves.toMatchObject({
      result: {
        threadId,
        usage: {
          totalTokens: 77,
          contextUsedTokens: 33,
          contextWindowTokens: 200,
        },
      },
    });

    writeRequest(fixture.desktopInput, {
      id: 61,
      method: "thread/resume",
      params: { threadId },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 61)),
    ).resolves.toMatchObject({
      result: {
        thread: { id: threadId, turns: [{ id: persistedTurnId }] },
        model: encodeExternalTransportSelection("pi", {
          model: { id: harnessModelRefIdSchema.parse("fake-model-v1.secondary") },
        }),
        initialTurnsPage: null,
      },
    });

    writeRequest(fixture.desktopInput, {
      id: 62,
      method: "thread/fork",
      params: {
        threadId,
        lastTurnId: persistedTurnId,
        cwd: "/persisted-worktree",
        runtimeWorkspaceRoots: ["/persisted-worktree", "/persisted"],
      },
    });
    const restartedFork = await fixture.collector.waitFor((message) => requestId(message, 62));
    expect(restartedFork).toMatchObject({
      result: {
        cwd: "/persisted-worktree",
        thread: {
          id: expect.not.stringMatching(/^persisted-thread$/u),
          cwd: "/persisted-worktree",
          forkedFromId: threadId,
          turns: [{ status: "completed" }],
        },
      },
    });
    const restartedDerivedId = ((restartedFork.result as JsonObject).thread as JsonObject).id;
    if (typeof restartedDerivedId !== "string") throw new Error("Restarted Fork has no ID");
    await expect(
      fixture.mappingStore.getThread(hostThreadIdSchema.parse(restartedDerivedId)),
    ).resolves.toMatchObject({ cwd: "/persisted-worktree" });
    expect(officialWrite).not.toHaveBeenCalled();
    await stopFixture(fixture);
  });

  it("tail-Forks the latest completed Checkpoint while the source Turn is active", async () => {
    const fixture = createFixture();
    const officialWrite = vi.fn();
    fixture.official.stdin.on("data", officialWrite);
    const threadId = await startPiThread(fixture);
    await completePiTurn(fixture, threadId, 2);
    const activeTurnId = await startPiTurn(fixture, threadId, 3);

    writeRequest(fixture.desktopInput, {
      id: 10,
      method: "thread/fork",
      params: { threadId },
    });
    const forkResponse = await fixture.collector.waitFor((message) => requestId(message, 10));
    expect(forkResponse).toMatchObject({ result: { thread: { turns: [{}] } } });
    const derivedId = ((forkResponse.result as JsonObject).thread as JsonObject).id;
    if (typeof derivedId !== "string") throw new Error("Fork response has no derived Thread ID");

    writeRequest(fixture.desktopInput, {
      id: 11,
      method: "thread/rollback",
      params: { threadId: derivedId, numTurns: 1 },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 11)),
    ).resolves.toMatchObject({ result: { thread: { id: derivedId, turns: [{}] } } });
    expect(fixture.adapter.sessions).toHaveLength(2);
    expect(officialWrite).not.toHaveBeenCalled();

    const source = fixture.adapter.sessions[0];
    source?.appendText("done");
    source?.succeedTurn();
    await fixture.collector.waitFor((message) =>
      turnEvent(message, "turn/completed", activeTurnId),
    );
    await stopFixture(fixture);
  });

  it("rejects unsafe external Fork overrides without official fallback", async () => {
    const fixture = createFixture();
    const officialWrite = vi.fn();
    fixture.official.stdin.on("data", officialWrite);
    const threadId = await startPiThread(fixture);
    const firstTurnId = await completePiTurn(fixture, threadId, 2);

    const invalidForks: Array<{ id: number; params: JsonObject; code: number }> = [
      { id: 10, params: { path: "/another/session.jsonl" }, code: -32602 },
      { id: 11, params: { beforeTurnId: firstTurnId }, code: -32080 },
      { id: 12, params: { lastTurnId: "unknown-turn" }, code: -32080 },
      {
        id: 13,
        params: { lastTurnId: firstTurnId, beforeTurnId: firstTurnId },
        code: -32602,
      },
      { id: 14, params: { cwd: "relative-worktree" }, code: -32602 },
      {
        id: 15,
        params: { cwd: "/worktree", runtimeWorkspaceRoots: ["relative-root"] },
        code: -32602,
      },
      {
        id: 16,
        params: { cwd: "/worktree", runtimeWorkspaceRoots: ["/source-only"] },
        code: -32602,
      },
    ];
    for (const invalid of invalidForks) {
      writeRequest(fixture.desktopInput, {
        id: invalid.id,
        method: "thread/fork",
        params: { threadId, ...invalid.params },
      });
      await expect(
        fixture.collector.waitFor((message) => requestId(message, invalid.id)),
      ).resolves.toMatchObject({ error: { code: invalid.code } });
    }
    expect(fixture.adapter.sessions).toHaveLength(1);
    expect(officialWrite).not.toHaveBeenCalled();
    await stopFixture(fixture);
  });

  it("rejects a changed Fork cwd when the Adapter supports only source-cwd Fork", async () => {
    const adapter = new FakeHarnessAdapter(harnessIdSchema.parse("pi"), undefined, true, false);
    const fixture = createFixture({ externalAdapters: new Map([["pi", adapter]]) });
    const officialWrite = vi.fn();
    fixture.official.stdin.on("data", officialWrite);
    const threadId = await startPiThread(fixture);
    await completePiTurn(fixture, threadId, 2);

    writeRequest(fixture.desktopInput, {
      id: 10,
      method: "thread/fork",
      params: {
        threadId,
        cwd: "/synthetic-worktree",
        runtimeWorkspaceRoots: ["/synthetic-worktree"],
      },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 10)),
    ).resolves.toMatchObject({ error: { code: -32076 } });
    expect(adapter.sessions).toHaveLength(1);
    expect(officialWrite).not.toHaveBeenCalled();
    await stopFixture(fixture);
  });

  it("projects a failed terminal when live Turn identity persistence fails", async () => {
    const directory = await tempDir("claude-in-codex-host-write-failure-");
    let failTurnCommit = false;
    const mappingStore = new MappingStore({
      directory,
      beforeReplace(record) {
        if (failTurnCommit && record.turnMappings.length > 0) {
          throw new Error("synthetic terminal commit failure");
        }
      },
    });
    const fixture = createFixture({ mappingStore, mappingStoreDirectory: directory });
    const threadId = await startPiThread(fixture);
    failTurnCommit = true;
    const turnId = await startPiTurn(fixture, threadId, 2);
    const session = fixture.adapter.sessions[0];
    if (!session) throw new Error("Fake Pi Session was not opened");
    session.appendText("native success");
    session.succeedTurn();

    await expect(
      fixture.collector.waitFor((message) => turnEvent(message, "turn/completed", turnId)),
    ).resolves.toMatchObject({
      params: {
        turn: { status: "failed", error: { message: expect.stringContaining("persisted") } },
      },
    });
    await expect(mappingStore.getThread(hostThreadIdSchema.parse(threadId))).resolves.toMatchObject(
      {
        turnMappings: [],
      },
    );
    await stopFixture(fixture);
  });

  it("closes and hides a derived runtime when Fork commit fails", async () => {
    const directory = await tempDir("claude-in-codex-host-fork-failure-");
    let failForkCommit = false;
    const mappingStore = new MappingStore({
      directory,
      beforeReplace(record) {
        if (failForkCommit && record.state === "ready" && record.forkSource) {
          throw new Error("synthetic derived commit failure");
        }
      },
    });
    const fixture = createFixture({ mappingStore, mappingStoreDirectory: directory });
    const threadId = await startPiThread(fixture);
    const turnId = await completePiTurn(fixture, threadId, 2);
    failForkCommit = true;

    writeRequest(fixture.desktopInput, {
      id: 10,
      method: "thread/fork",
      params: { threadId, lastTurnId: turnId },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 10)),
    ).resolves.toMatchObject({ error: { code: -32081 } });
    await expect(fixture.adapter.sessions[1]?.readSnapshot()).resolves.toMatchObject({
      ok: false,
      error: { code: "invalidState" },
    });
    await expect(mappingStore.listThreads()).resolves.toHaveLength(1);
    await stopFixture(fixture);
  });

  it("keeps the temporary derived Session authoritative when rollback commit fails", async () => {
    const directory = await tempDir("claude-in-codex-host-rollback-failure-");
    let failRollbackCommit = false;
    const mappingStore = new MappingStore({
      directory,
      beforeReplace(record) {
        if (failRollbackCommit && record.state === "ready" && record.turnMappings.length === 1) {
          throw new Error("synthetic rollback commit failure");
        }
      },
    });
    const fixture = createFixture({ mappingStore, mappingStoreDirectory: directory });
    const sourceThreadId = await startPiThread(fixture);
    await completePiTurn(fixture, sourceThreadId, 2);
    await completePiTurn(fixture, sourceThreadId, 3);
    await completePiTurn(fixture, sourceThreadId, 4);
    writeRequest(fixture.desktopInput, {
      id: 10,
      method: "thread/fork",
      params: { threadId: sourceThreadId },
    });
    const forkResponse = await fixture.collector.waitFor((message) => requestId(message, 10));
    const derivedId = ((forkResponse.result as JsonObject).thread as JsonObject).id;
    if (typeof derivedId !== "string") throw new Error("Tail Fork response has no Thread ID");
    const before = await mappingStore.getThread(hostThreadIdSchema.parse(derivedId));
    failRollbackCommit = true;

    writeRequest(fixture.desktopInput, {
      id: 11,
      method: "thread/rollback",
      params: { threadId: derivedId, numTurns: 2 },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 11)),
    ).resolves.toMatchObject({ error: { code: -32081 } });
    await expect(mappingStore.getThread(hostThreadIdSchema.parse(derivedId))).resolves.toEqual(
      before,
    );
    await expect(fixture.adapter.sessions[2]?.readSnapshot()).resolves.toMatchObject({
      ok: false,
      error: { code: "invalidState" },
    });
    await expect(fixture.adapter.sessions[1]?.readSnapshot()).resolves.toMatchObject({
      ok: true,
      value: { turns: [{}, {}, {}] },
    });

    writeRequest(fixture.desktopInput, {
      id: 12,
      method: "thread/read",
      params: { threadId: derivedId, includeTurns: true },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 12)),
    ).resolves.toMatchObject({ result: { thread: { turns: [{}, {}, {}] } } });
    await stopFixture(fixture);
  });
});
