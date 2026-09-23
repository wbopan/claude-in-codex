import type { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { expect, vi } from "vitest";
import type { HarnessAdapter } from "@claude-in-codex/harness-adapter";
import { FakeHarnessAdapter } from "@claude-in-codex/harness-adapter/testing";
import { MappingStore } from "@claude-in-codex/mapping-store";
import {
  transportModelIdForHarness,
  type ExternalHarnessId,
  type JsonObject,
} from "@claude-in-codex/protocol-core";
import { harnessIdSchema } from "@claude-in-codex/shared-contracts";

import { AppServerHost } from "../../../src/app-server-host.js";
import type { HarnessUsageReport } from "../../../src/desktop-usage-buckets.js";
import type { CodexAccountControl } from "../../../src/account/codex-account-control.js";
import type { OfficialRuntimeScope } from "../../../src/codex-runtime/official-runtime-scope.js";
import type { OfficialAppServerConnection } from "../../../src/official-app-server-connection.js";

import { FakeOfficialProcess } from "./fakes.js";
import { JsonLineCollector, requestId, turnEvent, writeRequest } from "./json-rpc.js";

export const PI_NATIVE_TRANSPORT_MODEL_ID = transportModelIdForHarness("pi");

export function createFixture(
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
    desktopUsage?: { attach(source: () => Promise<HarnessUsageReport[]>): void };
  } = {},
) {
  const adapter =
    options.externalAdapters?.get("pi") ?? new FakeHarnessAdapter(harnessIdSchema.parse("pi"));
  const mappingStoreDirectory =
    options.mappingStoreDirectory ?? mkdtempSync(path.join(tmpdir(), "claude-in-codex-host-test-"));
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
      CLAUDE_IN_CODEX_NATIVE_MODEL_WAIT_MS: "0",
      CLAUDE_IN_CODEX_DATA_DIR: mappingStoreDirectory,
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

export async function startExternalThread(
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

export async function startPiThread(
  fixture: ReturnType<typeof createFixture>,
  model = PI_NATIVE_TRANSPORT_MODEL_ID,
): Promise<string> {
  return startExternalThread(fixture, model);
}

export async function startPiTurn(
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

export async function completePiTurn(
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

export async function closeFixture(fixture: ReturnType<typeof createFixture>): Promise<void> {
  fixture.desktopInput.end();
  const outcome = await fixture.running;
  expect(outcome, fixture.diagnosticOutput.read()?.toString() ?? "").toBe(0);
}

export async function stopFixture(fixture: ReturnType<typeof createFixture>): Promise<void> {
  await closeFixture(fixture);
  rmSync(fixture.mappingStoreDirectory, { recursive: true, force: true });
}

export async function bindOfficialThread(
  fixture: ReturnType<typeof createFixture>,
  threadId: string,
): Promise<void> {
  void threadId;
  await fixture.ready;
  await vi.waitFor(() => expect(fixture.spawnOfficial).toHaveBeenCalledOnce());
}
