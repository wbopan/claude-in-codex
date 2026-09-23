import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";
import { FakeHarnessSession } from "@claude-in-codex/harness-adapter/testing";
import { MappingStore } from "@claude-in-codex/mapping-store";
import type { JsonObject } from "@claude-in-codex/protocol-core";

import { tempDir } from "../../../../../tests/helpers/temp-dir.js";
import { SingleNativeCodexAccount } from "../../../src/account/codex-account-control.js";
import { OfficialRuntimeScope } from "../../../src/codex-runtime/official-runtime-scope.js";
import type { OwnedOfficialBackend } from "../../../src/codex-runtime/official-runtime-owner.js";
import type {
  OfficialAppServerConnection,
  OfficialAppServerExit,
} from "../../../src/official-app-server-connection.js";

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
import { method, requestId, turnEvent, writeRequest, readJsonLine } from "./json-rpc.js";

describe("AppServerHost idle resource release", () => {
  it("validates settings locally without forwarding them to the official server", async () => {
    const fixture = createFixture();
    try {
      await fixture.ready;
      writeRequest(fixture.desktopInput, {
        id: 900,
        method: "claude-in-codex/settings/idle-release/set",
        params: { enabled: true, timeoutMinutes: 4 },
      });
      expect(await fixture.collector.waitFor((message) => requestId(message, 900))).toMatchObject({
        error: { code: -32602 },
      });
      writeRequest(fixture.desktopInput, {
        id: 901,
        method: "claude-in-codex/settings/idle-release/set",
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

  it("applies the stored idleRelease switch at startup and when it changes", async () => {
    const directory = await tempDir("claude-in-codex-host-test-");
    writeFileSync(path.join(directory, "features.json"), JSON.stringify({ idleRelease: true }));
    const fixture = createFixture({ mappingStoreDirectory: directory });
    try {
      const threadId = await startPiThread(fixture);
      await completePiTurn(fixture, threadId, 2);
      writeRequest(fixture.desktopInput, {
        id: 910,
        method: "claude-in-codex/sessions/loaded/list",
        params: {},
      });
      expect(await fixture.collector.waitFor((message) => requestId(message, 910))).toMatchObject({
        result: [{ threadId, state: "idle", reason: "timeout" }],
      });
      fixture.host.applyIdleRelease({ enabled: false, timeoutMinutes: 30 });
      writeRequest(fixture.desktopInput, {
        id: 911,
        method: "claude-in-codex/sessions/loaded/list",
        params: {},
      });
      expect(await fixture.collector.waitFor((message) => requestId(message, 911))).toMatchObject({
        result: [{ threadId, state: "idle", reason: "disabled" }],
      });
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
        method: "claude-in-codex/settings/idle-release/set",
        params: { enabled: true, timeoutMinutes: 10 },
      });
      await fixture.collector.waitFor((message) => requestId(message, 900));
      await vi.advanceTimersByTimeAsync(9 * 60_000);
      writeRequest(fixture.desktopInput, {
        id: 910,
        method: "claude-in-codex/sessions/loaded/list",
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
        method: "claude-in-codex/sessions/loaded/list",
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
        method: "claude-in-codex/settings/idle-release/set",
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
    const directory = await tempDir("claude-in-codex-host-shared-");
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
    }
  });
});

describe("hot attachment admission", () => {
  it("lists live External Threads with their project and activity for the Dashboard", async () => {
    const f = createFixture();
    try {
      const threadId = await startPiThread(f);
      expect(f.host.externalTasks()).toEqual([
        expect.objectContaining({
          threadId,
          harnessId: "pi",
          cwd: "/synthetic",
          subagent: false,
          status: "idle",
          activity: null,
          backgroundTasks: 0,
        }),
      ]);
      await startPiTurn(f, threadId, 950);
      await vi.waitFor(() =>
        expect(f.host.externalTasks()[0]).toMatchObject({
          status: "running",
          activity: { kind: expect.any(String), startedAtMs: expect.any(Number) },
        }),
      );
      const session = f.adapter.sessions[0];
      if (!session) throw new Error("Fake Pi Session was not opened");
      session.succeedTurn();
      await vi.waitFor(() => expect(f.host.externalTasks()[0]?.status).toBe("idle"));
      await expect(f.host.harnessInstallations()).resolves.toEqual([
        { harnessId: "pi", executable: null, version: null },
      ]);
    } finally {
      f.host.close();
      await f.running;
      rmSync(f.mappingStoreDirectory, { recursive: true, force: true });
    }
  });

  it("drains native background work after a foreground turn and reopens admission on cancel", async () => {
    const f = createFixture();
    try {
      const threadId = await startPiThread(f);
      const session = f.adapter.sessions[0];
      if (!session) throw new Error("Fake Pi Session was not opened");
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
      ] satisfies Array<[number, string, JsonObject]>) {
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
