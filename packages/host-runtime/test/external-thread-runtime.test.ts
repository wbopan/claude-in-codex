import { FakeHarnessAdapter } from "@claude-in-codex/harness-adapter/testing";
import type { StoredThreadRecordV1 } from "@claude-in-codex/mapping-store";
import {
  harnessIdSchema,
  harnessThinkingOptionIdSchema,
  hostThreadIdSchema,
  nativeSessionRefSchema,
} from "@claude-in-codex/shared-contracts";
import { describe, expect, it } from "vitest";

import type { ExternalThreadRepository } from "../src/external-thread-repository.js";
import { ExternalThreadRuntime } from "../src/external-thread-runtime.js";
import { transportModelIdForHarness } from "@claude-in-codex/protocol-core";

const PI_NATIVE_TRANSPORT_MODEL_ID = transportModelIdForHarness("pi");

const harnessId = harnessIdSchema.parse("pi");
const hostThreadId = hostThreadIdSchema.parse("thread-1");

function record(): StoredThreadRecordV1 {
  return {
    formatVersion: 1,
    revision: 1,
    hostThreadId,
    createRequestId: "create-1",
    harnessId,
    state: "ready",
    nativeSessionRef: nativeSessionRefSchema.parse({
      harnessId,
      nativeSessionId: "native-1",
      formatVersion: 1,
    }),
    cwd: "/synthetic",
    title: "Pi Thread",
    archived: false,
    transportModelId: PI_NATIVE_TRANSPORT_MODEL_ID,
    ephemeral: false,
    historyMode: "legacy",
    turnMappings: [],
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T01:00:00.000Z",
  } as StoredThreadRecordV1;
}

describe("ExternalThreadRuntime register", () => {
  it("exposes the requested create Model before the Session publishes state", async () => {
    const adapter = new FakeHarnessAdapter(harnessId);
    const model = adapter.catalog.models[1]?.ref;
    const thinkingOptionId = harnessThinkingOptionIdSchema.parse("low");
    if (!model) throw new Error("Fake catalog has no secondary Model");
    const opened = await adapter.open({
      kind: "create",
      cwd: "/synthetic",
      model,
      thinkingOptionId,
    });
    if (!opened.ok) throw new Error(opened.error.message);
    Object.defineProperty(opened.value, "initialState", { configurable: true, value: {} });

    const runtime = new ExternalThreadRuntime({
      adapters: new Map([["pi", adapter]]),
      repository: { find: async () => null } as unknown as ExternalThreadRepository,
      consumeOutputs: async () => undefined,
      diagnose: () => undefined,
    });
    const thread = runtime.register({
      record: record(),
      session: opened.value,
      sessionId: hostThreadId,
      thread: { id: hostThreadId },
      turns: [],
      requestedModel: model,
      requestedThinkingOptionId: thinkingOptionId,
    });

    expect(thread.stateObserver.state).toMatchObject({
      effectiveModel: model,
      effectiveThinkingOptionId: thinkingOptionId,
    });
  });
});
