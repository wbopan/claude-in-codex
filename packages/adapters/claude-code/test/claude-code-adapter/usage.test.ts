import { describe, expect, it, vi } from "vitest";

import { projectClaudePlanLimitToCredits } from "../../src/claude-code-adapter.js";
import { encodeClaudeModelRef } from "../../src/model-catalog.js";
import type { ClaudeTransportContextUsage } from "../../src/transport.js";
import { deferred, fixture, nextEvent, openSession, textTurn } from "./fixture.js";

describe("projectClaudePlanLimitToCredits", () => {
  it("returns null when nothing has been observed", () => {
    expect(projectClaudePlanLimitToCredits(null)).toBeNull();
    expect(projectClaudePlanLimitToCredits({})).toBeNull();
  });

  it("leads with the five-hour window and folds the seven-day window into productUsage", () => {
    expect(
      projectClaudePlanLimitToCredits({
        fiveHour: { utilizationPercent: 62, resetsAtUnix: 1_756_130_400 },
        sevenDay: { utilizationPercent: 18, resetsAtUnix: 1_756_648_800 },
      }),
    ).toEqual({
      usedPercent: 62,
      periodType: "five_hour",
      resetsAt: new Date(1_756_130_400 * 1000).toISOString(),
      productUsage: [
        {
          product: "7-day window",
          usagePercent: 18,
          resetsAt: new Date(1_756_648_800 * 1000).toISOString(),
        },
      ],
    });
  });

  it("omits resetsAt and productUsage when neither is available", () => {
    expect(projectClaudePlanLimitToCredits({ fiveHour: { utilizationPercent: 8 } })).toEqual({
      usedPercent: 8,
      periodType: "five_hour",
    });
  });

  it("falls back to the seven-day window alone", () => {
    expect(
      projectClaudePlanLimitToCredits({
        sevenDay: { utilizationPercent: 41, resetsAtUnix: 1_756_648_800 },
      }),
    ).toEqual({
      usedPercent: 41,
      periodType: "seven_day",
      resetsAt: new Date(1_756_648_800 * 1000).toISOString(),
    });
  });
});

describe("Claude Code HarnessAdapter", () => {
  it("does not query Context automatically at Assistant, Tool, or Turn boundaries", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();

    await session.execute(textTurn("passive-usage"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    const transport = transports[0];
    if (!transport) throw new Error("Fake Claude transport was not created");

    transport.event({
      type: "message.completed",
      messageId: "assistant-usage",
      lastRequestUsage: {
        requestId: "request-usage",
        model: "claude-sonnet-4-6",
        provider: "firstParty",
        inputTokens: 10,
        outputTokens: 5,
        cacheCreationInputTokens: 20,
        cacheReadInputTokens: 70,
      },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "session.usage.changed",
      usage: { cacheHitRatePercent: 70, inputTokens: 100, outputTokens: 5 },
    });

    transport.event({
      type: "tool.started",
      callId: "tool-1",
      toolName: "Read",
      arguments: {},
    });
    await nextEvent(iterator);
    transport.event({
      type: "tool.completed",
      callId: "tool-1",
      toolName: "Read",
      isError: false,
    });
    await nextEvent(iterator);
    transport.finish({ status: "succeeded" });
    for (;;) {
      if ((await nextEvent(iterator)).type === "turn.completed") break;
    }
    expect(transport.getContextUsage).not.toHaveBeenCalled();
    await session.close();
  });

  it("deduplicates completed requests and calibrates estimates with Result totals", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();

    await session.execute(textTurn("usage-result"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    const transport = transports[0];
    if (!transport) throw new Error("Fake Claude transport was not created");
    const request = {
      requestId: "request-1",
      model: "claude-sonnet-4-6",
      provider: "firstParty",
      inputTokens: 10,
      outputTokens: 5,
      cacheCreationInputTokens: 20,
      cacheReadInputTokens: 70,
    } as const;

    transport.event({
      type: "message.completed",
      messageId: "assistant-1",
      lastRequestUsage: request,
    });
    const estimate = await nextEvent(iterator);
    expect(estimate).toMatchObject({
      type: "session.usage.changed",
      usage: { inputTokens: 100, outputTokens: 5, cacheHitRatePercent: 70 },
    });
    transport.event({
      type: "message.completed",
      messageId: "assistant-1",
      lastRequestUsage: request,
    });
    await Promise.resolve();

    transport.event({
      type: "usage.result",
      totalCostUsd: 1.373,
      modelUsage: [
        { inputTokens: 100, outputTokens: 40 },
        { inputTokens: 20, outputTokens: 5 },
      ],
      lastRequestUsage: {
        inputTokens: 10,
        outputTokens: 45,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 990,
      },
    });
    expect(await nextEvent(iterator)).toEqual({
      type: "session.usage.changed",
      observedForTurnId: "usage-result",
      usage: {
        totalCostUsd: 1.373,
        inputTokens: 120,
        outputTokens: 45,
        cacheHitRatePercent: 99,
      },
    });
    transport.finish({ status: "succeeded" });
    for (;;) {
      if ((await nextEvent(iterator)).type === "turn.completed") break;
    }
    expect(transport.getContextUsage).not.toHaveBeenCalled();
    await session.close();
  });

  it("keeps passive Usage isolated across concurrent Claude Sessions", async () => {
    const { adapter, transports } = fixture();
    const sessionA = await openSession(adapter);
    const iteratorA = sessionA.outputs[Symbol.asyncIterator]();
    await sessionA.execute(textTurn("session-a"));
    await nextEvent(iteratorA);
    await nextEvent(iteratorA);
    await nextEvent(iteratorA);

    const sessionB = await openSession(adapter);
    const iteratorB = sessionB.outputs[Symbol.asyncIterator]();
    await sessionB.execute(textTurn("session-b"));
    await nextEvent(iteratorB);
    await nextEvent(iteratorB);
    await nextEvent(iteratorB);
    const transportA = transports[0];
    const transportB = transports[1];
    if (!transportA || !transportB) throw new Error("Fake Claude transports were not created");

    transportA.event({
      type: "message.completed",
      messageId: "assistant-a",
      lastRequestUsage: {
        requestId: "shared-looking-id",
        inputTokens: 10,
        outputTokens: 1,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 90,
      },
    });
    transportB.event({
      type: "message.completed",
      messageId: "assistant-b",
      lastRequestUsage: {
        requestId: "shared-looking-id",
        inputTokens: 80,
        outputTokens: 7,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 20,
      },
    });
    expect(await nextEvent(iteratorA)).toMatchObject({
      usage: { inputTokens: 100, outputTokens: 1, cacheHitRatePercent: 90 },
    });
    expect(await nextEvent(iteratorB)).toMatchObject({
      usage: { inputTokens: 100, outputTokens: 7, cacheHitRatePercent: 20 },
    });

    transportA.finish({ status: "succeeded" });
    transportB.finish({ status: "succeeded" });
    for (;;) if ((await nextEvent(iteratorA)).type === "turn.completed") break;
    for (;;) if ((await nextEvent(iteratorB)).type === "turn.completed") break;
    await sessionA.close();
    await sessionB.close();
  });

  it("refreshes exact Context on demand, stops after success, and reuses the TTL", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();

    await session.execute(textTurn("exact-context"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    const transport = transports[0];
    if (!transport) throw new Error("Fake Claude transport was not created");
    transport.contextUsage = { usedTokens: 80, maxTokens: 200, model: "runtime-default" };

    await session.refreshUsage?.();
    expect(transport.getContextUsage).toHaveBeenCalledOnce();
    expect(await nextEvent(iterator)).toEqual({
      type: "session.usage.changed",
      observedForTurnId: "exact-context",
      usage: { contextUsedTokens: 80, contextWindowTokens: 200 },
    });
    await session.refreshUsage?.();
    expect(transport.getContextUsage).toHaveBeenCalledOnce();

    transport.finish({ status: "succeeded" });
    for (;;) {
      if ((await nextEvent(iterator)).type === "turn.completed") break;
    }
    await session.close();
  });

  it("keeps concurrent exact Context refreshes isolated between Sessions", async () => {
    const { adapter, transports } = fixture();
    const sessionA = await openSession(adapter);
    const iteratorA = sessionA.outputs[Symbol.asyncIterator]();
    await sessionA.execute(textTurn("context-a"));
    await nextEvent(iteratorA);
    await nextEvent(iteratorA);
    await nextEvent(iteratorA);
    const sessionB = await openSession(adapter);
    const iteratorB = sessionB.outputs[Symbol.asyncIterator]();
    await sessionB.execute(textTurn("context-b"));
    await nextEvent(iteratorB);
    await nextEvent(iteratorB);
    await nextEvent(iteratorB);
    const transportA = transports[0];
    const transportB = transports[1];
    if (!transportA || !transportB) throw new Error("Fake Claude transports were not created");
    transportA.contextUsage = { usedTokens: 30, maxTokens: 100, model: "a" };
    transportB.contextUsage = { usedTokens: 90, maxTokens: 200, model: "b" };

    await Promise.all([sessionA.refreshUsage?.(), sessionB.refreshUsage?.()]);
    expect(transportA.getContextUsage).toHaveBeenCalledOnce();
    expect(transportB.getContextUsage).toHaveBeenCalledOnce();
    expect(await nextEvent(iteratorA)).toMatchObject({
      usage: { contextUsedTokens: 30, contextWindowTokens: 100 },
    });
    expect(await nextEvent(iteratorB)).toMatchObject({
      usage: { contextUsedTokens: 90, contextWindowTokens: 200 },
    });

    transportA.finish({ status: "succeeded" });
    transportB.finish({ status: "succeeded" });
    for (;;) if ((await nextEvent(iteratorA)).type === "turn.completed") break;
    for (;;) if ((await nextEvent(iteratorB)).type === "turn.completed") break;
    await sessionA.close();
    await sessionB.close();
  });

  it("deduplicates concurrent exact Context reads and applies failure cooldown", async () => {
    vi.useFakeTimers();
    try {
      const { adapter, transports } = fixture();
      const session = await openSession(adapter);
      const iterator = session.outputs[Symbol.asyncIterator]();
      await session.execute(textTurn("exact-context-failure"));
      await nextEvent(iterator);
      await nextEvent(iterator);
      await nextEvent(iterator);
      const transport = transports[0];
      if (!transport) throw new Error("Fake Claude transport was not created");
      transport.getContextUsage.mockResolvedValue(null);

      const first = session.refreshUsage?.();
      const second = session.refreshUsage?.();
      await vi.advanceTimersByTimeAsync(3_000);
      await Promise.all([first, second]);
      expect(transport.getContextUsage).toHaveBeenCalledTimes(3);
      await session.refreshUsage?.();
      expect(transport.getContextUsage).toHaveBeenCalledTimes(3);

      transport.finish({ status: "succeeded" });
      for (;;) {
        if ((await nextEvent(iterator)).type === "turn.completed") break;
      }
      await session.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("discards exact Context that resolves after the Model generation changes", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();
    await session.execute(textTurn("stale-context"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    const transport = transports[0];
    if (!transport) throw new Error("Fake Claude transport was not created");
    transport.finish({ status: "succeeded" });
    await nextEvent(iterator);
    await nextEvent(iterator);

    const pending = deferred<ClaudeTransportContextUsage | null>();
    transport.getContextUsage.mockImplementationOnce(() => pending.promise);
    const refresh = session.refreshUsage?.();
    const alias = encodeClaudeModelRef("sonnet");
    await expect(session.execute({ type: "model.select", model: alias })).resolves.toEqual({
      ok: true,
      value: { completed: true },
    });
    await nextEvent(iterator);
    pending.resolve({ usedTokens: 10, maxTokens: 100, model: "old" });
    await refresh;
    expect(transport.getContextUsage).toHaveBeenCalledOnce();
    await session.close();
  });

  it("recovers request Usage from the transcript when the live Assistant Usage is sparse", async () => {
    vi.useFakeTimers();
    try {
      const { adapter, history, transports } = fixture();
      const session = await openSession(adapter);
      const iterator = session.outputs[Symbol.asyncIterator]();
      await session.execute(textTurn("transcript-cache-hit"));
      await nextEvent(iterator);
      await nextEvent(iterator);
      await nextEvent(iterator);
      const transport = transports[0];
      if (!transport) throw new Error("Fake Claude transport was not created");

      transport.event({ type: "message.completed", messageId: "native-request-1" });
      await vi.advanceTimersByTimeAsync(0);
      history.push({
        type: "assistant",
        request_id: "request-1",
        uuid: "assistant-checkpoint-1",
        session_id: "claude-id-1",
        parent_tool_use_id: null,
        provider: "firstParty",
        message: {
          id: "native-request-1",
          model: "claude-sonnet-4-6",
          role: "assistant",
          content: [{ type: "text", text: "working" }],
          usage: {
            input_tokens: 10,
            output_tokens: 2,
            cache_creation_input_tokens: 20,
            cache_read_input_tokens: 70,
          },
        },
      });
      await vi.advanceTimersByTimeAsync(100);
      expect(await nextEvent(iterator)).toMatchObject({
        type: "session.usage.changed",
        usage: { cacheHitRatePercent: 70, inputTokens: 100, outputTokens: 2 },
      });
      transport.finish({ status: "succeeded" });
      for (;;) {
        if ((await nextEvent(iterator)).type === "turn.completed") break;
      }
      await session.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("omits cache hit rate when last-request cache fields are incomplete", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();

    await session.execute(textTurn("usage-incomplete-cache"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    const transport = transports[0];
    if (!transport) throw new Error("Fake Claude transport was not created");
    transport.event({
      type: "usage.result",
      totalCostUsd: 0.5,
      modelUsage: [{ inputTokens: 10, outputTokens: 2 }],
    });
    expect(await nextEvent(iterator)).toEqual({
      type: "session.usage.changed",
      observedForTurnId: "usage-incomplete-cache",
      usage: { totalCostUsd: 0.5, inputTokens: 10, outputTokens: 2 },
    });
    transport.finish({ status: "succeeded" });
    expect((await nextEvent(iterator)).type).toBe("item.completed");
    expect((await nextEvent(iterator)).type).toBe("turn.completed");
    await session.close();
  });

  it("publishes a Claude.ai five-hour plan window and preserves it across a later seven-day window", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();

    await session.execute(textTurn("plan-turn"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    const transport = transports[0];
    if (!transport) throw new Error("Fake Claude transport was not created");

    transport.planLimit({
      fiveHour: { utilizationPercent: 45, resetsAtUnix: 1_756_130_400 },
    });
    expect(await nextEvent(iterator)).toEqual({
      type: "session.usage.changed",
      observedForTurnId: "plan-turn",
      usage: { planFiveHourUsedPercent: 45, planFiveHourResetsAtUnix: 1_756_130_400 },
    });

    transport.planLimit({ sevenDay: { utilizationPercent: 12 } });
    expect(await nextEvent(iterator)).toEqual({
      type: "session.usage.changed",
      observedForTurnId: "plan-turn",
      usage: {
        planFiveHourUsedPercent: 45,
        planFiveHourResetsAtUnix: 1_756_130_400,
        planSevenDayUsedPercent: 12,
      },
    });

    transport.finish({ status: "succeeded" });
    await nextEvent(iterator);
    await nextEvent(iterator);
    await session.close();
  });

  it("publishes both plan windows from a single rate-limit event", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();

    await session.execute(textTurn("plan-both-windows"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    const transport = transports[0];
    if (!transport) throw new Error("Fake Claude transport was not created");

    transport.planLimit({
      fiveHour: { utilizationPercent: 28, resetsAtUnix: 1_787_674_200 },
      sevenDay: { utilizationPercent: 10, resetsAtUnix: 1_787_940_000 },
    });
    expect(await nextEvent(iterator)).toEqual({
      type: "session.usage.changed",
      observedForTurnId: "plan-both-windows",
      usage: {
        planFiveHourUsedPercent: 28,
        planFiveHourResetsAtUnix: 1_787_674_200,
        planSevenDayUsedPercent: 10,
        planSevenDayResetsAtUnix: 1_787_940_000,
      },
    });

    transport.finish({ status: "succeeded" });
    await nextEvent(iterator);
    await nextEvent(iterator);
    await session.close();
  });

  it("never publishes plan-window fields for an API-key Session that receives no rate-limit event", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();

    await session.execute(textTurn("api-key-turn"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    const transport = transports[0];
    if (!transport) throw new Error("Fake Claude transport was not created");
    transport.event({ type: "usage.result", totalCostUsd: 0.2 });
    const resultUsage = await nextEvent(iterator);
    transport.finish({ status: "succeeded" });

    expect((await nextEvent(iterator)).type).toBe("item.completed");
    expect((await nextEvent(iterator)).type).toBe("turn.completed");
    for (const event of [resultUsage]) {
      if (event.type !== "session.usage.changed" || event.usage === null) {
        throw new Error("Expected a Session Usage snapshot");
      }
      expect(event.usage).not.toHaveProperty("planFiveHourUsedPercent");
      expect(event.usage).not.toHaveProperty("planSevenDayUsedPercent");
    }
    await session.close();
  });

  it("drops a malformed plan-limit observation without touching the latest still-applicable Usage", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();

    await session.execute(textTurn("plan-malformed"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    const transport = transports[0];
    if (!transport) throw new Error("Fake Claude transport was not created");

    transport.planLimit({ fiveHour: { utilizationPercent: 30 } });
    expect(await nextEvent(iterator)).toEqual({
      type: "session.usage.changed",
      observedForTurnId: "plan-malformed",
      usage: { planFiveHourUsedPercent: 30 },
    });

    transport.planLimit({ fiveHour: { utilizationPercent: Number.NaN } });
    transport.finish({ status: "succeeded" });
    expect((await nextEvent(iterator)).type).toBe("item.completed");
    expect((await nextEvent(iterator)).type).toBe("turn.completed");
    await session.close();
  });

  it("has no plan usage on the Adapter before any rate-limit event is observed", () => {
    const { adapter } = fixture();
    expect(adapter.credits()).toBeNull();
  });

  it("projects the five-hour window as the primary credits pill, with the seven-day window riding along", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();

    await session.execute(textTurn("credits-turn"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    const transport = transports[0];
    if (!transport) throw new Error("Fake Claude transport was not created");

    transport.planLimit({
      fiveHour: { utilizationPercent: 62, resetsAtUnix: 1_756_130_400 },
      sevenDay: { utilizationPercent: 18, resetsAtUnix: 1_756_648_800 },
    });
    await nextEvent(iterator);

    expect(adapter.credits()).toEqual({
      usedPercent: 62,
      periodType: "five_hour",
      resetsAt: new Date(1_756_130_400 * 1000).toISOString(),
      productUsage: [
        {
          product: "7-day window",
          usagePercent: 18,
          resetsAt: new Date(1_756_648_800 * 1000).toISOString(),
        },
      ],
    });

    transport.finish({ status: "succeeded" });
    await nextEvent(iterator);
    await nextEvent(iterator);
    await session.close();
  });

  it("falls back to the seven-day window alone when no five-hour observation has arrived", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();

    await session.execute(textTurn("seven-day-only"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    const transport = transports[0];
    if (!transport) throw new Error("Fake Claude transport was not created");

    transport.planLimit({ sevenDay: { utilizationPercent: 41 } });
    await nextEvent(iterator);

    expect(adapter.credits()).toEqual({ usedPercent: 41, periodType: "seven_day" });

    transport.finish({ status: "succeeded" });
    await nextEvent(iterator);
    await nextEvent(iterator);
    await session.close();
  });

  it("shares one account-wide plan-limit cache across concurrent Sessions", async () => {
    const { adapter, transports } = fixture();
    const sessionA = await openSession(adapter);
    const iteratorA = sessionA.outputs[Symbol.asyncIterator]();
    await sessionA.execute(textTurn("session-a"));
    await nextEvent(iteratorA);
    await nextEvent(iteratorA);
    await nextEvent(iteratorA);
    const transportA = transports[0];
    if (!transportA) throw new Error("Fake Claude transport was not created");

    const sessionB = await openSession(adapter);
    const iteratorB = sessionB.outputs[Symbol.asyncIterator]();
    await sessionB.execute(textTurn("session-b"));
    await nextEvent(iteratorB);
    await nextEvent(iteratorB);
    await nextEvent(iteratorB);
    const transportB = transports[1];
    if (!transportB) throw new Error("Fake Claude transport was not created");

    transportA.planLimit({ fiveHour: { utilizationPercent: 33 } });
    await nextEvent(iteratorA);

    // Session B never observed a rate-limit event itself, but reads the same account-wide value.
    expect(adapter.credits()).toEqual({ usedPercent: 33, periodType: "five_hour" });

    transportA.finish({ status: "succeeded" });
    await nextEvent(iteratorA);
    await nextEvent(iteratorA);
    transportB.finish({ status: "succeeded" });
    await nextEvent(iteratorB);
    await nextEvent(iteratorB);
    await sessionA.close();
    await sessionB.close();
  });
});
