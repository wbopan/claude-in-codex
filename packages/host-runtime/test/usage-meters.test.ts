import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { accountUsageMeters, codexUsageMeters } from "../src/hot-attach/usage-meters.js";

const fixture = JSON.parse(
  readFileSync(path.join(import.meta.dirname, "fixtures/wham-usage.json"), "utf8"),
) as Record<string, unknown>;

describe("MenuBar usage meters", () => {
  it("reads the structured Codex windows, shortest first", () => {
    expect(codexUsageMeters(fixture)).toEqual([
      {
        source: "codex",
        window: "weekly",
        remainingPercent: 73,
        resetsAt: new Date(1790428044 * 1000).toISOString(),
      },
    ]);
    const both = {
      rate_limit: {
        primary_window: { used_percent: 30, limit_window_seconds: 604800, reset_at: 2000 },
        secondary_window: {
          used_percent: 90,
          limit_window_seconds: 18000,
          reset_after_seconds: 60,
        },
      },
    };
    expect(
      codexUsageMeters(both, 1_000_000).map((meter) => [
        meter.window,
        meter.remainingPercent,
        meter.resetsAt,
      ]),
    ).toEqual([
      ["five_hour", 10, new Date(1_060_000).toISOString()],
      ["weekly", 70, new Date(2_000_000).toISOString()],
    ]);
  });

  it("keeps server-driven rows as text when no window is structured", () => {
    const meters = codexUsageMeters({
      rate_limit: null,
      ambient_usage: {
        default: {
          menu: {
            rows: [
              { label: "Codex · weekly", value: { text: "72% left", tone: "neutral" } },
              { label: "Credits", value: { text: "12 used", tone: "neutral" } },
            ],
          },
        },
      },
    });
    expect(meters).toEqual([
      {
        source: "codex",
        window: null,
        label: "Codex · weekly",
        text: "72% left",
        remainingPercent: 72,
        resetsAt: null,
      },
      {
        source: "codex",
        window: null,
        label: "Credits",
        text: "12 used",
        remainingPercent: null,
        resetsAt: null,
      },
    ]);
    expect(codexUsageMeters("not usage")).toEqual([]);
  });

  it("splits a Claude account into its 5-hour, weekly and model-scoped windows", () => {
    expect(
      accountUsageMeters("claude-code", {
        usedPercent: 44,
        periodType: "five_hour",
        resetsAt: "2026-09-23T06:30:00.000Z",
        productUsage: [
          { product: "7-day window", usagePercent: 21, resetsAt: "2026-09-28T01:00:00.000Z" },
          { product: "Fable · 7-day", usagePercent: 30 },
        ],
      }),
    ).toEqual([
      {
        source: "claude-code",
        window: "five_hour",
        remainingPercent: 56,
        resetsAt: "2026-09-23T06:30:00.000Z",
      },
      {
        source: "claude-code",
        window: "weekly",
        remainingPercent: 79,
        resetsAt: "2026-09-28T01:00:00.000Z",
      },
      {
        source: "claude-code",
        window: "weekly",
        scope: "Fable",
        remainingPercent: 70,
        resetsAt: null,
      },
    ]);
    expect(
      accountUsageMeters("claude-code", {
        usedPercent: 10,
        periodType: "seven_day",
        label: "Opus · 7-day",
      }),
    ).toEqual([
      {
        source: "claude-code",
        window: "weekly",
        scope: "Opus",
        remainingPercent: 90,
        resetsAt: null,
      },
    ]);
  });
});
