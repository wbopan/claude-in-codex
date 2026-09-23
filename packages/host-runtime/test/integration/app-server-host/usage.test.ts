import { describe, expect, it, vi } from "vitest";
import type { HarnessAdapter } from "@claude-in-codex/harness-adapter";
import { FakeHarnessAdapter } from "@claude-in-codex/harness-adapter/testing";
import {
  CLAUDE_CODE_NATIVE_TRANSPORT_MODEL_ID,
  encodeExternalTransportSelection,
  type ExternalHarnessId,
  type JsonObject,
} from "@claude-in-codex/protocol-core";
import {
  harnessIdSchema,
  harnessInspectionSchema,
  hostThreadIdSchema,
  hostTurnIdSchema,
} from "@claude-in-codex/shared-contracts";

import type { HarnessUsageReport } from "../../../src/desktop-usage-buckets.js";
import type { CodexAccountControl } from "../../../src/account/codex-account-control.js";

import {
  PI_NATIVE_TRANSPORT_MODEL_ID,
  createFixture,
  startExternalThread,
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
  it("reports Desktop usage per Harness with account telemetry", async () => {
    const adapter: FakeHarnessAdapter & Pick<HarnessAdapter, "inspectAccount"> =
      new FakeHarnessAdapter(harnessIdSchema.parse("pi"));
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
      externalAdapters: new Map<ExternalHarnessId, FakeHarnessAdapter>([["pi", adapter]]),
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
      method: "claude-in-codex/thread/usage/inspect",
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
        method: "claude-in-codex/account/usage/inspect",
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
        method: "claude-in-codex/account/usage/inspect",
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
      method: "claude-in-codex/thread/usage/inspect",
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
      method: "claude-in-codex/thread/usage/inspect",
      params: { threadId: claudeThreadId, refresh: "exact" },
    });
    await fixture.collector.waitFor((message) => requestId(message, 62));
    expect(claudeAdapter.sessions[0]?.usageRefreshes).toBe(1);
    expect(piAdapter.sessions[0]?.usageRefreshes).toBe(0);

    writeRequest(fixture.desktopInput, {
      id: 63,
      method: "claude-in-codex/thread/usage/inspect",
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
      method: "claude-in-codex/thread/usage/inspect",
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
      method: "claude-in-codex/thread/usage/inspect",
      params: { threadId: "official-thread", refresh: "exact" },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 73)),
    ).resolves.toMatchObject({ error: { code: -32602 } });
    await stopFixture(fixture);
  });
});
