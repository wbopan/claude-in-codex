import { describe, expect, it, vi } from "vitest";
import { FakeHarnessAdapter } from "@claude-in-codex/harness-adapter/testing";
import { MappingStore } from "@claude-in-codex/mapping-store";
import type { JsonObject } from "@claude-in-codex/protocol-core";
import { harnessIdSchema, hostThreadIdSchema } from "@claude-in-codex/shared-contracts";

import { tempDir } from "../../../../../tests/helpers/temp-dir.js";

import { FailingArchiveMappingStore, FailingListMappingStore } from "./fakes.js";
import {
  PI_NATIVE_TRANSPORT_MODEL_ID,
  createFixture,
  startPiThread,
  startPiTurn,
  completePiTurn,
  closeFixture,
  stopFixture,
  bindOfficialThread,
} from "./fixture.js";
import {
  JsonLineCollector,
  method,
  requestId,
  turnEvent,
  writeRequest,
  readJsonLine,
} from "./json-rpc.js";

describe("AppServerHost HarnessAdapter projection", () => {
  it("aggregates official and External Thread rows through an internal official request", async () => {
    const fixture = createFixture();
    const threadId = await startPiThread(fixture);
    const session = fixture.adapter.sessions[0];
    if (!session) throw new Error("Fake Pi Session was not opened");
    const snapshotReads = session.snapshotReads;
    const internalRequest = new Promise<JsonObject>((resolve) => {
      fixture.official.stdin.once("data", (chunk: Buffer) => {
        const request = JSON.parse(chunk.toString("utf8")) as JsonObject;
        resolve(request);
        fixture.official.stdout.write(
          `${JSON.stringify({
            id: request.id,
            result: {
              data: [{ id: "official-thread", createdAt: 1, updatedAt: 1, recencyAt: 1 }],
              nextCursor: null,
              backwardsCursor: "official-backwards",
            },
          })}\n`,
        );
      });
    });

    writeRequest(fixture.desktopInput, {
      id: 45,
      method: "thread/list",
      params: { limit: 10, sortKey: "created_at", sortDirection: "desc" },
    });
    await expect(internalRequest).resolves.toMatchObject({
      method: "thread/list",
      params: { cursor: null, limit: 10, sortKey: "created_at", sortDirection: "desc" },
    });
    const response = await fixture.collector.waitFor((message) => requestId(message, 45));
    const result = response.result as JsonObject;
    const data = result.data as JsonObject[];
    expect(data.map((thread) => thread.id)).toEqual([threadId, "official-thread"]);
    expect(data[0]).toMatchObject({
      status: { type: "idle" },
      turns: [],
      preview: "",
      isPinned: false,
    });
    expect(session.snapshotReads).toBe(snapshotReads);
    expect(
      fixture.collector.messages.filter(
        (message) =>
          typeof message.id === "string" && message.id.startsWith("claude-in-codex:official:"),
      ),
    ).toEqual([]);
    await stopFixture(fixture);
  });

  it("fails the complete aggregated list when Store or official listing fails", async () => {
    const directory = await tempDir("claude-in-codex-host-test-");
    const failingStore = new FailingListMappingStore({ directory });
    const storeFailure = createFixture({
      mappingStore: failingStore,
      mappingStoreDirectory: directory,
    });
    const officialWrite = vi.fn();
    storeFailure.official.stdin.on("data", officialWrite);
    writeRequest(storeFailure.desktopInput, { id: 46, method: "thread/list", params: {} });
    await expect(
      storeFailure.collector.waitFor((message) => requestId(message, 46)),
    ).resolves.toMatchObject({ error: { code: -32082 } });
    expect(officialWrite).not.toHaveBeenCalled();
    await stopFixture(storeFailure);

    const officialFailure = createFixture();
    officialFailure.official.stdin.once("data", (chunk: Buffer) => {
      const internal = JSON.parse(chunk.toString("utf8")) as JsonObject;
      officialFailure.official.stdout.write(
        `${JSON.stringify({ id: internal.id, error: { code: -32000, message: "official failed" } })}\n`,
      );
    });
    writeRequest(officialFailure.desktopInput, { id: 47, method: "thread/list", params: {} });
    await expect(
      officialFailure.collector.waitFor((message) => requestId(message, 47)),
    ).resolves.toEqual({ id: 47, error: { code: -32000, message: "official failed" } });
    await stopFixture(officialFailure);
  });

  it("lists an unloaded External Thread after restart without restoring its Adapter", async () => {
    const first = createFixture();
    const threadId = await startPiThread(first);
    const directory = first.mappingStoreDirectory;
    await closeFixture(first);

    const restartedAdapter = new FakeHarnessAdapter(harnessIdSchema.parse("pi"));
    const restarted = createFixture({
      externalAdapters: new Map([["pi", restartedAdapter]]),
      mappingStoreDirectory: directory,
    });
    restarted.official.stdin.once("data", (chunk: Buffer) => {
      const request = JSON.parse(chunk.toString("utf8")) as JsonObject;
      restarted.official.stdout.write(
        `${JSON.stringify({
          id: request.id,
          result: { data: [], nextCursor: null, backwardsCursor: null },
        })}\n`,
      );
    });
    writeRequest(restarted.desktopInput, {
      id: 46,
      method: "thread/list",
      params: { limit: 10 },
    });
    const response = await restarted.collector.waitFor((message) => requestId(message, 46));
    const result = response.result as JsonObject;
    expect(result.data).toEqual([
      expect.objectContaining({
        id: threadId,
        status: { type: "notLoaded" },
        canAcceptDirectInput: null,
        turns: [],
      }),
    ]);
    expect(restartedAdapter.sessions).toHaveLength(0);
    await stopFixture(restarted);
  });

  it("forwards a future official Thread list filter unchanged without External injection", async () => {
    const fixture = createFixture();
    const request = {
      id: 47,
      method: "thread/list",
      params: { limit: 3, futureOfficialFilter: { keep: true } },
    };
    const forwarded = new Promise<JsonObject>((resolve) => {
      fixture.official.stdin.once("data", (chunk: Buffer) => {
        const value = JSON.parse(chunk.toString("utf8")) as JsonObject;
        resolve(value);
        fixture.official.stdout.write(
          `${JSON.stringify({ id: 47, result: { data: [], nextCursor: null } })}\n`,
        );
      });
    });
    writeRequest(fixture.desktopInput, request);
    await expect(forwarded).resolves.toEqual(request);
    await expect(fixture.collector.waitFor((message) => requestId(message, 47))).resolves.toEqual({
      id: 47,
      result: { data: [], nextCursor: null },
    });
    expect(fixture.adapter.sessions).toHaveLength(0);
    await stopFixture(fixture);
  });

  it("forwards section-position Thread lists without External aggregation or Host cursor leakage", async () => {
    const fixture = createFixture();
    await startPiThread(fixture);
    const forward = async (request: JsonObject, response: JsonObject): Promise<void> => {
      writeRequest(fixture.desktopInput, request);
      const officialRequest = await readJsonLine(fixture.official.stdin).catch((error: unknown) => {
        throw new Error(`Timed out forwarding thread/list request ${String(request.id)}`, {
          cause: error,
        });
      });
      expect(officialRequest).toEqual(request);
      fixture.official.stdout.write(`${JSON.stringify({ id: officialRequest.id, ...response })}\n`);
      await expect(
        fixture.collector.waitFor((message) => message.id === request.id),
      ).resolves.toEqual({ id: request.id, ...response });
    };

    await forward(
      {
        id: 52,
        method: "thread/list",
        params: {
          cursor: "official-section-cursor",
          limit: 5,
          sectionId: "section-1",
          sortDirection: "asc",
          sortKey: "section_position",
        },
      },
      {
        result: {
          data: [{ id: "official-second" }, { id: "official-first" }],
          nextCursor: "official-section-next",
          backwardsCursor: "official-section-backwards",
        },
      },
    );
    expect(fixture.collector.messages.find((message) => message.id === 52)?.result).toMatchObject({
      data: [{ id: "official-second" }, { id: "official-first" }],
      nextCursor: "official-section-next",
      backwardsCursor: "official-section-backwards",
    });

    for (const [id, sectionId] of [
      [53, undefined],
      [54, null],
    ] as const) {
      await forward(
        {
          id,
          method: "thread/list",
          params: {
            limit: 5,
            sortDirection: "asc",
            sortKey: "section_position",
            ...(sectionId === undefined ? {} : { sectionId }),
          },
        },
        { error: { code: -32600, message: "sectionId is required" } },
      );
    }

    const officialWrite = vi.fn();
    fixture.official.stdin.on("data", officialWrite);
    writeRequest(fixture.desktopInput, {
      id: 55,
      method: "thread/list",
      params: {
        cursor: "claude-in-codex:thread-list:v1:legacy-host-cursor",
        sectionId: "section-1",
        sortDirection: "asc",
        sortKey: "section_position",
      },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 55)),
    ).resolves.toMatchObject({
      error: { code: -32602, message: expect.stringContaining("Host cursor") },
    });
    expect(officialWrite).not.toHaveBeenCalled();
    await stopFixture(fixture);
  });

  it("archives and unarchives an active External Thread without closing its Session", async () => {
    const fixture = createFixture();
    const threadId = await startPiThread(fixture);
    const turnId = await startPiTurn(fixture, threadId, 48);
    const session = fixture.adapter.sessions[0];
    if (!session) throw new Error("Fake Pi Session was not opened");
    await fixture.collector.waitFor((message) => turnEvent(message, "turn/started", turnId));
    const before = await fixture.mappingStore.getThread(hostThreadIdSchema.parse(threadId));

    writeRequest(fixture.desktopInput, {
      id: 49,
      method: "thread/archive",
      params: { threadId },
    });
    await expect(fixture.collector.waitFor((message) => requestId(message, 49))).resolves.toEqual({
      id: 49,
      result: {},
    });
    await fixture.collector.waitFor((message) => method(message, "thread/archived"));
    await expect(
      fixture.mappingStore.getThread(hostThreadIdSchema.parse(threadId)),
    ).resolves.toMatchObject({ archived: true, nativeSessionRef: before?.nativeSessionRef });
    const archiveResponseIndex = fixture.collector.messages.findIndex(
      (message) => message.id === 49,
    );
    const archiveNotificationIndex = fixture.collector.messages.findIndex((message) =>
      method(message, "thread/archived"),
    );
    expect(archiveResponseIndex).toBeLessThan(archiveNotificationIndex);

    session.appendText("still running after archive");
    session.succeedTurn();
    await fixture.collector.waitFor((message) => turnEvent(message, "turn/completed", turnId));

    writeRequest(fixture.desktopInput, {
      id: 50,
      method: "thread/unarchive",
      params: { threadId },
    });
    const unarchive = await fixture.collector.waitFor((message) => requestId(message, 50));
    expect(unarchive).toMatchObject({
      result: { thread: { id: threadId, status: { type: "idle" }, turns: [] } },
    });
    await fixture.collector.waitFor((message) => method(message, "thread/unarchived"));
    await expect(
      fixture.mappingStore.getThread(hostThreadIdSchema.parse(threadId)),
    ).resolves.toMatchObject({ archived: false, nativeSessionRef: before?.nativeSessionRef });
    const unarchiveResponseIndex = fixture.collector.messages.findIndex(
      (message) => message.id === 50,
    );
    const unarchiveNotificationIndex = fixture.collector.messages.findIndex((message) =>
      method(message, "thread/unarchived"),
    );
    expect(unarchiveResponseIndex).toBeLessThan(unarchiveNotificationIndex);
    expect(fixture.adapter.sessions).toHaveLength(1);
    await stopFixture(fixture);
  });

  it("does not emit an archive notification when persistence fails", async () => {
    const directory = await tempDir("claude-in-codex-host-test-");
    const mappingStore = new FailingArchiveMappingStore({ directory });
    const fixture = createFixture({ mappingStore, mappingStoreDirectory: directory });
    const threadId = await startPiThread(fixture);
    writeRequest(fixture.desktopInput, {
      id: 51,
      method: "thread/archive",
      params: { threadId },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 51)),
    ).resolves.toMatchObject({ error: { code: -32081 } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fixture.collector.messages.some((message) => method(message, "thread/archived"))).toBe(
      false,
    );
    await expect(
      fixture.mappingStore.getThread(hostThreadIdSchema.parse(threadId)),
    ).resolves.toMatchObject({ archived: false });
    await stopFixture(fixture);
  });

  it("manages persisted External metadata even when its Harness is not registered", async () => {
    const directory = await tempDir("claude-in-codex-host-test-");
    const seed = new MappingStore({ directory });
    await seed.initialize();
    const threadId = hostThreadIdSchema.parse("unregistered-external");
    await seed.createProvisional({
      hostThreadId: threadId,
      createRequestId: "unregistered-create",
      harnessId: harnessIdSchema.parse("pi"),
      cwd: "/synthetic",
      transportModelId: PI_NATIVE_TRANSPORT_MODEL_ID,
      ephemeral: false,
      historyMode: "legacy",
    });
    await seed.commitReady({
      hostThreadId: threadId,
      nativeSessionRef: {
        harnessId: harnessIdSchema.parse("pi"),
        nativeSessionId: "unregistered-native",
        formatVersion: 1,
      },
    });
    await seed.close();

    const fixture = createFixture({
      externalAdapters: new Map(),
      mappingStoreDirectory: directory,
    });
    writeRequest(fixture.desktopInput, {
      id: 52,
      method: "thread/archive",
      params: { threadId },
    });
    await expect(fixture.collector.waitFor((message) => requestId(message, 52))).resolves.toEqual({
      id: 52,
      result: {},
    });
    await expect(fixture.mappingStore.getThread(threadId)).resolves.toMatchObject({
      archived: true,
    });
    await stopFixture(fixture);
  });

  it("fails External current and future metadata updates closed without official fallback", async () => {
    const fixture = createFixture();
    const officialWrite = vi.fn();
    fixture.official.stdin.on("data", officialWrite);
    const threadId = await startPiThread(fixture);
    for (const [id, patch] of [
      [53, { isPinned: true }],
      [54, { gitInfo: { branch: "main", sha: null } }],
    ] as const) {
      writeRequest(fixture.desktopInput, {
        id,
        method: "thread/metadata/update",
        params: { threadId, ...patch },
      });
      await expect(
        fixture.collector.waitFor((message) => requestId(message, id)),
      ).resolves.toMatchObject({
        error: { code: -32078, message: "External Thread metadata updates are unsupported" },
      });
    }
    writeRequest(fixture.desktopInput, {
      id: 58,
      method: "thread/future/manage",
      params: { threadId, futureMetadata: true },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 58)),
    ).resolves.toMatchObject({
      error: { code: -32076, message: "External Thread does not support thread/future/manage" },
    });
    expect(officialWrite).not.toHaveBeenCalled();
    const stored = await fixture.mappingStore.getThread(hostThreadIdSchema.parse(threadId));
    expect(stored).not.toHaveProperty("isPinned");
    expect(stored).not.toHaveProperty("gitInfo");
    await stopFixture(fixture);
  });

  it("forwards official Archive, Unarchive, and metadata updates unchanged", async () => {
    const fixture = createFixture();
    await bindOfficialThread(fixture, "official-thread");
    const officialRequests = new JsonLineCollector(fixture.official.stdin);
    const requests: JsonObject[] = [
      { id: 55, method: "thread/archive", params: { threadId: "official-thread" } },
      { id: 56, method: "thread/unarchive", params: { threadId: "official-thread" } },
      {
        id: 57,
        method: "thread/metadata/update",
        params: { threadId: "official-thread", isPinned: true },
      },
    ];
    for (const request of requests) {
      writeRequest(fixture.desktopInput, request);
      await expect(
        officialRequests.waitFor((message) => message.id === request.id),
      ).resolves.toEqual(request);
      const result = request.id === 55 ? {} : { thread: { id: "official-thread" } };
      fixture.official.stdout.write(`${JSON.stringify({ id: request.id, result })}\n`);
      await fixture.collector.waitFor((message) => message.id === request.id);
    }
    const notification = {
      method: "thread/archived",
      params: { threadId: "official-thread" },
    };
    fixture.official.stdout.write(`${JSON.stringify(notification)}\n`);
    await expect(
      fixture.collector.waitFor((message) => method(message, "thread/archived")),
    ).resolves.toEqual(notification);
    expect(fixture.adapter.sessions).toHaveLength(0);
    await stopFixture(fixture);
  });

  it("preserves the Desktop Thread persistence mode for an external Harness", async () => {
    const fixture = createFixture();
    writeRequest(fixture.desktopInput, {
      id: 1,
      method: "thread/start",
      params: {
        model: PI_NATIVE_TRANSPORT_MODEL_ID,
        cwd: "/synthetic",
        ephemeral: false,
        historyMode: "legacy",
      },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 1)),
    ).resolves.toMatchObject({
      result: {
        thread: { ephemeral: false, historyMode: "legacy", source: "vscode" },
      },
    });
    await expect(
      fixture.collector.waitFor((message) => method(message, "thread/started")),
    ).resolves.toMatchObject({
      params: {
        thread: { ephemeral: false, historyMode: "legacy", source: "vscode" },
      },
    });

    writeRequest(fixture.desktopInput, {
      id: 2,
      method: "thread/start",
      params: {
        model: PI_NATIVE_TRANSPORT_MODEL_ID,
        cwd: "/synthetic",
        ephemeral: true,
        historyMode: "paginated",
      },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 2)),
    ).resolves.toMatchObject({
      result: {
        thread: { ephemeral: true, historyMode: "paginated", source: "vscode" },
      },
    });
    await stopFixture(fixture);
  });

  it("acknowledges Desktop unsubscribe without inventing an external subscription", async () => {
    const fixture = createFixture();
    const officialWrite = vi.fn();
    fixture.official.stdin.on("data", officialWrite);
    const threadId = await startPiThread(fixture);
    await completePiTurn(fixture, threadId, 2);

    writeRequest(fixture.desktopInput, {
      id: 10,
      method: "thread/unsubscribe",
      params: { threadId },
    });
    await expect(fixture.collector.waitFor((message) => requestId(message, 10))).resolves.toEqual({
      id: 10,
      result: { status: "notSubscribed" },
    });
    await expect(fixture.adapter.sessions[0]?.readSnapshot()).resolves.toMatchObject({
      ok: true,
      value: { turns: [{}] },
    });

    writeRequest(fixture.desktopInput, {
      id: 11,
      method: "thread/resume",
      params: { threadId },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 11)),
    ).resolves.toMatchObject({ result: { thread: { id: threadId, turns: [{}] } } });
    expect(fixture.adapter.sessions).toHaveLength(1);
    expect(officialWrite).not.toHaveBeenCalled();
    await stopFixture(fixture);
  });

  it("reads and updates persisted external metadata without restoring history", async () => {
    const directory = await tempDir("claude-in-codex-host-metadata-test-");
    const adapter = new FakeHarnessAdapter(harnessIdSchema.parse("pi"));
    const opened = await adapter.open({ kind: "create", cwd: "/persisted" });
    if (!opened.ok || !opened.value.initialState.nativeRef) {
      throw new Error("Fake persisted Session was not created");
    }
    const source = adapter.sessions[0];
    if (!source) throw new Error("Fake persisted Session was not opened");
    const threadId = hostThreadIdSchema.parse("metadata-thread");
    const store = new MappingStore({ directory });
    await store.initialize();
    await store.createProvisional({
      hostThreadId: threadId,
      createRequestId: "metadata-create",
      harnessId: adapter.harnessId,
      cwd: "/persisted",
      title: "Before",
      transportModelId: PI_NATIVE_TRANSPORT_MODEL_ID,
      ephemeral: false,
      historyMode: "paginated",
    });
    await store.commitReady({
      hostThreadId: threadId,
      nativeSessionRef: opened.value.initialState.nativeRef,
    });
    await store.close();

    const fixture = createFixture({
      externalAdapters: new Map([["pi", adapter]]),
      mappingStoreDirectory: directory,
    });
    const officialWrite = vi.fn();
    fixture.official.stdin.on("data", officialWrite);

    writeRequest(fixture.desktopInput, {
      id: 51,
      method: "thread/name/set",
      params: { threadId, name: "After" },
    });
    await expect(fixture.collector.waitFor((message) => requestId(message, 51))).resolves.toEqual({
      id: 51,
      result: {},
    });

    writeRequest(fixture.desktopInput, {
      id: 52,
      method: "thread/read",
      params: { threadId, includeTurns: false },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 52)),
    ).resolves.toMatchObject({ result: { thread: { id: threadId, name: "After", turns: [] } } });
    writeRequest(fixture.desktopInput, {
      id: 53,
      method: "thread/read",
      params: { threadId, includeTurns: true },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 53)),
    ).resolves.toMatchObject({ error: { code: -32602 } });
    expect(source.snapshotReads).toBe(0);
    expect(adapter.sessions).toHaveLength(1);
    expect(officialWrite).not.toHaveBeenCalled();
    await stopFixture(fixture);
  });

  it("updates a Pi Thread name locally", async () => {
    const fixture = createFixture();
    const officialWrite = vi.fn();
    fixture.official.stdin.on("data", officialWrite);
    const threadId = await startPiThread(fixture);

    writeRequest(fixture.desktopInput, {
      id: 2,
      method: "thread/name/set",
      params: { threadId, name: "Pi Thread" },
    });

    await expect(fixture.collector.waitFor((message) => requestId(message, 2))).resolves.toEqual({
      id: 2,
      result: {},
    });
    await expect(
      fixture.collector.waitFor((message) => method(message, "thread/name/updated")),
    ).resolves.toMatchObject({ params: { threadId, threadName: "Pi Thread" } });
    writeRequest(fixture.desktopInput, {
      id: 3,
      method: "thread/read",
      params: { threadId },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 3)),
    ).resolves.toMatchObject({ result: { thread: { name: "Pi Thread" } } });
    expect(officialWrite).not.toHaveBeenCalled();
    await stopFixture(fixture);
  });

  it("deletes an unused Pi prewarm locally", async () => {
    const fixture = createFixture();
    const officialWrite = vi.fn();
    fixture.official.stdin.on("data", officialWrite);
    const threadId = await startPiThread(fixture);
    const session = fixture.adapter.sessions[0];
    if (!session) throw new Error("Fake Pi Session was not opened");
    const close = vi.spyOn(session, "close");

    writeRequest(fixture.desktopInput, {
      id: 2,
      method: "thread/delete",
      params: { threadId },
    });

    await expect(fixture.collector.waitFor((message) => requestId(message, 2))).resolves.toEqual({
      id: 2,
      result: {},
    });
    expect(close).toHaveBeenCalledOnce();
    expect(officialWrite).not.toHaveBeenCalled();
    await stopFixture(fixture);
  });
});
