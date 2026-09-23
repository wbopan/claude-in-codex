import type { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";
import type {
  HarnessAdapter,
  HarnessResult,
  HarnessSessionState,
  HostThreadSnapshot,
} from "@codexhost/harness-adapter";
import { FakeHarnessAdapter, FakeHarnessSession } from "@codexhost/harness-adapter/testing";
import { MappingStore } from "@codexhost/mapping-store";
import {
  CLAUDE_CODE_NATIVE_TRANSPORT_MODEL_ID,
  encodeClaudeTransportModel,
  type ExternalHarnessId,
  type JsonObject,
} from "@codexhost/protocol-core";
import {
  encodeHarnessPluginRoute,
  harnessPluginRouteSchema,
  harnessCommandDescriptorSchema,
  harnessIdSchema,
  harnessInspectionSchema,
  harnessPermissionModeCatalogSchema,
  harnessPermissionModeIdSchema,
  harnessThinkingOptionIdSchema,
  hostItemIdSchema,
  hostThreadIdSchema,
  hostTurnIdSchema,
} from "@codexhost/shared-contracts";

import { AppServerHost } from "../src/app-server-host.js";
import type { HarnessUsageReport } from "../src/desktop-usage-buckets.js";
import {
  SingleNativeCodexAccount,
  type CodexAccountControl,
} from "../src/account/codex-account-control.js";
import { OfficialRuntimeScope } from "../src/codex-runtime/official-runtime-scope.js";
import type { OwnedOfficialBackend } from "../src/codex-runtime/official-runtime-owner.js";
import type {
  OfficialAppServerConnection,
  OfficialAppServerExit,
} from "../src/official-app-server-connection.js";

import {
  transportModelIdForHarness,
  encodeExternalTransportSelection,
} from "@codexhost/protocol-core";

const PI_NATIVE_TRANSPORT_MODEL_ID = transportModelIdForHarness("pi");

class FakeOfficialProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly kill = vi.fn((signal: NodeJS.Signals = "SIGTERM") => {
    this.stdout.end();
    this.emit("exit", null, signal);
    return true;
  });

  constructor(exitOnInputEnd = true) {
    super();
    this.stdin.once("finish", () => {
      if (!exitOnInputEnd) return;
      this.stdout.end();
      this.emit("exit", 0, null);
    });
  }
}

class FailingArchiveMappingStore extends MappingStore {
  override setArchived(): Promise<never> {
    return Promise.reject(new Error("Synthetic archive write failure"));
  }
}

class FailingListMappingStore extends MappingStore {
  override listThreads(): Promise<never> {
    return Promise.reject(new Error("Synthetic list read failure"));
  }
}

class JsonLineCollector {
  readonly messages: JsonObject[] = [];
  readonly #waiters: Array<{
    predicate: (message: JsonObject) => boolean;
    resolve(message: JsonObject): void;
    timeout: ReturnType<typeof setTimeout>;
  }> = [];
  #buffer = "";

  constructor(stream: PassThrough) {
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      this.#buffer += chunk;
      let newline = this.#buffer.indexOf("\n");
      while (newline >= 0) {
        const message = JSON.parse(this.#buffer.slice(0, newline)) as JsonObject;
        this.#buffer = this.#buffer.slice(newline + 1);
        this.messages.push(message);
        const matched = this.#waiters.filter(({ predicate }) => predicate(message));
        for (const waiter of matched) {
          const index = this.#waiters.indexOf(waiter);
          if (index >= 0) this.#waiters.splice(index, 1);
          clearTimeout(waiter.timeout);
          waiter.resolve(message);
        }
        newline = this.#buffer.indexOf("\n");
      }
    });
  }

  waitFor(predicate: (message: JsonObject) => boolean): Promise<JsonObject> {
    const existing = this.messages.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise<JsonObject>((resolve, reject) => {
      const waiter = {
        predicate,
        resolve,
        timeout: setTimeout(() => {
          const index = this.#waiters.indexOf(waiter);
          if (index >= 0) this.#waiters.splice(index, 1);
          reject(new Error("Timed out waiting for Host output"));
        }, 2_000),
      };
      this.#waiters.push(waiter);
    });
  }
}

function method(message: JsonObject, value: string): boolean {
  return message.method === value;
}

function requestId(message: JsonObject, id: number): boolean {
  return message.id === id;
}

function requiredMessageId(message: JsonObject): string | number {
  if (typeof message.id === "string" || typeof message.id === "number") return message.id;
  throw new Error("JSON-RPC message has no ID");
}

function messageParams(message: JsonObject): JsonObject {
  return (message.params ?? {}) as JsonObject;
}

function threadStatus(message: JsonObject, threadId: string, type: string): boolean {
  const params = messageParams(message);
  return (
    method(message, "thread/status/changed") &&
    params.threadId === threadId &&
    (params.status as JsonObject | undefined)?.type === type
  );
}

function turnEvent(message: JsonObject, eventMethod: string, turnId: string): boolean {
  const params = messageParams(message);
  return (
    method(message, eventMethod) &&
    ((params.turn as JsonObject | undefined)?.id === turnId || params.turnId === turnId)
  );
}

function writeRequest(stream: PassThrough, value: JsonObject): void {
  stream.write(`${JSON.stringify(value)}\n`);
}

const jsonLineBuffers = new WeakMap<PassThrough, string>();

async function readJsonLine(stream: PassThrough): Promise<JsonObject> {
  let buffer = jsonLineBuffers.get(stream) ?? "";
  if (!buffer.includes("\n")) {
    await vi.waitFor(() => {
      const chunk = stream.read() as Buffer | string | null;
      if (chunk !== null) buffer += String(chunk);
      expect(buffer).toContain("\n");
    });
  }
  const newline = buffer.indexOf("\n");
  const line = buffer.slice(0, newline);
  jsonLineBuffers.set(stream, buffer.slice(newline + 1));
  return JSON.parse(line) as JsonObject;
}

function rollbackCapableAdapter(): FakeHarnessAdapter {
  return new FakeHarnessAdapter(
    harnessIdSchema.parse("pi"),
    undefined,
    true,
    true,
    null,
    undefined,
    true,
  );
}

class ResumeStateRollbackAdapter extends FakeHarnessAdapter {
  rollbackReplacementStateAtFirstRead: HarnessSessionState | undefined;

  override async open(input: Parameters<FakeHarnessAdapter["open"]>[0]) {
    const opened = await super.open(input);
    if (
      input.kind === "rollbackLastTurn" &&
      opened.ok &&
      opened.value instanceof FakeHarnessSession
    ) {
      const session = opened.value;
      const nativeRef = session.initialState.nativeRef;
      if (nativeRef) session.setStateForSnapshot({ nativeRef });
      const readSnapshot = session.readSnapshot.bind(session);
      session.readSnapshot = async () => {
        this.rollbackReplacementStateAtFirstRead ??= session.state;
        return readSnapshot();
      };
    }
    return opened;
  }
}

function createFixture(
  options: {
    environment?: NodeJS.ProcessEnv;
    pluginDirectory?: string;
    externalAdapters?: ReadonlyMap<ExternalHarnessId, FakeHarnessAdapter>;
    mappingStore?: MappingStore;
    mappingStoreDirectory?: string;
    closeMappingStoreOnExit?: boolean;
    desktopOutput?: PassThrough;
    officialExitsOnInputEnd?: boolean;
    createOfficialConnection?: () =>
      OfficialAppServerConnection | Promise<OfficialAppServerConnection>;
    accountControl?: CodexAccountControl;
    officialRuntimeScope?: OfficialRuntimeScope;
    desktopProxy?: { origin: string; active: boolean };
    desktopUsage?: { attach(source: () => Promise<HarnessUsageReport[]>): void };
  } = {},
) {
  const adapter =
    options.externalAdapters?.get("pi") ?? new FakeHarnessAdapter(harnessIdSchema.parse("pi"));
  const mappingStoreDirectory =
    options.mappingStoreDirectory ?? mkdtempSync(path.join(tmpdir(), "codexhost-host-test-"));
  const mappingStore =
    options.mappingStore ?? new MappingStore({ directory: mappingStoreDirectory });
  const desktopInput = new PassThrough();
  const desktopOutput = options.desktopOutput ?? new PassThrough();
  const diagnosticOutput = new PassThrough();
  const official = new FakeOfficialProcess(options.officialExitsOnInputEnd);
  const collector = new JsonLineCollector(desktopOutput);
  const startup = Promise.withResolvers<undefined>();
  void startup.promise.catch(() => undefined);
  const spawnOfficial = vi.fn(() => {
    startup.resolve(undefined);
    return official as unknown as ChildProcessWithoutNullStreams;
  });
  const createOfficialConnection = options.createOfficialConnection;
  if (options.officialRuntimeScope) startup.resolve(undefined);
  const host = new AppServerHost({
    stockCodexPath: "/synthetic/codex",
    arguments: ["app-server"],
    defaultAgent: "codex",
    desktopInput,
    desktopOutput,
    diagnosticOutput,
    mappingStore,
    ...(options.closeMappingStoreOnExit !== undefined
      ? { closeMappingStoreOnExit: options.closeMappingStoreOnExit }
      : {}),
    environment: {
      CODEXHOST_NATIVE_MODEL_WAIT_MS: "0",
      CODEXHOST_DATA_DIR: mappingStoreDirectory,
      ...(options.environment ?? {}),
    },
    ...(options.pluginDirectory ? { pluginRoots: [options.pluginDirectory] } : {}),
    externalAdapters:
      options.externalAdapters ?? new Map<ExternalHarnessId, HarnessAdapter>([["pi", adapter]]),
    spawnOfficial: spawnOfficial as unknown as typeof spawn,
    ...(createOfficialConnection
      ? {
          createOfficialConnection: async () => {
            startup.resolve(undefined);
            return createOfficialConnection();
          },
        }
      : {}),
    ...(options.accountControl ? { accountControl: options.accountControl } : {}),
    ...(options.officialRuntimeScope ? { officialRuntimeScope: options.officialRuntimeScope } : {}),
    ...(options.desktopProxy ? { desktopProxy: options.desktopProxy } : {}),
    ...(options.desktopUsage ? { desktopUsage: options.desktopUsage } : {}),
  });
  const running = host.run();
  void running.then(
    () => startup.reject(new Error("Host exited before fixture startup")),
    (error) => startup.reject(error),
  );
  return {
    adapter,
    collector,
    desktopInput,
    desktopOutput,
    diagnosticOutput,
    host,
    official,
    running,
    ready: startup.promise.then(
      () => new Promise<undefined>((resolve) => setImmediate(resolve, undefined)),
    ),
    mappingStore,
    mappingStoreDirectory,
    spawnOfficial,
  };
}

async function startExternalThread(
  fixture: ReturnType<typeof createFixture>,
  model: string,
  id = 1,
  additionalParams: JsonObject = {},
): Promise<string> {
  await fixture.ready;
  writeRequest(fixture.desktopInput, {
    id,
    method: "thread/start",
    params: { model, cwd: "/synthetic", ...additionalParams },
  });
  const response = await fixture.collector.waitFor((message) => requestId(message, id));
  expect(response).not.toHaveProperty("error");
  const result = response.result as JsonObject;
  const thread = result.thread as JsonObject;
  if (typeof thread.id !== "string") throw new Error("Synthetic thread response has no ID");
  return thread.id;
}

async function startPiThread(
  fixture: ReturnType<typeof createFixture>,
  model = PI_NATIVE_TRANSPORT_MODEL_ID,
): Promise<string> {
  return startExternalThread(fixture, model);
}

async function startPiTurn(
  fixture: ReturnType<typeof createFixture>,
  threadId: string,
  id = 2,
): Promise<string> {
  writeRequest(fixture.desktopInput, {
    id,
    method: "turn/start",
    params: { threadId, input: [{ type: "text", text: "synthetic" }] },
  });
  const response = await fixture.collector.waitFor((message) => requestId(message, id));
  const result = response.result as JsonObject;
  const turn = result.turn as JsonObject;
  if (typeof turn.id !== "string") throw new Error("Synthetic turn response has no ID");
  return turn.id;
}

async function completePiTurn(
  fixture: ReturnType<typeof createFixture>,
  threadId: string,
  requestIdValue: number,
  sessionIndex = 0,
): Promise<string> {
  const turnId = await startPiTurn(fixture, threadId, requestIdValue);
  const session = fixture.adapter.sessions[sessionIndex];
  if (!session) throw new Error("Fake Pi Session was not opened");
  await fixture.collector.waitFor((message) => turnEvent(message, "turn/started", turnId));
  session.appendText(`answer ${requestIdValue}`);
  session.succeedTurn();
  await fixture.collector.waitFor((message) => turnEvent(message, "turn/completed", turnId));
  return turnId;
}

async function closeFixture(fixture: ReturnType<typeof createFixture>): Promise<void> {
  fixture.desktopInput.end();
  const outcome = await fixture.running;
  expect(outcome, fixture.diagnosticOutput.read()?.toString() ?? "").toBe(0);
}

async function stopFixture(fixture: ReturnType<typeof createFixture>): Promise<void> {
  await closeFixture(fixture);
  rmSync(fixture.mappingStoreDirectory, { recursive: true, force: true });
}

async function bindOfficialThread(
  fixture: ReturnType<typeof createFixture>,
  threadId: string,
): Promise<void> {
  void threadId;
  await fixture.ready;
  await vi.waitFor(() => expect(fixture.spawnOfficial).toHaveBeenCalledOnce());
}

async function answerOfficialParentCwd(
  fixture: ReturnType<typeof createFixture>,
  threadId = "parent-thread",
): Promise<void> {
  const request = await readJsonLine(fixture.official.stdin);
  expect(request).toMatchObject({ method: "thread/read", params: { threadId } });
  fixture.official.stdout.write(
    `${JSON.stringify({
      id: request.id,
      result: { thread: { id: threadId, cwd: "/synthetic" } },
    })}\n`,
  );
}

describe("AppServerHost idle resource release", () => {
  it("validates settings locally without forwarding them to the official server", async () => {
    const fixture = createFixture();
    try {
      await fixture.ready;
      writeRequest(fixture.desktopInput, {
        id: 900,
        method: "codexhost/settings/idle-release/set",
        params: { enabled: true, timeoutMinutes: 4 },
      });
      expect(await fixture.collector.waitFor((message) => requestId(message, 900))).toMatchObject({
        error: { code: -32602 },
      });
      writeRequest(fixture.desktopInput, {
        id: 901,
        method: "codexhost/settings/idle-release/set",
        params: { enabled: false, timeoutMinutes: 30 },
      });
      expect(await fixture.collector.waitFor((message) => requestId(message, 901))).toMatchObject({
        result: { enabled: false, timeoutMinutes: 30 },
      });
      expect(fixture.official.stdin.read()).toBeNull();
    } finally {
      await stopFixture(fixture);
    }
  });

  it("silently releases an idle session and resumes its history for another Turn", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    const fixture = createFixture();
    try {
      const threadId = await startPiThread(fixture);
      const turnId = await completePiTurn(fixture, threadId, 2);
      const source = fixture.adapter.sessions[0];
      if (!source) throw new Error("Missing source Session");
      const snapshot = await source.readSnapshot();
      if (!snapshot.ok) throw new Error(snapshot.error.message);
      const close = vi.spyOn(source, "close");
      const nativeOpen = fixture.adapter.open.bind(fixture.adapter);
      let resumed: FakeHarnessSession | undefined;
      const open = vi.spyOn(fixture.adapter, "open").mockImplementation(async (input) => {
        if (input.kind !== "resume") return nativeOpen(input);
        resumed = new FakeHarnessSession(
          fixture.adapter.harnessId,
          fixture.adapter.catalog,
          undefined,
          input.nativeRef,
          snapshot.value,
        );
        return { ok: true, value: resumed };
      });
      writeRequest(fixture.desktopInput, {
        id: 900,
        method: "codexhost/settings/idle-release/set",
        params: { enabled: true, timeoutMinutes: 10 },
      });
      await fixture.collector.waitFor((message) => requestId(message, 900));
      await vi.advanceTimersByTimeAsync(9 * 60_000);
      writeRequest(fixture.desktopInput, {
        id: 910,
        method: "codexhost/sessions/loaded/list",
        params: {},
      });
      const listing = await fixture.collector.waitFor((message) => requestId(message, 910));
      expect(listing).toMatchObject({
        result: [{ threadId, state: "idle", reason: "timeout", inactiveMs: 9 * 60_000 }],
      });
      await vi.advanceTimersByTimeAsync(2 * 60_000);
      expect(close).toHaveBeenCalledTimes(1);
      writeRequest(fixture.desktopInput, {
        id: 911,
        method: "codexhost/sessions/loaded/list",
        params: {},
      });
      expect(await fixture.collector.waitFor((message) => requestId(message, 911))).toMatchObject({
        result: [],
      });
      expect(open).not.toHaveBeenCalled();
      expect(fixture.collector.messages.some((message) => method(message, "thread/closed"))).toBe(
        false,
      );
      writeRequest(fixture.desktopInput, {
        id: 901,
        method: "thread/read",
        params: { threadId, includeTurns: false },
      });
      await fixture.collector.waitFor((message) => requestId(message, 901));
      expect(open).not.toHaveBeenCalled();
      writeRequest(fixture.desktopInput, {
        id: 902,
        method: "thread/read",
        params: { threadId, includeTurns: true },
      });
      const history = await fixture.collector.waitFor((message) => requestId(message, 902));
      expect(history).not.toHaveProperty("error");
      expect(JSON.stringify(history)).toContain(turnId);
      expect(open).toHaveBeenCalledTimes(1);
      const nextTurn = await startPiTurn(fixture, threadId, 903);
      await fixture.collector.waitFor((message) => turnEvent(message, "turn/started", nextTurn));
      if (!resumed) throw new Error("Missing resumed Session");
      resumed.appendText("after idle release");
      resumed.succeedTurn();
      await fixture.collector.waitFor((message) => turnEvent(message, "turn/completed", nextTurn));
    } finally {
      await stopFixture(fixture);
      vi.useRealTimers();
    }
  });

  it("keeps an active Turn loaded even beyond the configured timeout", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    const fixture = createFixture();
    try {
      const threadId = await startPiThread(fixture);
      const turnId = await startPiTurn(fixture, threadId);
      await fixture.collector.waitFor((message) => turnEvent(message, "turn/started", turnId));
      const session = fixture.adapter.sessions[0];
      if (!session) throw new Error("Missing Session");
      const close = vi.spyOn(session, "close");
      writeRequest(fixture.desktopInput, {
        id: 900,
        method: "codexhost/settings/idle-release/set",
        params: { enabled: true, timeoutMinutes: 10 },
      });
      await fixture.collector.waitFor((message) => requestId(message, 900));
      await vi.advanceTimersByTimeAsync(31 * 60_000);
      expect(close).not.toHaveBeenCalled();
      session.succeedTurn();
      await fixture.collector.waitFor((message) => turnEvent(message, "turn/completed", turnId));
    } finally {
      await stopFixture(fixture);
      vi.useRealTimers();
    }
  });
});

describe("AppServerHost official forwarding", () => {
  it.each([
    { method: "codexhost/unknown", params: {} },
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

describe("AppServerHost installed Harness plugins", () => {
  // A cold plugin import has a 10s per-plugin loader budget; RPC checks remain 2s.
  it("discovers an unknown plugin, serves its descriptor, routes a Thread, and closes it", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "codexhost-plugin-host-"));
    const location = path.join(directory, "sample-agent");
    mkdirSync(location);
    writeFileSync(
      path.join(directory, "enabled.json"),
      JSON.stringify({ version: 1, enabled: ["sample-agent"] }),
    );
    writeFileSync(
      path.join(location, "manifest.json"),
      JSON.stringify({
        manifestVersion: 1,
        id: "sample-agent",
        name: "Sample Agent",
        version: "1.0.0",
        adapterApiVersion: 1,
        entry: "index.mjs",
      }),
    );
    writeFileSync(
      path.join(location, "index.mjs"),
      `
      import { FakeHarnessAdapter } from ${JSON.stringify(pathToFileURL(path.resolve("packages/harness-adapter/dist/testing.js")).href)};
      import { writeFileSync } from "node:fs";
      let accountInspections = 0;
      export function createHarnessAdapter() {
        const adapter = new FakeHarnessAdapter("sample-agent");
        adapter.inspectAccount = async () => ({ email: "sample@example.com", credits: { usedPercent: ++accountInspections, periodType: "weekly" } });
        const close = adapter.close.bind(adapter);
        adapter.close = async () => { await close(); writeFileSync(new URL("closed", import.meta.url), "yes"); };
        return adapter;
      }
    `,
    );
    const fixture = createFixture({ pluginDirectory: directory, externalAdapters: new Map() });
    try {
      await fixture.ready;
      writeRequest(fixture.desktopInput, {
        id: 907,
        method: "codexhost/harness/accounts/sources",
        params: {},
      });
      expect(await fixture.collector.waitFor((message) => requestId(message, 907))).toMatchObject({
        result: {
          sources: [{ harnessId: "sample-agent", harnessName: "Sample Agent" }],
        },
      });
      writeRequest(fixture.desktopInput, {
        id: 908,
        method: "codexhost/harness/accounts/inspect",
        params: { harnessId: "sample-agent" },
      });
      expect(await fixture.collector.waitFor((message) => requestId(message, 908))).toMatchObject({
        result: {
          harnessId: "sample-agent",
          harnessName: "Sample Agent",
          account: {
            email: "sample@example.com",
            credits: { usedPercent: 1 },
          },
        },
      });
      writeRequest(fixture.desktopInput, {
        id: 905,
        method: "codexhost/harness/accounts/list",
        params: {},
      });
      expect(await fixture.collector.waitFor((message) => requestId(message, 905))).toMatchObject({
        result: {
          accounts: [
            {
              harnessId: "sample-agent",
              harnessName: "Sample Agent",
              email: "sample@example.com",
              credits: { usedPercent: 1 },
            },
          ],
        },
      });
      writeRequest(fixture.desktopInput, {
        id: 909,
        method: "codexhost/harness/accounts/inspect",
        params: { harnessId: "sample-agent", refresh: true },
      });
      expect(await fixture.collector.waitFor((message) => requestId(message, 909))).toMatchObject({
        result: {
          harnessId: "sample-agent",
          account: { credits: { usedPercent: 2 } },
        },
      });
      writeRequest(fixture.desktopInput, {
        id: 906,
        method: "codexhost/harness/accounts/list",
        params: { token: "invalid" },
      });
      expect(await fixture.collector.waitFor((message) => requestId(message, 906))).toMatchObject({
        error: { code: -32602 },
      });
      const model = encodeHarnessPluginRoute(
        harnessPluginRouteSchema.parse({ harnessId: "sample-agent" }),
      );
      const threadId = await startExternalThread(fixture, model, 903);
      expect(
        await fixture.mappingStore.getThread(hostThreadIdSchema.parse(threadId)),
      ).toMatchObject({ harnessId: "sample-agent" });
      expect(fixture.official.stdin.readableLength).toBe(0);
      writeRequest(fixture.desktopInput, { id: 904, method: "initialize", params: {} });
      const initialize = await readJsonLine(fixture.official.stdin);
      expect(initialize).toMatchObject({ method: "initialize" });
      writeRequest(fixture.official.stdout, {
        id: requiredMessageId(initialize),
        result: { userAgent: "official" },
      });
      expect(await readJsonLine(fixture.official.stdin)).toMatchObject({ method: "initialized" });
      expect(await fixture.collector.waitFor((message) => requestId(message, 904))).toMatchObject({
        result: { userAgent: "official" },
      });
    } finally {
      await stopFixture(fixture);
      try {
        expect(readFileSync(path.join(location, "closed"), "utf8")).toBe("yes");
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  }, 15_000);

  it("keeps Qoder Global and CN Threads on distinct shared plugin routes", async () => {
    const ids = [harnessIdSchema.parse("qoder"), harnessIdSchema.parse("qoder-cn")];
    const fixture = createFixture({
      externalAdapters: new Map(ids.map((id) => [id, new FakeHarnessAdapter(id)])),
    });
    try {
      await fixture.ready;
      const threads: string[] = [];
      for (const [index, id] of ids.entries()) {
        const model = encodeHarnessPluginRoute({ harnessId: id });
        const threadId = await startExternalThread(fixture, model, 950 + index);
        threads.push(threadId);
        expect(
          await fixture.mappingStore.getThread(hostThreadIdSchema.parse(threadId)),
        ).toMatchObject({ harnessId: id });
      }
      expect(new Set(threads).size).toBe(2);
      expect(fixture.official.stdin.readableLength).toBe(0);
    } finally {
      await stopFixture(fixture);
    }
  });

  const pluginWaitMethods = ["codexhost/harness/accounts/inspect", "thread/start", "thread/resume"];
  it.each(pluginWaitMethods)(
    "keeps official requests moving during plugin loading: %s",
    async (blockedMethod) => {
      const directory = mkdtempSync(path.join(tmpdir(), "codexhost-plugin-parallel-"));
      const location = path.join(directory, "slow-agent");
      const release = path.join(directory, "release");
      mkdirSync(location);
      writeFileSync(
        path.join(directory, "enabled.json"),
        JSON.stringify({ version: 1, enabled: ["slow-agent"] }),
      );
      writeFileSync(
        path.join(location, "manifest.json"),
        JSON.stringify({
          manifestVersion: 1,
          id: "slow-agent",
          name: "Slow Agent",
          version: "1.0.0",
          adapterApiVersion: 1,
          entry: "index.mjs",
        }),
      );
      writeFileSync(
        path.join(location, "index.mjs"),
        `
      import { access, writeFile } from "node:fs/promises";
      import { FakeHarnessAdapter } from ${JSON.stringify(pathToFileURL(path.resolve("packages/harness-adapter/dist/testing.js")).href)};
      const release = ${JSON.stringify(pathToFileURL(release).href)};
      async function waitForRelease() {
        for (;;) {
          try {
            await access(new URL(release));
            return;
          } catch {
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
        }
      }
      export async function createHarnessAdapter() {
        await writeFile(new URL("started", import.meta.url), "yes");
        await waitForRelease();
        const adapter = new FakeHarnessAdapter("slow-agent");
        await adapter.open({ kind: "create", cwd: "/synthetic" });
        return adapter;
      }
    `,
      );
      const fixture = createFixture({ pluginDirectory: directory, externalAdapters: new Map() });
      try {
        await fixture.ready;
        await vi.waitFor(() => expect(readdirSync(location)).toContain("started"));
        writeRequest(fixture.desktopInput, {
          id: 918,
          method: "initialize",
          params: { clientInfo: { name: "startup-test", version: "1" } },
        });
        const initialize = await readJsonLine(fixture.official.stdin);
        expect(initialize.method).toBe("initialize");
        writeRequest(fixture.official.stdout, {
          id: requiredMessageId(initialize),
          result: { userAgent: "test" },
        });
        expect(await fixture.collector.waitFor((message) => requestId(message, 918))).toMatchObject(
          {
            result: { userAgent: "test" },
          },
        );
        expect((await readJsonLine(fixture.official.stdin)).method).toBe("initialized");
        const model = encodeHarnessPluginRoute(
          harnessPluginRouteSchema.parse({ harnessId: "slow-agent" }),
        );
        for (const id of ["persisted-thread", "other-thread"]) {
          const hostThreadId = hostThreadIdSchema.parse(id);
          await fixture.mappingStore.createProvisional({
            hostThreadId,
            createRequestId: id,
            harnessId: harnessIdSchema.parse("slow-agent"),
            cwd: "/synthetic",
            title: "Persisted",
            transportModelId: model,
            ephemeral: false,
            historyMode: "legacy",
          });
          await fixture.mappingStore.commitReady({
            hostThreadId,
            nativeSessionRef: {
              harnessId: harnessIdSchema.parse("slow-agent"),
              nativeSessionId:
                id === "persisted-thread" ? "fake-session-1" : "other-native-session",
              formatVersion: 1,
            },
          });
        }
        writeRequest(fixture.desktopInput, {
          id: 920,
          method: blockedMethod,
          params:
            blockedMethod === "thread/start"
              ? { model, cwd: "/synthetic" }
              : blockedMethod === "thread/resume"
                ? { threadId: "persisted-thread" }
                : { harnessId: "slow-agent" },
        });
        if (blockedMethod === "thread/resume") {
          writeRequest(fixture.desktopInput, {
            id: 921,
            method: "thread/name/set",
            params: { threadId: "persisted-thread", name: "After resume" },
          });
          writeRequest(fixture.desktopInput, {
            id: 922,
            method: "thread/name/set",
            params: { threadId: "other-thread", name: "Independent" },
          });
          expect(
            await fixture.collector.waitFor((message) => requestId(message, 922)),
          ).toHaveProperty("result");
          expect(fixture.collector.messages.some((message) => requestId(message, 921))).toBe(false);
        }
        writeRequest(fixture.desktopInput, { id: 919, method: "model/list", params: {} });
        const models = await readJsonLine(fixture.official.stdin);
        expect(models.method).toBe("model/list");
        writeRequest(fixture.official.stdout, {
          id: requiredMessageId(models),
          result: { data: [] },
        });
        expect(await fixture.collector.waitFor((message) => requestId(message, 919))).toMatchObject(
          {
            result: { data: [] },
          },
        );
        expect(fixture.collector.messages.some((message) => requestId(message, 920))).toBe(false);
        writeFileSync(release, "ok");
        const completed = await fixture.collector.waitFor((message) => requestId(message, 920));
        expect(completed).toHaveProperty("result");
        if (blockedMethod === "thread/resume") {
          expect(completed).toMatchObject({ result: { thread: { id: "persisted-thread" } } });
          const renamed = await fixture.collector.waitFor((message) => requestId(message, 921));
          expect(renamed).toHaveProperty("result");
          expect(fixture.collector.messages.indexOf(renamed)).toBeGreaterThan(
            fixture.collector.messages.indexOf(completed),
          );
        }
        expect(fixture.official.stdin.readableLength).toBe(0);
      } finally {
        writeFileSync(release, "ok");
        fixture.host.close();
        try {
          await stopFixture(fixture);
        } finally {
          rmSync(directory, { recursive: true, force: true });
        }
      }
    },
    10_000,
  );

  it.each(["close", "eof"])(
    "cancels blocked plugin loads on %s",
    async (ending) => {
      const ids = ["a-agent", "b-agent", "c-agent", "d-agent", "e-agent"];
      const directory = mkdtempSync(path.join(tmpdir(), "codexhost-plugin-close-"));
      const started = path.join(directory, "started");
      const finished = path.join(directory, "finished");
      mkdirSync(started);
      mkdirSync(finished);
      const release = path.join(directory, "release");
      writeFileSync(
        path.join(directory, "enabled.json"),
        JSON.stringify({ version: 1, enabled: ids }),
      );
      for (const id of ids) {
        const location = path.join(directory, id);
        mkdirSync(location);
        writeFileSync(
          path.join(location, "manifest.json"),
          JSON.stringify({
            manifestVersion: 1,
            id,
            name: id,
            version: "1.0.0",
            adapterApiVersion: 1,
            entry: "index.mjs",
          }),
        );
        writeFileSync(
          path.join(location, "index.mjs"),
          `
      import { access, writeFile } from "node:fs/promises";
      import { FakeHarnessAdapter } from ${JSON.stringify(pathToFileURL(path.resolve("packages/harness-adapter/dist/testing.js")).href)};
      const started = ${JSON.stringify(pathToFileURL(path.join(started, id)).href)};
      const finished = ${JSON.stringify(pathToFileURL(path.join(finished, id)).href)};
      const release = ${JSON.stringify(pathToFileURL(release).href)};
      export async function createHarnessAdapter() {
        await writeFile(new URL(started), "yes");
        try {
          for (;;) {
            try {
              await access(new URL(release));
              return new FakeHarnessAdapter(${JSON.stringify(id)});
            } catch {
              await new Promise((resolve) => setTimeout(resolve, 20));
            }
          }
        } finally {
          await writeFile(new URL(finished), "yes");
        }
      }
    `,
        );
      }
      const fixture = createFixture({ pluginDirectory: directory, externalAdapters: new Map() });
      try {
        await fixture.ready;
        await vi.waitFor(() => expect(readdirSync(started)).toHaveLength(4));
        writeRequest(fixture.desktopInput, {
          id: 925,
          method: "codexhost/harness/commands/inspect",
          params: { harnessId: "a-agent" },
        });
        await new Promise<void>((resolve) => setImmediate(resolve));
        if (ending === "close") fixture.host.close();
        else fixture.desktopInput.end();
        let exitCode: number | undefined;
        void fixture.running.then(
          (code) => {
            exitCode = code;
          },
          () => undefined,
        );
        await vi.waitFor(() => expect(exitCode).toBe(0));
        expect(readdirSync(started).sort()).toEqual(["a-agent", "b-agent", "c-agent", "d-agent"]);
      } finally {
        fixture.host.close();
        writeFileSync(release, "ok");
        await vi.waitFor(() =>
          expect(readdirSync(finished).sort()).toEqual(readdirSync(started).sort()),
        );
        try {
          await stopFixture(fixture);
        } finally {
          rmSync(directory, { recursive: true, force: true });
        }
      }
    },
    3_000,
  );

  it.each(["thread/start", "thread/resume"])(
    "drains an admitted Session open before EOF cleanup: %s",
    async (requestMethod) => {
      const fixture = createFixture();
      const release = Promise.withResolvers<undefined>();
      const opened = Promise.withResolvers<undefined>();
      const closeAdapter = vi.spyOn(fixture.adapter, "close");
      try {
        await fixture.ready;
        if (requestMethod !== "thread/start") {
          const seed = await fixture.adapter.open({ kind: "create", cwd: "/synthetic" });
          if (!seed.ok || !seed.value.initialState.nativeRef) {
            throw new Error("Cannot seed a native Session");
          }
          const hostThreadId = hostThreadIdSchema.parse("persisted-thread");
          await fixture.mappingStore.createProvisional({
            hostThreadId,
            createRequestId: "930",
            harnessId: harnessIdSchema.parse("pi"),
            cwd: "/synthetic",
            title: "Persisted",
            transportModelId: PI_NATIVE_TRANSPORT_MODEL_ID,
            ephemeral: false,
            historyMode: "legacy",
          });
          await fixture.mappingStore.commitReady({
            hostThreadId,
            nativeSessionRef: seed.value.initialState.nativeRef,
          });
        }
        const open = fixture.adapter.open.bind(fixture.adapter);
        vi.spyOn(fixture.adapter, "open").mockImplementation(async (input) => {
          const result = await open(input);
          opened.resolve(undefined);
          await release.promise;
          return result;
        });
        writeRequest(fixture.desktopInput, {
          id: 930,
          method: requestMethod,
          params:
            requestMethod === "thread/start"
              ? { model: PI_NATIVE_TRANSPORT_MODEL_ID, cwd: "/synthetic" }
              : { threadId: "persisted-thread" },
        });
        await opened.promise;
        writeRequest(fixture.desktopInput, { id: 931, method: "model/list", params: {} });
        expect((await readJsonLine(fixture.official.stdin)).method).toBe("model/list");
        fixture.desktopInput.end();
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(closeAdapter).not.toHaveBeenCalled();
        release.resolve(undefined);
        await expect(fixture.running).resolves.toBe(0);
        expect(closeAdapter).toHaveBeenCalledOnce();
        const response = await fixture.collector.waitFor((message) => requestId(message, 930));
        expect(response).toHaveProperty("result");
        expect(fixture.diagnosticOutput.read()?.toString() ?? "").not.toContain("closed");
      } finally {
        release.resolve(undefined);
        fixture.host.close();
        await stopFixture(fixture);
      }
    },
  );

  it("persists launch settings through Host RPC and applies them only to the next plugin factory", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "codexhost-launch-rpc-"));
    const location = path.join(directory, "sample-agent");
    const entrypoint = path.join(directory, "installed-app");
    const received = path.join(directory, "received.json");
    mkdirSync(location);
    mkdirSync(entrypoint);
    writeFileSync(
      path.join(directory, "enabled.json"),
      JSON.stringify({ version: 1, enabled: ["sample-agent"] }),
    );
    writeFileSync(
      path.join(location, "manifest.json"),
      JSON.stringify({
        manifestVersion: 1,
        id: "sample-agent",
        name: "Sample",
        version: "1",
        adapterApiVersion: 1,
        entry: "plugin.mjs",
        launchCommand: true,
      }),
    );
    writeFileSync(
      path.join(location, "plugin.mjs"),
      `
      import { writeFileSync } from "node:fs";
      import { FakeHarnessAdapter } from ${JSON.stringify(pathToFileURL(path.resolve("packages/harness-adapter/dist/testing.js")).href)};
      export function createHarnessAdapter(context) {
        writeFileSync(${JSON.stringify(received)}, JSON.stringify(context.launchCommand ?? null));
        return new FakeHarnessAdapter("sample-agent");
      }
    `,
    );
    const options = {
      pluginDirectory: directory,
      environment: { CODEXHOST_DATA_DIR: path.join(directory, "data") },
    };
    let fixture = createFixture(options);
    let id = 960;
    const request = async (method: string, params: JsonObject) => {
      const requestIdValue = id++;
      writeRequest(fixture.desktopInput, { id: requestIdValue, method, params });
      return fixture.collector.waitFor((message) => requestId(message, requestIdValue));
    };
    try {
      const get = "codexhost/harness/launch-settings/get",
        set = "codexhost/harness/launch-settings/set";
      expect(await request(get, { harnessId: "sample-agent" })).toMatchObject({
        result: { path: null, restartRequired: false },
      });
      expect(await request(set, { harnessId: "sample-agent", path: entrypoint })).toMatchObject({
        result: { path: entrypoint, restartRequired: true },
      });
      expect(JSON.parse(readFileSync(received, "utf8"))).toBeNull();
      for (const params of [
        { harnessId: "pi", path: entrypoint },
        { harnessId: "missing-agent", path: entrypoint },
        { harnessId: "../escape", path: entrypoint },
        { harnessId: "sample-agent", path: "relative.cjs" },
        { harnessId: "sample-agent", path: entrypoint, extra: true },
      ])
        expect(await request(set, params)).toMatchObject({ error: { code: -32602 } });
      expect(fixture.official.stdin.readableLength).toBe(0);
      await stopFixture(fixture);
      fixture = createFixture(options);
      expect(await request(get, { harnessId: "sample-agent" })).toMatchObject({
        result: { path: entrypoint, restartRequired: false },
      });
      expect(JSON.parse(readFileSync(received, "utf8"))).toBe(entrypoint);
      expect(await request(set, { harnessId: "sample-agent", path: null })).toMatchObject({
        result: { path: null, restartRequired: true },
      });
    } finally {
      await stopFixture(fixture);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("validates catalog parameters and leaves uninstalled routes out of the official stream", async () => {
    const fixture = createFixture();
    try {
      writeRequest(fixture.desktopInput, {
        id: 912,
        method: "thread/start",
        params: {
          model: encodeHarnessPluginRoute(
            harnessPluginRouteSchema.parse({ harnessId: "missing-agent" }),
          ),
          cwd: "/synthetic",
        },
      });
      expect(await fixture.collector.waitFor((message) => requestId(message, 912))).toHaveProperty(
        "error",
      );
      writeRequest(fixture.desktopInput, {
        id: 913,
        method: "thread/start",
        params: { model: "codexhost/plugin-v1@invalid", cwd: "/synthetic" },
      });
      expect(await fixture.collector.waitFor((message) => requestId(message, 913))).toHaveProperty(
        "error",
      );
      expect(fixture.official.stdin.readableLength).toBe(0);
    } finally {
      await stopFixture(fixture);
    }
  });
});

describe("AppServerHost HarnessAdapter projection", () => {
  it("uses an injected shared listener connection without spawning a stdio app-server", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const closed = Promise.withResolvers<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>();
    const connected = Promise.withResolvers<undefined>();
    const close = vi.fn(() => {
      stdin.destroy();
      stdout.end();
      closed.resolve({ code: 0, signal: null });
    });
    const createOfficialConnection = vi.fn(() => {
      connected.resolve(undefined);
      return { stdin, stdout, stderr, closed: closed.promise, close };
    });
    const fixture = createFixture({ createOfficialConnection });

    try {
      await connected.promise;
      expect(createOfficialConnection).toHaveBeenCalledTimes(1);
      expect(fixture.spawnOfficial).not.toHaveBeenCalled();

      fixture.host.close();

      await expect(fixture.running).resolves.toBe(0);
      expect(close).toHaveBeenCalled();
    } finally {
      fixture.desktopInput.end();
      await fixture.running;
      rmSync(fixture.mappingStoreDirectory, { recursive: true, force: true });
    }
  });

  it("keeps external Harness requests available after official startup failure", async () => {
    const createOfficialConnection = vi.fn(() => {
      throw new Error("synthetic startup failure");
    });
    const fixture = createFixture({ createOfficialConnection });
    try {
      const threadId = await startPiThread(fixture);
      const turnId = await startPiTurn(fixture, threadId);
      const session = fixture.adapter.sessions[0];
      if (!session) throw new Error("Fake Pi Session was not opened");
      session.succeedTurn();
      await fixture.collector.waitFor((message) => turnEvent(message, "turn/completed", turnId));
      writeRequest(fixture.desktopInput, { id: 902, method: "model/list", params: {} });
      await expect(
        fixture.collector.waitFor((message) => message.id === 902),
      ).resolves.toMatchObject({ error: { code: -32001 } });
      expect(createOfficialConnection).toHaveBeenCalledOnce();
      expect(fixture.desktopInput.destroyed).toBe(false);
    } finally {
      fixture.host.close();
      await fixture.running;
      rmSync(fixture.mappingStoreDirectory, { recursive: true, force: true });
    }
  });

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

  describe("Desktop backend proxy", () => {
    const officialAccount = {
      account: { type: "chatgpt", email: "native@example.com", futureField: "kept" },
      requiresOpenaiAuth: false,
      workspaceRouting: {
        mode: "workspace",
        backendOrigin: "https://chatgpt.com",
        futureField: "kept",
      },
    };

    it("publishes the proxy origin as backendOrigin while the proxy is active", async () => {
      const fixture = createFixture({
        desktopProxy: { origin: "https://127.0.0.1:44301", active: true },
        environment: { CODEXHOST_NATIVE_PICKER_TRACE: "1" },
      });
      try {
        await fixture.ready;
        writeRequest(fixture.desktopInput, { id: 912, method: "account/read", params: {} });
        const official = await readJsonLine(fixture.official.stdin);
        expect(official).toMatchObject({ method: "account/read", params: {} });
        expect(String(official.id)).toMatch(/^codexhost:official:/);
        fixture.official.stdout.write(
          `${JSON.stringify({ id: official.id, result: officialAccount })}\n`,
        );
        await expect(fixture.collector.waitFor((message) => message.id === 912)).resolves.toEqual({
          id: 912,
          result: {
            ...officialAccount,
            workspaceRouting: {
              ...officialAccount.workspaceRouting,
              backendOrigin: "https://127.0.0.1:44301",
            },
          },
        });
        const trace = readFileSync(
          path.join(fixture.mappingStoreDirectory, "native-picker-trace.jsonl"),
          "utf8",
        );
        expect(trace).toContain(
          '"event":"desktop-proxy/account-read","from":"https://chatgpt.com","to":"https://127.0.0.1:44301"',
        );
      } finally {
        await stopFixture(fixture);
      }
    });

    it("forwards account/read verbatim while the proxy is inactive", async () => {
      const fixture = createFixture({
        desktopProxy: { origin: "https://127.0.0.1:44301", active: false },
      });
      try {
        await fixture.ready;
        writeRequest(fixture.desktopInput, { id: 912, method: "account/read", params: {} });
        expect(await readJsonLine(fixture.official.stdin)).toEqual({
          id: 912,
          method: "account/read",
          params: {},
        });
        fixture.official.stdout.write(`${JSON.stringify({ id: 912, result: officialAccount })}\n`);
        await expect(fixture.collector.waitFor((message) => message.id === 912)).resolves.toEqual({
          id: 912,
          result: officialAccount,
        });
      } finally {
        await stopFixture(fixture);
      }
    });

    it("falls open when the proxy dies mid-flight or routing is absent", async () => {
      const proxy = { origin: "https://127.0.0.1:44301", active: true };
      const fixture = createFixture({ desktopProxy: proxy });
      try {
        await fixture.ready;
        writeRequest(fixture.desktopInput, { id: 912, method: "account/read", params: {} });
        const first = await readJsonLine(fixture.official.stdin);
        proxy.active = false;
        fixture.official.stdout.write(
          `${JSON.stringify({ id: first.id, result: officialAccount })}\n`,
        );
        await expect(fixture.collector.waitFor((message) => message.id === 912)).resolves.toEqual({
          id: 912,
          result: officialAccount,
        });

        proxy.active = true;
        writeRequest(fixture.desktopInput, { id: 913, method: "account/read", params: {} });
        const second = await readJsonLine(fixture.official.stdin);
        fixture.official.stdout.write(
          `${JSON.stringify({ id: second.id, result: { account: null } })}\n`,
        );
        await expect(fixture.collector.waitFor((message) => message.id === 913)).resolves.toEqual({
          id: 913,
          result: { account: null },
        });

        writeRequest(fixture.desktopInput, { id: 914, method: "account/read", params: {} });
        const third = await readJsonLine(fixture.official.stdin);
        fixture.official.stdout.write(
          `${JSON.stringify({ id: third.id, error: { code: -32600, message: "native" } })}\n`,
        );
        await expect(fixture.collector.waitFor((message) => message.id === 914)).resolves.toEqual({
          id: 914,
          error: { code: -32600, message: "native" },
        });
      } finally {
        await stopFixture(fixture);
      }
    });

    it("answers -32001 when the official backend is unavailable", async () => {
      const createOfficialConnection = vi.fn(() => {
        throw new Error("synthetic startup failure");
      });
      const fixture = createFixture({
        createOfficialConnection,
        desktopProxy: { origin: "https://127.0.0.1:44301", active: true },
      });
      try {
        const threadId = await startPiThread(fixture);
        const turnId = await startPiTurn(fixture, threadId);
        fixture.adapter.sessions[0]?.succeedTurn();
        await fixture.collector.waitFor((message) => turnEvent(message, "turn/completed", turnId));
        writeRequest(fixture.desktopInput, { id: 912, method: "account/read", params: {} });
        await expect(
          fixture.collector.waitFor((message) => message.id === 912),
        ).resolves.toMatchObject({ id: 912, error: { code: -32001 } });
        expect(fixture.desktopInput.destroyed).toBe(false);
      } finally {
        fixture.host.close();
        await fixture.running;
        rmSync(fixture.mappingStoreDirectory, { recursive: true, force: true });
      }
    });
  });

  it("reports Desktop usage per Harness with account telemetry", async () => {
    const adapter = new FakeHarnessAdapter(harnessIdSchema.parse("pi"));
    const account = {
      email: "pi@example.com",
      credits: {
        usedPercent: 30,
        periodType: "five_hour" as const,
        resetsAt: "2026-09-22T07:30:00Z",
        productUsage: [{ product: "7-day window", usagePercent: 12 }],
      },
    };
    adapter.inspectAccount = async () => account;
    let source: (() => Promise<HarnessUsageReport[]>) | undefined;
    const fixture = createFixture({
      externalAdapters: new Map<ExternalHarnessId, HarnessAdapter>([["pi", adapter]]),
      desktopUsage: {
        attach: (value) => {
          source = value;
        },
      },
    });
    try {
      await fixture.ready;
      if (!source) throw new Error("usage source was not attached");
      const reports = await source();
      const catalog = harnessInspectionSchema.parse(await adapter.inspect({}));
      if (catalog.status !== "ready") throw new Error("fake catalog not ready");
      expect(reports).toEqual([
        {
          harnessName: "pi",
          limitNames: [
            encodeExternalTransportSelection("pi", {}),
            ...catalog.catalog.models.map((model) =>
              encodeExternalTransportSelection("pi", { model: model.ref }),
            ),
          ],
          account,
        },
      ]);

      delete (adapter as { inspectAccount?: unknown }).inspectAccount;
      await expect(source()).resolves.toEqual([]);
    } finally {
      await stopFixture(fixture);
    }
  });

  it.each([
    "codexhost/account/switch",
    "codexhost/account/logout",
    "codexhost/account/login/start",
    "codexhost/account/login/cancel",
    "codexhost/account/delete",
    "codexhost/account/recover",
    "codexhost/account/rate-limit-reset/consume",
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

  it("hydrates the native summary list and preserves Subagent identity through parent history", async () => {
    const fixture = createFixture();
    try {
      const parentId = await startPiThread(fixture);
      const turnId = await startPiTurn(fixture, parentId);
      await fixture.collector.waitFor((message) => turnEvent(message, "turn/started", turnId));
      const session = fixture.adapter.sessions[0];
      if (!session) throw new Error("Missing fixture Session");
      const child = {
        subagentId: "call-child",
        nativeSubagentId: "native-child",
        description: "Summary child",
        role: "explorer",
        background: false,
        status: "running" as const,
      };
      const itemId = session.startSubagentDelegation(child);
      const started = await fixture.collector.waitFor(
        (message) =>
          method(message, "thread/started") &&
          (messageParams(message).thread as JsonObject | undefined)?.parentThreadId === parentId,
      );
      const childId = (messageParams(started).thread as JsonObject).id;
      const list = async (id: number, sourceParams: JsonObject) => {
        writeRequest(fixture.desktopInput, {
          id,
          method: "thread/list",
          params: {
            limit: 200,
            sourceKinds: ["subAgentThreadSpawn"],
            useStateDbOnly: true,
            ...sourceParams,
          },
        });
        const official = await readJsonLine(fixture.official.stdin);
        expect(official.method).toBe("thread/list");
        writeRequest(fixture.official.stdout, {
          id: requiredMessageId(official),
          result: { data: [], nextCursor: null },
        });
        return fixture.collector.waitFor((message) => requestId(message, id));
      };
      expect(await list(90, { ancestorThreadId: parentId })).toMatchObject({
        result: {
          data: [
            {
              id: childId,
              parentThreadId: parentId,
              name: "Summary child",
              agentRole: "explorer",
              status: { type: "active" },
              canAcceptDirectInput: false,
            },
          ],
        },
      });
      session.replaceSubagents(itemId, [{ ...child, status: "completed" }]);
      session.completeItem(itemId, { status: "succeeded" });
      session.succeedTurn();
      await fixture.collector.waitFor((message) => turnEvent(message, "turn/completed", turnId));
      expect(await list(91, { parentThreadId: parentId })).toMatchObject({
        result: {
          data: [
            {
              id: childId,
              status: { type: "idle" },
            },
          ],
        },
      });
      writeRequest(fixture.desktopInput, {
        id: 92,
        method: "thread/turns/list",
        params: {
          threadId: parentId,
          limit: 20,
          itemsView: "full",
        },
      });
      const history = await fixture.collector.waitFor((message) => requestId(message, 92));
      expect(history).toMatchObject({
        result: {
          data: [
            {
              items: expect.arrayContaining([
                expect.objectContaining({
                  type: "collabAgentToolCall",
                  senderThreadId: parentId,
                  receiverThreadIds: [childId],
                }),
              ]),
            },
          ],
        },
      });
      expect(
        (await fixture.mappingStore.listThreads()).filter((record) => record.subagent),
      ).toHaveLength(1);
    } finally {
      await stopFixture(fixture);
    }
  });

  it("materializes a Subagent receiver as a readable Child Host Thread", async () => {
    const base = new FakeHarnessAdapter(harnessIdSchema.parse("pi"));
    let subagentPhase: "started" | "temporarily-empty" | "working" | "completed" = "started";
    const adapter = Object.assign(base, {
      subagents: {
        readSnapshot: vi.fn(async (input: { parent: { nativeSessionId: string } }) => {
          const subagentSnapshot: HostThreadSnapshot = {
            turns:
              subagentPhase === "temporarily-empty"
                ? []
                : [
                    {
                      nativeTurnRef: {
                        harnessId: harnessIdSchema.parse("pi"),
                        nativeSessionId: input.parent.nativeSessionId,
                        nativeTurnKey: "native-subagent-turn",
                        formatVersion: 1,
                      },
                      input:
                        subagentPhase === "started"
                          ? [{ type: "text", text: "Analyze files" }]
                          : [],
                      items:
                        subagentPhase === "started"
                          ? []
                          : [
                              {
                                item: {
                                  type: "commandExecution",
                                  itemId: hostItemIdSchema.parse("subagent-command"),
                                  command: "pwd",
                                  output: "/synthetic",
                                  exitCode: 0,
                                },
                                outcome: { status: "succeeded" },
                              },
                              ...(subagentPhase === "completed"
                                ? [
                                    {
                                      item: {
                                        type: "agentMessage" as const,
                                        itemId: hostItemIdSchema.parse("subagent-answer"),
                                        text: "Analysis complete",
                                      },
                                      outcome: { status: "succeeded" as const },
                                    },
                                  ]
                                : []),
                            ],
                      outcome: { status: "unknown", reason: "Synthetic history" },
                    },
                  ],
          };
          return { ok: true as const, value: subagentSnapshot };
        }),
      },
    });
    const fixture = createFixture({
      externalAdapters: new Map([["pi", adapter]]) as ReadonlyMap<
        ExternalHarnessId,
        FakeHarnessAdapter
      >,
    });
    const threadId = await startPiThread(fixture);
    const turnId = await startPiTurn(fixture, threadId);
    const session = adapter.sessions[0];
    if (!session) throw new Error("Fake Session was not opened");
    await fixture.collector.waitFor((message) => turnEvent(message, "turn/started", turnId));
    const childStartedPromise = fixture.collector.waitFor(
      (message) =>
        method(message, "thread/started") &&
        (messageParams(message).thread as JsonObject | undefined)?.parentThreadId === threadId,
    );
    const itemId = session.startSubagentDelegation({
      subagentId: "agent-call",
      nativeSubagentId: "native-agent-1",
      description: "Analyze files",
      background: false,
      status: "running",
    });
    const childStarted = await childStartedPromise;
    expect(messageParams(childStarted).thread).toMatchObject({
      status: { type: "active" },
      canAcceptDirectInput: false,
    });
    const childThreadId = (messageParams(childStarted).thread as JsonObject).id as string;
    writeRequest(fixture.desktopInput, {
      id: 98,
      method: "thread/turns/list",
      params: { threadId: childThreadId, limit: 20, itemsView: "full" },
    });
    const initialHistory = await fixture.collector.waitFor((message) => requestId(message, 98));
    expect(initialHistory).toMatchObject({
      result: { data: [{ items: [expect.objectContaining({ type: "userMessage" })] }] },
    });

    subagentPhase = "temporarily-empty";
    session.emitSubagentTranscriptChanged("native-agent-1");
    writeRequest(fixture.desktopInput, {
      id: 97,
      method: "thread/turns/list",
      params: { threadId: childThreadId, limit: 20, itemsView: "full" },
    });
    const retainedHistory = await fixture.collector.waitFor((message) => requestId(message, 97));
    expect(retainedHistory).toMatchObject({
      result: { data: [{ items: [expect.objectContaining({ type: "userMessage" })] }] },
    });

    subagentPhase = "working";
    session.emitSubagentTranscriptChanged("native-agent-1");
    const childTurnStarted = await fixture.collector.waitFor(
      (message) =>
        method(message, "turn/started") &&
        messageParams(message).threadId === childThreadId &&
        ((messageParams(message).turn as JsonObject | undefined)?.status as string | undefined) ===
          "inProgress",
    );
    const childTurnStartedIndex = fixture.collector.messages.indexOf(childTurnStarted);
    const childCommandCompleted = await fixture.collector.waitFor(
      (message) =>
        method(message, "item/completed") &&
        messageParams(message).threadId === childThreadId &&
        (messageParams(message).item as JsonObject | undefined)?.type === "commandExecution" &&
        (messageParams(message).item as JsonObject | undefined)?.command === "pwd",
    );
    expect(childTurnStartedIndex).toBeLessThan(
      fixture.collector.messages.indexOf(childCommandCompleted),
    );
    writeRequest(fixture.desktopInput, {
      id: 96,
      method: "thread/turns/list",
      params: { threadId: childThreadId, limit: 20, itemsView: "full" },
    });
    const mergedHistory = await fixture.collector.waitFor((message) => requestId(message, 96));
    expect(mergedHistory).toMatchObject({
      result: {
        data: [
          {
            items: expect.arrayContaining([
              expect.objectContaining({
                type: "userMessage",
                content: [expect.objectContaining({ text: "Analyze files" })],
              }),
              expect.objectContaining({ type: "commandExecution", command: "pwd" }),
            ]),
          },
        ],
      },
    });

    subagentPhase = "completed";
    session.replaceSubagents(itemId, [
      {
        subagentId: "agent-call",
        nativeSubagentId: "native-agent-1",
        description: "Analyze files",
        background: false,
        status: "completed",
        resultSummary: "Analysis complete",
      },
    ]);
    session.completeItem(itemId, { status: "succeeded" });
    session.succeedTurn();
    await fixture.collector.waitFor((message) => turnEvent(message, "turn/completed", turnId));
    expect(
      fixture.collector.messages.filter(
        (message) =>
          method(message, "item/completed") &&
          messageParams(message).threadId === childThreadId &&
          (messageParams(message).item as JsonObject | undefined)?.type === "commandExecution",
      ),
    ).toHaveLength(1);
    await expect(
      fixture.collector.waitFor(
        (message) =>
          method(message, "item/completed") &&
          messageParams(message).threadId === childThreadId &&
          (messageParams(message).item as JsonObject | undefined)?.type === "agentMessage" &&
          (messageParams(message).item as JsonObject | undefined)?.text === "Analysis complete",
      ),
    ).resolves.toBeTruthy();
    await expect(
      fixture.collector.waitFor(
        (message) =>
          method(message, "turn/completed") && messageParams(message).threadId === childThreadId,
      ),
    ).resolves.toBeTruthy();
    await expect(
      fixture.collector.waitFor(
        (message) =>
          method(message, "thread/status/changed") &&
          messageParams(message).threadId === childThreadId &&
          (messageParams(message).status as JsonObject | undefined)?.type === "idle",
      ),
    ).resolves.toBeTruthy();
    const completed = await fixture.collector.waitFor(
      (message) =>
        method(message, "item/completed") &&
        (messageParams(message).item as JsonObject | undefined)?.type === "collabAgentToolCall",
    );
    const completedChildThreadId = (
      (messageParams(completed).item as JsonObject).receiverThreadIds as string[]
    )[0];
    expect(completedChildThreadId).toBe(childThreadId);
    expect(childThreadId).toBeTruthy();
    expect(childThreadId).not.toBe("agent-call");
    if (!childThreadId) throw new Error("Projected Subagent has no Child Thread ID");

    writeRequest(fixture.desktopInput, {
      id: 99,
      method: "thread/turns/list",
      params: { threadId: childThreadId, limit: 20, itemsView: "full" },
    });
    const history = await fixture.collector.waitFor((message) => requestId(message, 99));
    expect(history).toMatchObject({
      result: {
        data: [
          {
            items: expect.arrayContaining([
              expect.objectContaining({
                type: "commandExecution",
                command: "pwd",
                aggregatedOutput: "/synthetic",
              }),
              expect.objectContaining({ type: "agentMessage", text: "Analysis complete" }),
            ]),
          },
        ],
      },
    });
    expect(adapter.subagents.readSnapshot).toHaveBeenCalledWith({
      parent: expect.objectContaining({ nativeSessionId: expect.any(String) }),
      nativeSubagentId: "native-agent-1",
      cwd: "/synthetic",
    });
    await stopFixture(fixture);
  });

  it("keeps the Parent Thread active until all background Subagents settle", async () => {
    const base = new FakeHarnessAdapter(harnessIdSchema.parse("pi"));
    let completed = false;
    const adapter = Object.assign(base, {
      subagents: {
        readSnapshot: vi.fn(async (input: { parent: { nativeSessionId: string } }) => ({
          ok: true as const,
          value: {
            turns: [
              {
                nativeTurnRef: {
                  harnessId: harnessIdSchema.parse("pi"),
                  nativeSessionId: input.parent.nativeSessionId,
                  nativeTurnKey: "background-child-turn",
                  formatVersion: 1,
                },
                input: [{ type: "text", text: "Inspect files" }],
                items: completed
                  ? [
                      {
                        item: {
                          type: "agentMessage" as const,
                          itemId: hostItemIdSchema.parse("background-child-answer"),
                          text: "Inspection complete",
                        },
                        outcome: { status: "succeeded" as const },
                      },
                    ]
                  : [],
                outcome: { status: "unknown" as const, reason: "Background work" },
              },
            ],
          },
        })),
      },
    });
    const fixture = createFixture({
      externalAdapters: new Map([["pi", adapter]]) as ReadonlyMap<
        ExternalHarnessId,
        FakeHarnessAdapter
      >,
    });
    const threadId = await startPiThread(fixture);
    const turnId = await startPiTurn(fixture, threadId);
    const session = adapter.sessions[0];
    if (!session) throw new Error("Fake Session was not opened");
    await fixture.collector.waitFor((message) => turnEvent(message, "turn/started", turnId));
    const childStartedPromise = fixture.collector.waitFor(
      (message) =>
        method(message, "thread/started") &&
        (messageParams(message).thread as JsonObject | undefined)?.parentThreadId === threadId,
    );
    const itemId = session.startSubagentDelegation({
      subagentId: "background-agent-call",
      nativeSubagentId: "native-background-agent",
      description: "Inspect files",
      background: true,
      status: "running",
    });
    const childStarted = await childStartedPromise;
    const childThreadId = (messageParams(childStarted).thread as JsonObject).id as string;
    writeRequest(fixture.desktopInput, {
      id: 95,
      method: "thread/turns/list",
      params: { threadId: childThreadId, limit: 20, itemsView: "full" },
    });
    await fixture.collector.waitFor((message) => requestId(message, 95));
    session.completeItem(itemId, { status: "succeeded" });
    session.succeedTurn();
    await fixture.collector.waitFor((message) => turnEvent(message, "turn/completed", turnId));
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(
      fixture.collector.messages.some((message) => threadStatus(message, threadId, "idle")),
    ).toBe(false);
    expect(
      fixture.collector.messages.some((message) => threadStatus(message, threadId, "active")),
    ).toBe(true);

    completed = true;
    session.emitSubagentState("native-background-agent", "completed", "Inspection complete");
    await expect(
      fixture.collector.waitFor((message) => threadStatus(message, childThreadId, "idle")),
    ).resolves.toBeTruthy();
    await expect(
      fixture.collector.waitFor(
        (message) =>
          method(message, "item/completed") &&
          messageParams(message).threadId === childThreadId &&
          (messageParams(message).item as JsonObject | undefined)?.type === "agentMessage" &&
          (messageParams(message).item as JsonObject | undefined)?.text === "Inspection complete",
      ),
    ).resolves.toBeTruthy();
    await expect(
      fixture.collector.waitFor((message) => threadStatus(message, threadId, "idle")),
    ).resolves.toBeTruthy();
    await stopFixture(fixture);
  });

  it("stops an observed Subagent individually and blocks history edits while children run", async () => {
    const adapter = Object.assign(new FakeHarnessAdapter(harnessIdSchema.parse("pi")), {
      subagents: {
        stop: vi.fn(async () => ({ ok: true as const, value: undefined })),
        readSnapshot: vi.fn(async (input: { parent: { nativeSessionId: string } }) => ({
          ok: true as const,
          value: {
            turns: [
              {
                nativeTurnRef: {
                  harnessId: harnessIdSchema.parse("pi"),
                  nativeSessionId: input.parent.nativeSessionId,
                  nativeTurnKey: "child-turn",
                  formatVersion: 1,
                },
                input: [{ type: "text", text: "Inspect" }],
                items: [],
                outcome: { status: "unknown" as const, reason: "Background work" },
              },
            ],
          },
        })),
      },
    });
    const fixture = createFixture({ externalAdapters: new Map([["pi", adapter]]) });
    try {
      const parentId = await startPiThread(fixture);
      const parentTurnId = await startPiTurn(fixture, parentId);
      const session = adapter.sessions[0];
      if (!session) throw new Error("Fake Session was not opened");
      await fixture.collector.waitFor((m) => turnEvent(m, "turn/started", parentTurnId));
      const delegation = session.startSubagentDelegation({
        subagentId: "call-1",
        nativeSubagentId: "child-1",
        description: "Inspect",
        background: true,
        status: "running",
      });
      const started = await fixture.collector.waitFor(
        (m) =>
          method(m, "thread/started") &&
          (messageParams(m).thread as JsonObject)?.parentThreadId === parentId,
      );
      const childId = (messageParams(started).thread as JsonObject).id as string;
      writeRequest(fixture.desktopInput, {
        id: 980,
        method: "thread/turns/list",
        params: { threadId: childId, limit: 20, itemsView: "full" },
      });
      const history = await fixture.collector.waitFor((m) => requestId(m, 980));
      const childTurnId = ((history.result as JsonObject).data as JsonObject[])[0]?.id;
      if (typeof childTurnId !== "string") throw new Error("Child Turn was not projected");
      writeRequest(fixture.desktopInput, {
        id: 981,
        method: "turn/interrupt",
        params: { threadId: childId, turnId: "stale" },
      });
      expect(await fixture.collector.waitFor((m) => requestId(m, 981))).toHaveProperty("error");
      expect(adapter.subagents.stop).not.toHaveBeenCalled();
      writeRequest(fixture.desktopInput, {
        id: 982,
        method: "turn/interrupt",
        params: { threadId: childId, turnId: childTurnId },
      });
      expect(await fixture.collector.waitFor((m) => requestId(m, 982))).toMatchObject({
        result: {},
      });
      expect(adapter.subagents.stop).toHaveBeenCalledExactlyOnceWith({
        parent: expect.objectContaining({ harnessId: "pi" }),
        nativeSubagentId: "child-1",
        cwd: "/synthetic",
      });
      expect(
        fixture.collector.messages.some((m) => turnEvent(m, "turn/completed", parentTurnId)),
      ).toBe(false);
      session.completeItem(delegation, { status: "succeeded" });
      session.succeedTurn();
      await fixture.collector.waitFor((m) => turnEvent(m, "turn/completed", parentTurnId));
      for (const [id, methodName] of [
        [983, "thread/rollback"],
        [984, "thread/revert"],
      ] as const) {
        writeRequest(fixture.desktopInput, {
          id,
          method: methodName,
          params: {
            threadId: parentId,
            ...(methodName === "thread/revert" ? { beforeTurnId: parentTurnId } : { numTurns: 1 }),
          },
        });
        expect(await fixture.collector.waitFor((m) => requestId(m, id))).toMatchObject({
          error: { code: -32072, message: expect.stringContaining("Background agents") },
        });
      }
      expect(adapter.sessions).toHaveLength(1);
    } finally {
      await stopFixture(fixture);
    }
  });

  it("keeps a Subagent Thread active when it is opened while its Subagent runs", async () => {
    const base = new FakeHarnessAdapter(harnessIdSchema.parse("pi"));
    const adapter = Object.assign(base, {
      subagents: {
        readSnapshot: vi.fn(async (input: { parent: { nativeSessionId: string } }) => ({
          ok: true as const,
          value: {
            turns: [
              {
                nativeTurnRef: {
                  harnessId: harnessIdSchema.parse("pi"),
                  nativeSessionId: input.parent.nativeSessionId,
                  nativeTurnKey: "open-while-running-turn",
                  formatVersion: 1,
                },
                input: [{ type: "text", text: "Inspect files" }],
                items: [],
                outcome: { status: "unknown" as const, reason: "Background work" },
              },
            ],
          },
        })),
      },
    });
    const fixture = createFixture({
      externalAdapters: new Map([["pi", adapter]]) as ReadonlyMap<
        ExternalHarnessId,
        FakeHarnessAdapter
      >,
    });
    const threadId = await startPiThread(fixture);
    const turnId = await startPiTurn(fixture, threadId);
    const session = adapter.sessions[0];
    if (!session) throw new Error("Fake Session was not opened");
    await fixture.collector.waitFor((message) => turnEvent(message, "turn/started", turnId));
    const childStartedPromise = fixture.collector.waitFor(
      (message) =>
        method(message, "thread/started") &&
        (messageParams(message).thread as JsonObject | undefined)?.parentThreadId === threadId,
    );
    session.startSubagentDelegation({
      subagentId: "open-while-running-call",
      nativeSubagentId: "native-open-while-running",
      description: "Inspect files",
      background: true,
      status: "running",
    });
    const childStarted = await childStartedPromise;
    const childThread = messageParams(childStarted).thread as JsonObject;
    const childThreadId = childThread.id as string;
    expect(childThread.status).toEqual({ type: "active", activeFlags: [] });

    writeRequest(fixture.desktopInput, {
      id: 96,
      method: "thread/resume",
      params: { threadId: childThreadId, excludeTurns: true },
    });
    const opened = await fixture.collector.waitFor((message) => requestId(message, 96));
    expect((opened.result as JsonObject).thread).toEqual(
      expect.objectContaining({ id: childThreadId, status: { type: "active", activeFlags: [] } }),
    );
    expect(
      fixture.collector.messages.some((message) => threadStatus(message, childThreadId, "idle")),
    ).toBe(false);

    session.emitSubagentState("native-open-while-running", "completed", "Inspection complete");
    await expect(
      fixture.collector.waitFor((message) => threadStatus(message, childThreadId, "idle")),
    ).resolves.toBeTruthy();
    writeRequest(fixture.desktopInput, {
      id: 97,
      method: "thread/resume",
      params: { threadId: childThreadId, excludeTurns: true },
    });
    const reopened = await fixture.collector.waitFor((message) => requestId(message, 97));
    expect((reopened.result as JsonObject).thread).toEqual(
      expect.objectContaining({ id: childThreadId, status: { type: "idle" } }),
    );
    await stopFixture(fixture);
  });

  it("stays truthful and side-effect free through the Desktop's Subagent view open sequence", async () => {
    const base = new FakeHarnessAdapter(harnessIdSchema.parse("pi"));
    const adapter = Object.assign(base, {
      subagents: {
        readSnapshot: vi.fn(async (input: { parent: { nativeSessionId: string } }) => ({
          ok: true as const,
          value: {
            turns: [
              {
                nativeTurnRef: {
                  harnessId: harnessIdSchema.parse("pi"),
                  nativeSessionId: input.parent.nativeSessionId,
                  nativeTurnKey: "view-open-turn",
                  formatVersion: 1,
                },
                input: [{ type: "text", text: "Inspect files" }],
                items: [],
                outcome: { status: "unknown" as const, reason: "Background work" },
              },
            ],
          },
        })),
      },
    });
    const fixture = createFixture({
      externalAdapters: new Map([["pi", adapter]]) as ReadonlyMap<
        ExternalHarnessId,
        FakeHarnessAdapter
      >,
    });
    const threadId = await startPiThread(fixture);
    const turnId = await startPiTurn(fixture, threadId);
    const session = adapter.sessions[0];
    if (!session) throw new Error("Fake Session was not opened");
    await fixture.collector.waitFor((message) => turnEvent(message, "turn/started", turnId));
    const childStartedPromise = fixture.collector.waitFor(
      (message) =>
        method(message, "thread/started") &&
        (messageParams(message).thread as JsonObject | undefined)?.parentThreadId === threadId,
    );
    const itemId = session.startSubagentDelegation({
      subagentId: "view-open-call",
      nativeSubagentId: "native-view-open",
      description: "Inspect files",
      background: true,
      status: "running",
    });
    const childStarted = await childStartedPromise;
    const childThreadId = (messageParams(childStarted).thread as JsonObject).id as string;
    // The Agent tool returns immediately for a background Agent, so the Parent
    // Turn ends long before the Agent does.
    session.completeItem(itemId, { status: "succeeded" });
    session.succeedTurn();
    await fixture.collector.waitFor((message) => turnEvent(message, "turn/completed", turnId));

    const execute = vi.spyOn(session, "execute");
    const close = vi.spyOn(session, "close");

    // Opening the Subagent view sends metadata read, resume and history paging.
    writeRequest(fixture.desktopInput, {
      id: 120,
      method: "thread/read",
      params: { threadId: childThreadId },
    });
    const metadata = await fixture.collector.waitFor((message) => requestId(message, 120));
    expect((metadata.result as JsonObject).thread).toEqual(
      expect.objectContaining({ id: childThreadId, status: { type: "active", activeFlags: [] } }),
    );
    writeRequest(fixture.desktopInput, {
      id: 121,
      method: "thread/resume",
      params: { threadId: childThreadId, excludeTurns: true },
    });
    const resumed = await fixture.collector.waitFor((message) => requestId(message, 121));
    expect((resumed.result as JsonObject).thread).toEqual(
      expect.objectContaining({ id: childThreadId, status: { type: "active", activeFlags: [] } }),
    );
    writeRequest(fixture.desktopInput, {
      id: 122,
      method: "thread/turns/list",
      params: { threadId: childThreadId, limit: 20, itemsView: "full" },
    });
    const running = await fixture.collector.waitFor((message) => requestId(message, 122));
    expect(running).toMatchObject({
      result: { data: [{ status: "inProgress", completedAt: null }] },
    });
    writeRequest(fixture.desktopInput, {
      id: 123,
      method: "thread/items/list",
      params: { threadId: childThreadId, limit: 20 },
    });
    await fixture.collector.waitFor((message) => requestId(message, 123));

    expect(execute).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    expect(
      fixture.collector.messages.some((message) => threadStatus(message, childThreadId, "idle")),
    ).toBe(false);
    expect(
      fixture.collector.messages.some((message) => threadStatus(message, threadId, "idle")),
    ).toBe(false);

    // Only the real Subagent terminal settles the Agent.
    session.emitSubagentState("native-view-open", "completed", "Inspection complete");
    await expect(
      fixture.collector.waitFor((message) => threadStatus(message, childThreadId, "idle")),
    ).resolves.toBeTruthy();
    writeRequest(fixture.desktopInput, {
      id: 124,
      method: "thread/turns/list",
      params: { threadId: childThreadId, limit: 20, itemsView: "full" },
    });
    const settled = await fixture.collector.waitFor((message) => requestId(message, 124));
    expect(settled).toMatchObject({ result: { data: [{ status: "completed" }] } });
    expect(close).not.toHaveBeenCalled();
    await stopFixture(fixture);
  });

  it("terminates the official app-server when its Host session closes", async () => {
    const fixture = createFixture({ officialExitsOnInputEnd: false });
    fixture.official.kill.mockImplementationOnce(() => {
      fixture.official.stdout.end();
      fixture.official.emit("exit", null, "SIGTERM");
      return true;
    });

    try {
      await vi.waitFor(() => expect(fixture.spawnOfficial).toHaveBeenCalledTimes(1));
      expect(() => fixture.host.close()).not.toThrow();
      await expect(fixture.running).resolves.toBe(0);
      expect(fixture.official.kill).toHaveBeenCalledWith("SIGTERM");
    } finally {
      fixture.desktopInput.end();
      await fixture.running;
      rmSync(fixture.mappingStoreDirectory, { recursive: true, force: true });
    }
  });

  it("accepts confirmed graceful EOF shutdown without signaling the exited process", async () => {
    const fixture = createFixture();
    const exited = vi.fn();
    fixture.official.once("exit", exited);
    try {
      await fixture.ready;
      fixture.host.close();
      await expect(fixture.running).resolves.toBe(0);
      expect(fixture.official.stdin.writableEnded).toBe(true);
      expect(exited).toHaveBeenCalledExactlyOnceWith(0, null);
      expect(fixture.official.kill).not.toHaveBeenCalled();
    } finally {
      fixture.desktopInput.end();
      await fixture.running;
      rmSync(fixture.mappingStoreDirectory, { recursive: true, force: true });
    }
  });

  it("lets an active official Turn reach its terminal event after Desktop disconnects", async () => {
    const fixture = createFixture({ officialExitsOnInputEnd: false });
    const threadId = "019cbe86-76cf-7721-b5e4-978934e18757";
    const turnId = "019cbe86-8eef-79d0-8658-cf2c64aa38cf";

    try {
      await bindOfficialThread(fixture, threadId);
      writeRequest(fixture.desktopInput, {
        id: 1,
        method: "turn/start",
        params: { threadId, input: [{ type: "text", text: "keep running" }] },
      });
      await readJsonLine(fixture.official.stdin);
      fixture.official.stdout.write(
        `${JSON.stringify({ method: "turn/started", params: { threadId, turn: { id: turnId } } })}\n`,
      );
      await fixture.collector.waitFor((message) => turnEvent(message, "turn/started", turnId));

      fixture.host.disconnect();
      const beforeTerminal = await Promise.race([
        fixture.running.then(() => "settled" as const),
        new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 25)),
      ]);

      expect(beforeTerminal).toBe("pending");
      expect(fixture.official.kill).not.toHaveBeenCalled();

      fixture.official.stdout.write(
        `${JSON.stringify({
          method: "turn/completed",
          params: { threadId, turn: { id: turnId, status: "completed" } },
        })}\n`,
      );
      await expect(
        fixture.collector.waitFor((message) => turnEvent(message, "turn/completed", turnId)),
      ).resolves.toBeTruthy();
      await expect(fixture.running).resolves.toBe(0);
      expect(fixture.official.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
    } finally {
      fixture.host.close();
      fixture.desktopInput.end();
      await fixture.running;
      rmSync(fixture.mappingStoreDirectory, { recursive: true, force: true });
    }
  });

  it("keeps a forwarded official turn/start alive across the pre-response disconnect race", async () => {
    const fixture = createFixture({ officialExitsOnInputEnd: false });
    const threadId = "019cbe87-ae18-7543-97f1-c60deeb61b17";
    const turnId = "019cbe87-b77a-78a2-a16a-c6ad1fc2a026";

    try {
      await bindOfficialThread(fixture, threadId);
      writeRequest(fixture.desktopInput, {
        id: 1,
        method: "turn/start",
        params: { threadId, input: [{ type: "text", text: "start then disconnect" }] },
      });
      await readJsonLine(fixture.official.stdin);
      fixture.host.disconnect();

      const beforeResponse = await Promise.race([
        fixture.running.then(() => "settled" as const),
        new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 25)),
      ]);
      expect(beforeResponse).toBe("pending");

      fixture.official.stdout.write(
        `${JSON.stringify({ id: 1, result: { turn: { id: turnId } } })}\n`,
      );
      await expect(
        fixture.collector.waitFor((message) => requestId(message, 1)),
      ).resolves.toBeTruthy();
      expect(fixture.official.stdin.writableEnded).toBe(false);

      fixture.official.stdout.write(
        `${JSON.stringify({
          method: "turn/completed",
          params: { threadId, turn: { id: turnId, status: "completed" } },
        })}\n`,
      );
      await expect(fixture.running).resolves.toBe(0);
      expect(fixture.official.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
    } finally {
      fixture.host.close();
      fixture.desktopInput.end();
      await fixture.running;
      rmSync(fixture.mappingStoreDirectory, { recursive: true, force: true });
    }
  });

  it("releases a disconnected Host session when pending official turn/start fails", async () => {
    const fixture = createFixture({ officialExitsOnInputEnd: false });
    const threadId = "019cbe88-9a77-78ae-919f-79cfe1468e11";

    try {
      await bindOfficialThread(fixture, threadId);
      writeRequest(fixture.desktopInput, {
        id: 1,
        method: "turn/start",
        params: { threadId, input: [{ type: "text", text: "rejected start" }] },
      });
      await readJsonLine(fixture.official.stdin);
      fixture.host.disconnect();
      fixture.official.stdout.write(
        `${JSON.stringify({ id: 1, error: { code: -32000, message: "synthetic rejection" } })}\n`,
      );

      await expect(
        fixture.collector.waitFor((message) => requestId(message, 1)),
      ).resolves.toBeTruthy();
      await expect(fixture.running).resolves.toBe(0);
      expect(fixture.official.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
    } finally {
      fixture.host.close();
      fixture.desktopInput.end();
      await fixture.running;
      rmSync(fixture.mappingStoreDirectory, { recursive: true, force: true });
    }
  });

  it("releases a disconnected Host when official completion precedes the start response", async () => {
    const fixture = createFixture({ officialExitsOnInputEnd: false });
    const threadId = "019cbe89-91f5-71c8-b24d-0410e73a2ef4";
    const turnId = "019cbe89-9e78-7e49-ac62-3958b8db3881";

    try {
      await bindOfficialThread(fixture, threadId);
      writeRequest(fixture.desktopInput, {
        id: 1,
        method: "turn/start",
        params: { threadId, input: [{ type: "text", text: "finish immediately" }] },
      });
      await readJsonLine(fixture.official.stdin);
      fixture.host.disconnect();
      fixture.official.stdout.write(
        `${JSON.stringify({
          method: "turn/completed",
          params: { threadId, turn: { id: turnId, status: "completed" } },
        })}\n`,
      );
      fixture.official.stdout.write(
        `${JSON.stringify({ id: 1, result: { turn: { id: turnId } } })}\n`,
      );

      await expect(fixture.running).resolves.toBe(0);
      expect(fixture.official.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
    } finally {
      fixture.host.close();
      fixture.desktopInput.end();
      await fixture.running;
      rmSync(fixture.mappingStoreDirectory, { recursive: true, force: true });
    }
  });

  it("lets an active external Harness Turn finish after Desktop disconnects", async () => {
    const fixture = createFixture();
    let session: FakeHarnessSession | undefined;

    try {
      const threadId = await startPiThread(fixture);
      const turnId = await startPiTurn(fixture, threadId);
      session = fixture.adapter.sessions[0];
      if (!session) throw new Error("Fake Pi Session was not opened");
      const close = vi.spyOn(session, "close");
      await fixture.collector.waitFor((message) => turnEvent(message, "turn/started", turnId));

      fixture.host.disconnect();
      const beforeTerminal = await Promise.race([
        fixture.running.then(() => "settled" as const),
        new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 25)),
      ]);

      expect(beforeTerminal).toBe("pending");
      expect(close).not.toHaveBeenCalled();

      session.appendText("completed after transport disconnect");
      session.succeedTurn();
      await expect(
        fixture.collector.waitFor((message) => turnEvent(message, "turn/completed", turnId)),
      ).resolves.toBeTruthy();
      await expect(fixture.running).resolves.toBe(0);
      expect(close).toHaveBeenCalled();
    } finally {
      try {
        session?.succeedTurn();
      } catch {
        // A failing implementation may already have interrupted the synthetic Turn.
      }
      fixture.host.close();
      fixture.desktopInput.end();
      await fixture.running;
      rmSync(fixture.mappingStoreDirectory, { recursive: true, force: true });
    }
  });

  it("preserves an external Turn and rejects official retries after backend failure", async () => {
    const fixture = createFixture();
    try {
      const threadId = await startPiThread(fixture);
      const turnId = await startPiTurn(fixture, threadId);
      const session = fixture.adapter.sessions[0];
      if (!session) throw new Error("Fake Pi Session was not opened");
      const close = vi.spyOn(session, "close");
      fixture.official.emit("exit", 1, null);
      await vi.waitFor(() => expect(fixture.official.stdout.destroyed).toBe(true));
      writeRequest(fixture.desktopInput, { id: 901, method: "model/list", params: {} });
      await expect(
        fixture.collector.waitFor((message) => message.id === 901),
      ).resolves.toMatchObject({ id: 901, error: { code: -32001 } });
      expect(fixture.desktopInput.destroyed).toBe(false);
      expect(close).not.toHaveBeenCalled();
      expect(fixture.spawnOfficial).toHaveBeenCalledOnce();
      session.appendText("external output after official exit");
      session.succeedTurn();
      await expect(
        fixture.collector.waitFor((message) => turnEvent(message, "turn/completed", turnId)),
      ).resolves.toBeTruthy();
      expect(close).not.toHaveBeenCalled();
    } finally {
      fixture.host.close();
      await fixture.running;
      rmSync(fixture.mappingStoreDirectory, { recursive: true, force: true });
    }
  });

  it("keeps Desktop initialization and external Harnesses available after failed startup cleanup cannot prove exit", async () => {
    const exit = { code: 1, signal: null };
    const stopProcess = vi.fn(async (): Promise<OfficialAppServerExit> => {
      throw new Error("synthetic exit unconfirmed");
    });
    const connection: OfficialAppServerConnection = {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      closed: Promise.resolve(exit),
      stopProcess,
      close: vi.fn(),
    };
    const fixture = createFixture({ createOfficialConnection: () => connection });
    const outcomes: unknown[] = [];
    void fixture.running.then(
      (code) => outcomes.push(code),
      (error: unknown) => outcomes.push(error),
    );
    try {
      await vi.waitFor(() => expect(stopProcess).toHaveBeenCalled());
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(outcomes).toEqual([]);
      writeRequest(fixture.desktopInput, {
        id: 901,
        method: "initialize",
        params: { clientInfo: { name: "codex_desktop", version: "synthetic" } },
      });
      const initializationResponse = await fixture.collector.waitFor(
        (message) => message.id === 901,
      );
      expect(initializationResponse.error).toBeUndefined();
      expect(initializationResponse).toMatchObject({ id: 901, result: expect.any(Object) });
      writeRequest(fixture.desktopInput, { method: "initialized", params: {} });
      const threadId = await startPiThread(fixture);
      const turnId = await startPiTurn(fixture, threadId);
      const session = fixture.adapter.sessions[0];
      if (!session) throw new Error("Fake Pi Session was not opened");
      session.appendText("external output despite unconfirmed native exit");
      session.succeedTurn();
      await fixture.collector.waitFor((message) => turnEvent(message, "turn/completed", turnId));
      writeRequest(fixture.desktopInput, { id: 902, method: "model/list", params: {} });
      await expect(
        fixture.collector.waitFor((message) => message.id === 902),
      ).resolves.toMatchObject({
        id: 902,
        error: { code: -32001 },
      });
      expect(outcomes).toEqual([]);
    } finally {
      stopProcess.mockImplementation(async () => exit);
      fixture.host.close();
      await fixture.running.catch(() => undefined);
      connection.stdin.destroy();
      connection.stdout.destroy();
      connection.stderr.destroy();
      rmSync(fixture.mappingStoreDirectory, { recursive: true, force: true });
    }
  });

  it("keeps the initialized Desktop client attached through managed Account recovery", async () => {
    const exit = Promise.withResolvers<OfficialAppServerExit>();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const nativeRequests: JsonObject[] = [];
    stdin.on("data", (chunk: Buffer) => {
      const request = JSON.parse(chunk.toString()) as JsonObject;
      nativeRequests.push(request);
      if (!("id" in request)) return;
      writeRequest(stdout, {
        id: request.id ?? null,
        result: request.method === "initialize" ? { userAgent: "synthetic-native" } : { data: [] },
      });
    });
    const createBackend = vi.fn((): OwnedOfficialBackend => ({
      closed: exit.promise,
      start: async () => {},
      connect: async () => ({
        stdin,
        stdout,
        stderr,
        closed: exit.promise,
        close: () => {},
      }),
      stop: async () => {
        stdin.end();
        stdout.end();
        stderr.end();
        exit.resolve({ code: 0, signal: null });
      },
    }));
    const scope = new OfficialRuntimeScope({
      permanentHome: "/synthetic/permanent",
      createBackend: createBackend.mockImplementationOnce(() => {
        throw new Error("Synthetic initial startup failure");
      }),
      diagnosticOutput: new PassThrough(),
    });
    const accountControl = new SingleNativeCodexAccount(() => ({
      version: 2,
      currentAccountId: null,
      phase: scope.gate.phase,
      revision: scope.gate.revision,
      accounts: [],
    }));
    const fixture = createFixture({ officialRuntimeScope: scope, accountControl });
    const params = {
      clientInfo: { name: "codex_desktop", version: "synthetic" },
    };
    try {
      writeRequest(fixture.desktopInput, { id: 901, method: "initialize", params });
      const initial = await fixture.collector.waitFor((message) => message.id === 901);
      expect(initial.error).toBeUndefined();
      expect(initial).toMatchObject({ result: { codexHome: "/synthetic/permanent" } });
      expect(scope.gate.phase).toBe("unavailable");
      expect(createBackend).toHaveBeenCalledOnce();
      writeRequest(fixture.desktopInput, { method: "initialized" });
      await scope.owner.start();
      scope.gate.initialized();
      expect(nativeRequests).toContainEqual(
        expect.objectContaining({ method: "initialize", params }),
      );
      expect(nativeRequests).toContainEqual({ method: "initialized" });
      writeRequest(fixture.desktopInput, { id: 903, method: "model/list", params: {} });
      await expect(
        fixture.collector.waitFor((message) => message.id === 903),
      ).resolves.toMatchObject({
        result: { data: expect.any(Array) },
      });
      expect(fixture.collector.messages.filter((message) => message.id === 901)).toHaveLength(1);
      expect(createBackend).toHaveBeenCalledTimes(2);
    } finally {
      fixture.host.close();
      await fixture.running;
      await scope.close();
      rmSync(fixture.mappingStoreDirectory, { recursive: true, force: true });
    }
  });

  it("drains recovered native work only after actual writer exit, not a one-shot startup failure", async () => {
    const exit = Promise.withResolvers<OfficialAppServerExit>();
    const proof = Promise.withResolvers<undefined>();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    stdin.on("data", (chunk: Buffer) => {
      const request = JSON.parse(chunk.toString()) as JsonObject;
      if ("id" in request)
        writeRequest(stdout, { id: request.id ?? null, result: { userAgent: "synthetic-native" } });
    });
    const stop = vi.fn(async () => {
      await proof.promise;
      stdin.end();
      stdout.end();
      stderr.end();
    });
    const scope = new OfficialRuntimeScope({
      permanentHome: "/synthetic/permanent",
      diagnosticOutput: new PassThrough(),
      createBackend: vi
        .fn(() => ({
          closed: exit.promise,
          start: async () => {},
          stop,
          connect: async () => ({ stdin, stdout, stderr, closed: exit.promise, close: () => {} }),
        }))
        .mockImplementationOnce(() => {
          throw new Error("Synthetic initial startup failure");
        }),
    });
    const fixture = createFixture({ officialRuntimeScope: scope });
    let finished = false;
    void fixture.running.then(() => {
      finished = true;
    });
    try {
      writeRequest(fixture.desktopInput, { id: 901, method: "initialize", params: {} });
      await fixture.collector.waitFor((message) => message.id === 901);
      await scope.owner.start();
      scope.gate.initialized();
      writeRequest(stdout, {
        method: "turn/started",
        params: {
          threadId: "synthetic-native-thread",
          turn: { id: "synthetic-native-turn", status: "inProgress", items: [] },
        },
      });
      await fixture.collector.waitFor((message) => message.method === "turn/started");
      // Admission leases are independent from the Host's active-Turn draining.
      expect(scope.gate.busy).toBe(false);
      exit.resolve({ code: 1, signal: null });
      await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce());
      fixture.host.disconnect();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(finished).toBe(false);
      expect(scope.gate.busy).toBe(false);
      proof.resolve(undefined);
      await scope.owner.stop();
      await vi.waitFor(() => expect(finished).toBe(true));
    } finally {
      exit.resolve({ code: 1, signal: null });
      proof.resolve(undefined);
      fixture.host.close();
      await fixture.running;
      await scope.close();
      rmSync(fixture.mappingStoreDirectory, { recursive: true, force: true });
    }
  });

  it("keeps Host alive when official app-server output closes before Desktop input", async () => {
    const fixture = createFixture();

    try {
      await vi.waitFor(() => expect(fixture.spawnOfficial).toHaveBeenCalledOnce());
      fixture.official.stdout.end();

      const outcome = await Promise.race([
        fixture.running,
        new Promise<"timed-out">((resolve) => {
          setTimeout(() => resolve("timed-out"), 100);
        }),
      ]);

      expect(outcome).toBe("timed-out");
      expect(fixture.desktopInput.destroyed).toBe(false);
      expect(fixture.official.kill).toHaveBeenCalledWith("SIGTERM");
    } finally {
      fixture.host.close();
      await fixture.running;
      rmSync(fixture.mappingStoreDirectory, { recursive: true, force: true });
    }
  });

  it("keeps Host alive when official output closes while Desktop output is backpressured", async () => {
    const fixture = createFixture({ desktopOutput: new PassThrough({ highWaterMark: 1 }) });

    try {
      await vi.waitFor(() => expect(fixture.spawnOfficial).toHaveBeenCalledOnce());
      fixture.desktopOutput.pause();
      fixture.official.stdout.write(
        `${JSON.stringify({ method: "synthetic/event", params: { payload: "x".repeat(32_768) } })}\n`,
      );
      await vi.waitFor(() =>
        expect(fixture.desktopOutput.listenerCount("drain")).toBeGreaterThan(0),
      );
      fixture.official.stdout.end();

      const outcome = await Promise.race([
        fixture.running,
        new Promise<"timed-out">((resolve) => {
          setTimeout(() => resolve("timed-out"), 1_000);
        }),
      ]);

      expect(outcome).toBe("timed-out");
      expect(fixture.desktopInput.destroyed).toBe(false);
      expect(fixture.official.kill).toHaveBeenCalledWith("SIGTERM");
    } finally {
      fixture.host.close();
      fixture.desktopOutput.resume();
      await fixture.running;
      rmSync(fixture.mappingStoreDirectory, { recursive: true, force: true });
    }
  });

  it("keeps Host alive when the official app-server exits while its output stays open", async () => {
    const fixture = createFixture();

    try {
      await vi.waitFor(() => expect(fixture.spawnOfficial).toHaveBeenCalledOnce());
      expect(
        fixture.official.stdin.write(Buffer.alloc(fixture.official.stdin.writableHighWaterMark)),
      ).toBe(false);
      writeRequest(fixture.desktopInput, { id: 90, method: "model/list", params: {} });
      await vi.waitFor(() =>
        expect(fixture.official.stdin.listenerCount("drain")).toBeGreaterThan(0),
      );
      fixture.official.emit("exit", 0, null);

      const outcome = await Promise.race([
        fixture.running,
        new Promise<"timed-out">((resolve) => {
          setTimeout(() => resolve("timed-out"), 1_000);
        }),
      ]);

      expect(outcome).toBe("timed-out");
      expect(fixture.desktopInput.destroyed).toBe(false);
      expect(fixture.spawnOfficial).toHaveBeenCalledOnce();
      expect(fixture.official.stdout.destroyed).toBe(true);
      // A confirmed exit releases process ownership; do not signal it again.
      expect(fixture.official.kill).not.toHaveBeenCalled();
    } finally {
      fixture.host.close();
      await fixture.running;
      rmSync(fixture.mappingStoreDirectory, { recursive: true, force: true });
    }
  });

  it("keeps Desktop-first official app-server shutdown successful", async () => {
    const fixture = createFixture();

    try {
      await vi.waitFor(() => expect(fixture.spawnOfficial).toHaveBeenCalledOnce());
      fixture.desktopInput.end();

      await expect(fixture.running).resolves.toBe(0);
    } finally {
      fixture.host.close();
      await fixture.running;
      rmSync(fixture.mappingStoreDirectory, { recursive: true, force: true });
    }
  });

  it("can share one initialized Mapping Store across concurrent remote sessions", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "codexhost-host-shared-"));
    const mappingStore = new MappingStore({ directory });
    await mappingStore.initialize();
    const close = vi.spyOn(mappingStore, "close");
    const backendClosed = Promise.withResolvers<OfficialAppServerExit>();
    const connections = new Set<OfficialAppServerConnection>();
    const officialRuntimeScope = new OfficialRuntimeScope({
      permanentHome: "/synthetic/shared-home",
      diagnosticOutput: new PassThrough(),
      createBackend: (): OwnedOfficialBackend => ({
        closed: backendClosed.promise,
        async start() {},
        async connect() {
          const stdin = new PassThrough();
          const stdout = new PassThrough();
          const stderr = new PassThrough();
          const closed = Promise.withResolvers<OfficialAppServerExit>();
          const connection: OfficialAppServerConnection = {
            stdin,
            stdout,
            stderr,
            closed: closed.promise,
            close() {
              stdin.end();
              stdout.end();
              stderr.end();
              closed.resolve({ code: 0, signal: null });
              connections.delete(connection);
            },
          };
          connections.add(connection);
          return connection;
        },
        async stop() {
          for (const connection of [...connections]) connection.close();
          backendClosed.resolve({ code: 0, signal: null });
        },
      }),
    });
    const accountControl = new SingleNativeCodexAccount(() => ({
      version: 2,
      currentAccountId: null,
      phase: officialRuntimeScope.gate.phase,
      revision: officialRuntimeScope.gate.revision,
      accounts: [],
    }));
    // This checks shared Mapping Store lifetime with explicit shared Host composition.
    const first = createFixture({
      mappingStore,
      mappingStoreDirectory: directory,
      closeMappingStoreOnExit: false,
      officialRuntimeScope,
      accountControl,
    });
    const second = createFixture({
      mappingStore,
      mappingStoreDirectory: directory,
      closeMappingStoreOnExit: false,
      officialRuntimeScope,
      accountControl,
    });

    try {
      await Promise.all([closeFixture(first), closeFixture(second)]);
      expect(close).not.toHaveBeenCalled();
    } finally {
      await officialRuntimeScope.close();
      await mappingStore.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("answers the remote Host update-status discriminator locally", async () => {
    const fixture = createFixture();
    writeRequest(fixture.desktopInput, {
      id: 24,
      method: "codexhost/update/status",
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
        CODEXHOST_CLI_PATH: "/opt/codexhost",
        CODEXHOST_RUNTIME_ENDPOINT: "http://127.0.0.1:43123",
        CODEXHOST_RUNTIME_TOKEN: "token",
      },
      externalAdapters: new Map([["pi", adapter]]),
    });
    const threadId = await startPiThread(fixture);
    expect(adapter.openedInputs[0]).toMatchObject({
      environment: {
        CODEXHOST_CLI_PATH: "/opt/codexhost",
        CODEXHOST_RUNTIME_ENDPOINT: "http://127.0.0.1:43123",
        CODEXHOST_RUNTIME_TOKEN: "token",
      },
    });
    await stopFixture(fixture);
  });

  it("projects official Codex token Usage and account rate limits for inspection", async () => {
    const fixture = createFixture();
    fixture.official.stdin.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split("\n")) {
        if (!line) continue;
        const message = JSON.parse(line) as JsonObject;
        if (message.method !== "account/rateLimits/read") continue;
        fixture.official.stdout.write(
          `${JSON.stringify({
            id: message.id,
            result: {
              rateLimits: {
                primary: { usedPercent: 3, windowDurationMins: 300, resetsAt: 1_800 },
                secondary: { usedPercent: 9, windowDurationMins: 10_080, resetsAt: 2_400 },
              },
              rateLimitsByLimitId: null,
            },
          })}\n`,
        );
      }
    });
    fixture.official.stdout.write(
      `${JSON.stringify({
        method: "thread/tokenUsage/updated",
        params: {
          threadId: "official-thread",
          turnId: "official-turn",
          tokenUsage: {
            total: {
              totalTokens: 1_000,
              inputTokens: 800,
              cachedInputTokens: 600,
              cacheWriteInputTokens: 10,
              outputTokens: 200,
              reasoningOutputTokens: 50,
            },
            last: {
              totalTokens: 240,
              inputTokens: 200,
              cachedInputTokens: 150,
              cacheWriteInputTokens: 5,
              outputTokens: 40,
              reasoningOutputTokens: 10,
            },
            modelContextWindow: 2_000,
          },
        },
      })}\n`,
    );
    await fixture.collector.waitFor((message) => method(message, "thread/tokenUsage/updated"));

    writeRequest(fixture.desktopInput, {
      id: 44,
      method: "codexhost/thread/usage/inspect",
      params: { threadId: "official-thread" },
    });
    await expect(fixture.collector.waitFor((message) => requestId(message, 44))).resolves.toEqual({
      id: 44,
      result: {
        threadId: "official-thread",
        accountCredits: {
          usedPercent: 3,
          periodType: "five_hour",
          resetsAt: new Date(1_800 * 1_000).toISOString(),
          productUsage: [
            {
              product: "7-day window",
              usagePercent: 9,
              resetsAt: new Date(2_400 * 1_000).toISOString(),
            },
          ],
        },
        usage: {
          totalTokens: 1_000,
          inputTokens: 800,
          cachedInputTokens: 600,
          cacheWriteInputTokens: 10,
          outputTokens: 200,
          reasoningOutputTokens: 50,
          contextUsedTokens: 240,
          contextWindowTokens: 2_000,
          cacheHitRatePercent: 75,
        },
      },
    });
    await stopFixture(fixture);
  });

  it("inspects current Account quota and treats other Account ids as unknown", async () => {
    const snapshot = () => ({
      version: 2 as const,
      currentAccountId: "account-a",
      phase: "ready" as const,
      revision: 1,
      accounts: [{ accountId: "account-a", label: "A", email: "a@example.com" }],
    });
    const accountControl: CodexAccountControl = {
      snapshot,
      currentAccountId: () => "account-a",
    };
    const fixture = createFixture({ accountControl });
    fixture.official.stdin.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split("\n")) {
        if (!line) continue;
        const message = JSON.parse(line) as JsonObject;
        if (message.method !== "account/rateLimits/read") continue;
        fixture.official.stdout.write(
          `${JSON.stringify({
            id: message.id,
            result: {
              rateLimits: {
                primary: { usedPercent: 12, windowDurationMins: 300 },
                secondary: { usedPercent: 34, windowDurationMins: 10_080 },
              },
            },
          })}\n`,
        );
      }
    });
    try {
      writeRequest(fixture.desktopInput, {
        id: 46,
        method: "codexhost/account/usage/inspect",
        params: { accountId: "account-b", refresh: true },
      });
      await expect(
        fixture.collector.waitFor((message) => requestId(message, 46)),
      ).resolves.toMatchObject({
        id: 46,
        error: { code: -32086, message: "Unknown Codex Account" },
      });

      writeRequest(fixture.desktopInput, {
        id: 47,
        method: "codexhost/account/usage/inspect",
        params: { accountId: "account-a" },
      });
      await expect(
        fixture.collector.waitFor((message) => requestId(message, 47)),
      ).resolves.toMatchObject({
        id: 47,
        result: {
          accountId: "account-a",
          freshness: "live",
          accountCredits: { usedPercent: 12, periodType: "five_hour" },
        },
      });
    } finally {
      await stopFixture(fixture);
    }
  });

  it("keeps cumulative Thread Usage independent from native Account changes", async () => {
    const fixture = createFixture({
      accountControl: {
        currentAccountId: () => null,
        snapshot: () => ({
          version: 2,
          currentAccountId: null,
          phase: "unavailable",
          revision: 0,
          accounts: [],
        }),
      },
    });
    fixture.official.stdout.write(
      `${JSON.stringify({
        method: "thread/tokenUsage/updated",
        params: {
          threadId: "official-thread",
          turnId: "official-turn",
          tokenUsage: {
            total: { totalTokens: 100, inputTokens: 80, outputTokens: 20 },
            last: { totalTokens: 100, inputTokens: 80, outputTokens: 20 },
            modelContextWindow: 1_000,
          },
        },
      })}\n`,
    );
    await fixture.collector.waitFor((message) => method(message, "thread/tokenUsage/updated"));

    fixture.official.stdout.write(`${JSON.stringify({ method: "account/updated", params: {} })}\n`);
    await fixture.collector.waitFor((message) => method(message, "account/updated"));

    writeRequest(fixture.desktopInput, {
      id: 45,
      method: "codexhost/thread/usage/inspect",
      params: { threadId: "official-thread" },
    });
    await expect(fixture.collector.waitFor((message) => requestId(message, 45))).resolves.toEqual({
      id: 45,
      result: {
        threadId: "official-thread",
        usage: {
          totalTokens: 100,
          inputTokens: 80,
          outputTokens: 20,
          contextUsedTokens: 100,
          contextWindowTokens: 1_000,
        },
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
        (message) => typeof message.id === "string" && message.id.startsWith("codexhost:official:"),
      ),
    ).toEqual([]);
    await stopFixture(fixture);
  });

  it("fails the complete aggregated list when Store or official listing fails", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "codexhost-host-test-"));
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
        cursor: "codexhost:thread-list:v1:legacy-host-cursor",
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
    const directory = mkdtempSync(path.join(tmpdir(), "codexhost-host-test-"));
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
    const directory = mkdtempSync(path.join(tmpdir(), "codexhost-host-test-"));
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

  it("orders early and terminal Usage updates and replays current Usage after thread/read", async () => {
    const fixture = createFixture();
    const threadId = await startPiThread(fixture);
    const session = fixture.adapter.sessions[0];
    if (!session) throw new Error("Fake Pi Session was not opened");
    session.publishUsageOnNextTurn({
      totalTokens: 30,
      contextUsedTokens: 20,
      contextWindowTokens: 100,
    });

    const turnId = await startPiTurn(fixture, threadId, 2);
    const earlyUsage = await fixture.collector.waitFor(
      (message) =>
        method(message, "thread/tokenUsage/updated") &&
        messageParams(message).threadId === threadId,
    );
    expect(earlyUsage).toMatchObject({
      params: {
        threadId,
        turnId,
        tokenUsage: {
          total: { totalTokens: 30 },
          last: { totalTokens: 20, inputTokens: 20 },
          modelContextWindow: 100,
        },
      },
    });
    const responseIndex = fixture.collector.messages.findIndex((message) => requestId(message, 2));
    const earlyUsageIndex = fixture.collector.messages.indexOf(earlyUsage);
    expect(earlyUsageIndex).toBeGreaterThan(responseIndex);

    session.succeedTurn();
    await fixture.collector.waitFor((message) => turnEvent(message, "turn/completed", turnId));
    await fixture.collector.waitFor((message) => threadStatus(message, threadId, "idle"));
    session.publishUsage(
      { totalTokens: 44, contextUsedTokens: 25, contextWindowTokens: 100 },
      hostTurnIdSchema.parse(turnId),
    );
    await vi.waitFor(() => {
      expect(
        fixture.collector.messages.filter(
          (message) =>
            method(message, "thread/tokenUsage/updated") &&
            ((messageParams(message).tokenUsage as JsonObject).total as JsonObject).totalTokens ===
              44,
        ),
      ).toHaveLength(1);
    });
    const terminalIndex = fixture.collector.messages.findIndex((message) =>
      turnEvent(message, "turn/completed", turnId),
    );
    const idleIndex = fixture.collector.messages.findIndex((message) =>
      threadStatus(message, threadId, "idle"),
    );
    const terminalUsageIndex = fixture.collector.messages.findIndex(
      (message) =>
        method(message, "thread/tokenUsage/updated") &&
        ((messageParams(message).tokenUsage as JsonObject).total as JsonObject).totalTokens === 44,
    );
    expect(idleIndex).toBeGreaterThan(terminalIndex);
    expect(terminalUsageIndex).toBeGreaterThan(idleIndex);

    writeRequest(fixture.desktopInput, {
      id: 3,
      method: "thread/read",
      params: { threadId, includeTurns: true },
    });
    await fixture.collector.waitFor((message) => requestId(message, 3));
    await vi.waitFor(() => {
      expect(
        fixture.collector.messages.filter(
          (message) =>
            method(message, "thread/tokenUsage/updated") &&
            ((messageParams(message).tokenUsage as JsonObject).total as JsonObject).totalTokens ===
              44,
        ),
      ).toHaveLength(2);
    });
    const readResponseIndex = fixture.collector.messages.findIndex((message) =>
      requestId(message, 3),
    );
    const replayIndex = fixture.collector.messages.findLastIndex(
      (message) =>
        method(message, "thread/tokenUsage/updated") &&
        ((messageParams(message).tokenUsage as JsonObject).total as JsonObject).totalTokens === 44,
    );
    expect(replayIndex).toBeGreaterThan(readResponseIndex);

    const stored = await fixture.mappingStore.getThread(hostThreadIdSchema.parse(threadId));
    expect(JSON.stringify(stored)).not.toMatch(/"(?:usage|cost|context|requestId|refreshCache)"/i);
    await stopFixture(fixture);
  });

  it("keeps Usage isolated across registered Harness Threads", async () => {
    const piAdapter = new FakeHarnessAdapter(harnessIdSchema.parse("pi"));
    const claudeAdapter = new FakeHarnessAdapter(harnessIdSchema.parse("claude-code"));
    const fixture = createFixture({
      externalAdapters: new Map<ExternalHarnessId, FakeHarnessAdapter>([
        ["pi", piAdapter],
        ["claude-code", claudeAdapter],
      ]),
    });
    const piThreadId = await startExternalThread(fixture, PI_NATIVE_TRANSPORT_MODEL_ID, 10);
    const claudeThreadId = await startExternalThread(
      fixture,
      CLAUDE_CODE_NATIVE_TRANSPORT_MODEL_ID,
      11,
    );
    const piTurnId = await completePiTurn(fixture, piThreadId, 12, 0);
    const claudeTurnId = await completePiTurn(
      { ...fixture, adapter: claudeAdapter },
      claudeThreadId,
      13,
      0,
    );
    piAdapter.sessions[0]?.publishUsage(
      { totalTokens: 10, contextUsedTokens: 2, contextWindowTokens: 100 },
      hostTurnIdSchema.parse(piTurnId),
    );
    claudeAdapter.sessions[0]?.publishUsage(
      { totalTokens: 90, contextUsedTokens: 70, contextWindowTokens: 200 },
      hostTurnIdSchema.parse(claudeTurnId),
    );

    await expect(
      fixture.collector.waitFor(
        (message) =>
          method(message, "thread/tokenUsage/updated") &&
          messageParams(message).threadId === piThreadId,
      ),
    ).resolves.toMatchObject({ params: { tokenUsage: { total: { totalTokens: 10 } } } });
    await expect(
      fixture.collector.waitFor(
        (message) =>
          method(message, "thread/tokenUsage/updated") &&
          messageParams(message).threadId === claudeThreadId,
      ),
    ).resolves.toMatchObject({ params: { tokenUsage: { total: { totalTokens: 90 } } } });
    await stopFixture(fixture);
  });

  it("routes exact Usage refresh only to the owning External Session", async () => {
    const piAdapter = new FakeHarnessAdapter(harnessIdSchema.parse("pi"));
    const claudeAdapter = new FakeHarnessAdapter(harnessIdSchema.parse("claude-code"));
    const fixture = createFixture({
      externalAdapters: new Map<ExternalHarnessId, FakeHarnessAdapter>([
        ["pi", piAdapter],
        ["claude-code", claudeAdapter],
      ]),
    });
    const piThreadId = await startExternalThread(fixture, PI_NATIVE_TRANSPORT_MODEL_ID, 60);
    const claudeThreadId = await startExternalThread(
      fixture,
      CLAUDE_CODE_NATIVE_TRANSPORT_MODEL_ID,
      61,
    );

    writeRequest(fixture.desktopInput, {
      id: 62,
      method: "codexhost/thread/usage/inspect",
      params: { threadId: claudeThreadId, refresh: "exact" },
    });
    await fixture.collector.waitFor((message) => requestId(message, 62));
    expect(claudeAdapter.sessions[0]?.usageRefreshes).toBe(1);
    expect(piAdapter.sessions[0]?.usageRefreshes).toBe(0);

    writeRequest(fixture.desktopInput, {
      id: 63,
      method: "codexhost/thread/usage/inspect",
      params: { threadId: piThreadId, refresh: "newer" },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 63)),
    ).resolves.toMatchObject({ error: { code: -32602 } });
    expect(piAdapter.sessions[0]?.usageRefreshes).toBe(0);
    await stopFixture(fixture);
  });

  it("round-trips Claude.ai plan-window fields through Thread Usage inspection without writing accountCredits", async () => {
    const claudeAdapter = new FakeHarnessAdapter(harnessIdSchema.parse("claude-code"));
    const fixture = createFixture({
      externalAdapters: new Map<ExternalHarnessId, FakeHarnessAdapter>([
        ["claude-code", claudeAdapter],
      ]),
    });
    const claudeThreadId = await startExternalThread(
      fixture,
      CLAUDE_CODE_NATIVE_TRANSPORT_MODEL_ID,
      70,
    );
    const claudeTurnId = await completePiTurn(
      { ...fixture, adapter: claudeAdapter },
      claudeThreadId,
      71,
      0,
    );
    claudeAdapter.sessions[0]?.publishUsage(
      {
        cacheHitRatePercent: 99,
        totalCostUsd: 1.373,
        contextUsedTokens: 50,
        contextWindowTokens: 200,
        planFiveHourUsedPercent: 45,
        planFiveHourResetsAtUnix: 1_756_130_400,
      },
      hostTurnIdSchema.parse(claudeTurnId),
    );
    await fixture.collector.waitFor(
      (message) =>
        method(message, "thread/tokenUsage/updated") &&
        messageParams(message).threadId === claudeThreadId,
    );

    // The Host refreshes Usage when a Turn starts and completes; the native context ring needs it.
    const turnRefreshes = claudeAdapter.sessions[0]?.usageRefreshes ?? 0;
    expect(turnRefreshes).toBe(2);

    writeRequest(fixture.desktopInput, {
      id: 72,
      method: "codexhost/thread/usage/inspect",
      params: { threadId: claudeThreadId, refresh: "exact" },
    });
    await expect(fixture.collector.waitFor((message) => requestId(message, 72))).resolves.toEqual({
      id: 72,
      result: {
        threadId: claudeThreadId,
        usage: {
          cacheHitRatePercent: 99,
          totalCostUsd: 1.373,
          contextUsedTokens: 50,
          contextWindowTokens: 200,
          planFiveHourUsedPercent: 45,
          planFiveHourResetsAtUnix: 1_756_130_400,
        },
      },
    });
    expect(claudeAdapter.sessions[0]?.usageRefreshes).toBe(turnRefreshes + 1);

    writeRequest(fixture.desktopInput, {
      id: 73,
      method: "codexhost/thread/usage/inspect",
      params: { threadId: "official-thread", refresh: "exact" },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 73)),
    ).resolves.toMatchObject({ error: { code: -32602 } });
    await stopFixture(fixture);
  });

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
          modelProvider: "codexhost",
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
    const directory = mkdtempSync(path.join(tmpdir(), "codexhost-host-last-turn-failure-"));
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

  it("reads and updates persisted external metadata without restoring history", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "codexhost-host-metadata-test-"));
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

  it("restores Store-owned external read, resume, and Fork on demand", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "codexhost-host-restart-test-"));
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
      method: "codexhost/thread/usage/inspect",
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
        model: encodeExternalTransportSelection("pi", { model: { id: "fake-model-v1.secondary" } }),
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
    const directory = mkdtempSync(path.join(tmpdir(), "codexhost-host-write-failure-"));
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
    const directory = mkdtempSync(path.join(tmpdir(), "codexhost-host-fork-failure-"));
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
    const directory = mkdtempSync(path.join(tmpdir(), "codexhost-host-rollback-failure-"));
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
        model: encodeExternalTransportSelection("pi", { model: piAdapter.catalog.defaultModel }),
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
        CODEXHOST_DATA_DIR: "/synthetic/codexhost-data",
        CODEXHOST_ENABLE_CLAUDE_CODE: "1",
        CODEXHOST_CLAUDE_COMMAND: "/synthetic/claude",
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

describe("hot attachment admission", () => {
  it("drains native background work after a foreground turn and reopens admission on cancel", async () => {
    const f = createFixture();
    try {
      const threadId = await startPiThread(f);
      const session = f.adapter.sessions[0]!;
      let backgroundTasks = 1;
      Object.defineProperty(session, "backgroundTaskCount", { get: () => backgroundTasks });
      expect(f.host.attachmentState()).toMatchObject({
        busy: true,
        backgroundTasks: 1,
        activeExternal: [],
      });
      f.host.setAttachmentDraining(true);
      for (const [id, method, params] of [
        [901, "thread/start", { model: PI_NATIVE_TRANSPORT_MODEL_ID, cwd: "/synthetic" }],
        [902, "turn/start", { threadId, input: [{ type: "text", text: "new work" }] }],
        [903, "thread/fork", { threadId }],
        [
          906,
          "thread/queue/add",
          { threadId, input: [{ type: "text", text: "new work" }], clientUserMessageId: "test" },
        ],
        [907, "thread/queue/start", { threadId }],
      ] as const) {
        writeRequest(f.desktopInput, { id, method, params });
        expect(await f.collector.waitFor((m) => m.id === id)).toMatchObject({
          error: { code: -32089 },
        });
      }
      // Reading preserved history remains possible while the attachment is draining.
      writeRequest(f.desktopInput, {
        id: 904,
        method: "thread/read",
        params: { threadId, includeTurns: true },
      });
      expect(await f.collector.waitFor((m) => m.id === 904)).not.toHaveProperty("error");
      backgroundTasks = 0;
      await vi.waitFor(() => expect(f.host.attachmentState().busy).toBe(false));
      f.host.setAttachmentDraining(false);
      await completePiTurn(f, threadId, 905);
    } finally {
      f.host.close();
      await f.running;
      rmSync(f.mappingStoreDirectory, { recursive: true, force: true });
    }
  });
});
