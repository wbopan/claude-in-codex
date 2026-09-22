import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  DESKTOP_USAGE_PATH,
  DesktopUsagePublisher,
  codexUsageRows,
  desktopUiLanguage,
  formatResetIn,
  parseAppleLanguages,
  harnessUsageBuckets,
  harnessUsageRows,
  type HarnessUsageReport,
} from "../src/desktop-usage-buckets.js";

const fixture = readFileSync(path.join(import.meta.dirname, "fixtures/wham-usage.json"), "utf8");
const CLAUDE_OPUS = "codexhost/claude-code-native@claude-model-v1.b3B1c1sxbV0";
const CLAUDE_SONNET = "codexhost/claude-code-native@claude-model-v1.c29ubmV0";
const NOW = Date.parse("2026-09-22T05:00:00Z");

const claudeAccount = {
  email: "claude@example.com",
  plan: "max",
  credits: {
    usedPercent: 42.4,
    periodType: "five_hour" as const,
    resetsAt: "2026-09-22T07:30:00Z",
    productUsage: [
      { product: "7-day window", usagePercent: 17.6, resetsAt: "2026-09-26T00:00:00Z" },
      { product: "Opus · 7-day", usagePercent: 9 },
    ],
  },
};

// The renderer's parsing, transcribed from the shipped Desktop bundle (NFa/RFa/zFa/jFa/yq).
function yq(value: string): string {
  return value.toLowerCase().replace(/[_\s.]+/gu, "-");
}
function rendererEntries(response: Record<string, unknown>) {
  const window = (w: Record<string, unknown> | null | undefined) =>
    w
      ? {
          usedPercent: (w.used_percent as number) ?? 0,
          windowMinutes: (w.limit_window_seconds as number) / 60,
          resetAt: w.reset_at as number | null,
        }
      : null;
  const entry = (limitName: string, limit: Record<string, unknown>) => ({
    limitName,
    blocked: limit.limit_reached === true || limit.allowed === false,
    primary: window(limit.primary_window as Record<string, unknown> | null),
    secondary: window(limit.secondary_window as Record<string, unknown> | null),
  });
  const entries = [entry("codex", response.rate_limit as Record<string, unknown>)];
  for (const item of (response.additional_rate_limits as Record<string, unknown>[] | null) ?? []) {
    if (!item.rate_limit || !String(item.limit_name ?? "").trim()) continue;
    entries.push(entry(item.limit_name as string, item.rate_limit as Record<string, unknown>));
  }
  return entries;
}
function rendererLimitFor(response: Record<string, unknown>, selectedModel: string) {
  return rendererEntries(response).filter((e) => yq(e.limitName) === yq(selectedModel));
}

describe("harnessUsageBuckets", () => {
  it("publishes the 5-hour window as primary and the 7-day window as secondary", () => {
    const buckets = harnessUsageBuckets({
      account: claudeAccount,
      limitNames: [CLAUDE_OPUS, CLAUDE_SONNET, CLAUDE_OPUS, " "],
      now: NOW,
    });
    expect(buckets.map((bucket) => bucket.limit_name)).toEqual([CLAUDE_OPUS, CLAUDE_SONNET]);
    expect(buckets[0]!.rate_limit).toEqual({
      allowed: true,
      limit_reached: false,
      primary_window: {
        used_percent: 42,
        limit_window_seconds: 18_000,
        reset_at: Math.floor(Date.parse("2026-09-22T07:30:00Z") / 1000),
        reset_after_seconds: 9_000,
      },
      secondary_window: {
        used_percent: 18,
        limit_window_seconds: 604_800,
        reset_at: Math.floor(Date.parse("2026-09-26T00:00:00Z") / 1000),
        reset_after_seconds: 327_600,
      },
    });
  });

  it("publishes a weekly-only account without a secondary window and tolerates missing resets", () => {
    const [bucket] = harnessUsageBuckets({
      account: { credits: { usedPercent: 99.6, periodType: "seven_day" } },
      limitNames: [CLAUDE_OPUS],
    });
    expect(bucket!.rate_limit).toEqual({
      allowed: true,
      limit_reached: false,
      primary_window: {
        used_percent: 100,
        limit_window_seconds: 604_800,
        reset_at: null,
        reset_after_seconds: null,
      },
      secondary_window: null,
    });
  });

  it("publishes nothing without an account, a known window, or limit names", () => {
    expect(harnessUsageBuckets({ account: null, limitNames: [CLAUDE_OPUS] })).toEqual([]);
    expect(
      harnessUsageBuckets({
        account: { credits: { usedPercent: 1, periodType: "unknown" } },
        limitNames: [CLAUDE_OPUS],
      }),
    ).toEqual([]);
    expect(harnessUsageBuckets({ account: claudeAccount, limitNames: [] })).toEqual([]);
  });

  it("caps the bucket count", () => {
    const names = Array.from({ length: 80 }, (_, i) => `model-${i}`);
    expect(harnessUsageBuckets({ account: claudeAccount, limitNames: names })).toHaveLength(64);
  });
});

describe("harnessUsageRows", () => {
  it("renders the primary, the 7-day and product-scoped windows with reset hovers", () => {
    expect(
      harnessUsageRows({ harnessName: "Claude Code", account: claudeAccount, now: NOW }),
    ).toEqual([
      {
        label: "Claude 5-hour",
        value: { text: "58% left", tone: "neutral" },
        hover: { text: "Resets in 2h 30m" },
      },
      {
        label: "Claude 7-day",
        value: { text: "82% left", tone: "neutral" },
        hover: { text: "Resets in 3d 19h" },
      },
      { label: "Opus 7-day", value: { text: "91% left", tone: "neutral" } },
    ]);
  });

  it("uses a model-scoped primary label and warns near the limit", () => {
    expect(
      harnessUsageRows({
        harnessName: "Claude Code",
        account: { credits: { usedPercent: 95, periodType: "seven_day", label: "Opus · 7-day" } },
      }),
    ).toEqual([{ label: "Opus 7-day", value: { text: "5% left", tone: "warning" } }]);
    expect(harnessUsageRows({ harnessName: "Claude Code", account: null })).toEqual([]);
    expect(formatResetIn(30)).toBe("Resets in 1m");
  });

  it("localises labels, values and hovers for a Chinese Desktop", () => {
    expect(
      harnessUsageRows({
        harnessName: "Claude Code",
        account: claudeAccount,
        language: "zh-CN",
        now: NOW,
      }),
    ).toEqual([
      {
        label: "Claude 5 小时",
        value: { text: "剩余 58%", tone: "neutral" },
        hover: { text: "2 小时 30 分钟后重置" },
      },
      {
        label: "Claude 7 天",
        value: { text: "剩余 82%", tone: "neutral" },
        hover: { text: "3 天 19 小时后重置" },
      },
      { label: "Opus 7 天", value: { text: "剩余 91%", tone: "neutral" } },
    ]);
    const response = JSON.parse(fixture) as Record<string, unknown>;
    expect(codexUsageRows(response, NOW, "zh")).toEqual([
      {
        label: "Codex 7 天",
        value: { text: "剩余 73%", tone: "neutral" },
        hover: { text: "4 天 7 小时后重置" },
      },
    ]);
  });

  it("reads the Desktop UI language from the override or the macOS preferred language", () => {
    expect(parseAppleLanguages('(\n    "zh-Hans-CN",\n    "en-US"\n)\n')).toBe("zh-Hans-CN");
    expect(parseAppleLanguages("(\n    en\n)\n")).toBe("en");
    expect(parseAppleLanguages("")).toBeNull();
    expect(desktopUiLanguage({ CODEXHOST_DESKTOP_LANGUAGE: " ja " }, "linux")).toBe("ja");
    expect(desktopUiLanguage({}, "linux")).toBeNull();
  });

  it("mirrors the core Codex windows of the live response", () => {
    const response = JSON.parse(fixture) as Record<string, unknown>;
    expect(codexUsageRows(response, NOW)).toEqual([
      {
        label: "Codex 7-day",
        value: { text: "73% left", tone: "neutral" },
        hover: { text: "Resets in 4d 7h" },
      },
    ]);
    expect(codexUsageRows({}, NOW)).toEqual([]);
  });
});

describe("DesktopUsagePublisher", () => {
  const headers = { "content-type": "application/json" };
  const claudeReport: HarnessUsageReport = {
    harnessName: "Claude Code",
    limitNames: [CLAUDE_OPUS, CLAUDE_SONNET],
    account: claudeAccount,
  };
  function publisher(reports: () => Promise<HarnessUsageReport[]>) {
    const usage = new DesktopUsagePublisher({ now: () => NOW });
    usage.attach(reports);
    return usage;
  }
  const claudeReports = () => Promise.resolve([claudeReport]);

  it("matches only the usage GET", () => {
    const usage = new DesktopUsagePublisher();
    expect(usage.matches({ method: "GET", path: DESKTOP_USAGE_PATH })).toBe(true);
    expect(usage.matches({ method: "POST", path: DESKTOP_USAGE_PATH })).toBe(false);
    expect(usage.matches({ method: "GET", path: "/backend-api/wham/accounts/check" })).toBe(false);
  });

  it("appends buckets and builds the ambient usage section on the live response shape", async () => {
    const rewritten = await publisher(claudeReports).rewrite({
      status: 200,
      headers,
      body: Buffer.from(fixture),
    });
    expect(rewritten).not.toBeNull();
    const response = JSON.parse(rewritten!.toString()) as Record<string, unknown>;
    const original = JSON.parse(fixture) as Record<string, unknown>;
    const { ambient_usage, ...rest } = response;
    expect({ ...rest, additional_rate_limits: null }).toEqual(original);
    expect(response.additional_rate_limits).toHaveLength(2);
    expect(ambient_usage).toEqual({
      default: {
        profile_subtext: null,
        menu: {
          actions: [],
          rows: [
            {
              label: "Codex 7-day",
              value: { text: "73% left", tone: "neutral" },
              hover: { text: "Resets in 4d 7h" },
            },
            {
              label: "Claude 5-hour",
              value: { text: "58% left", tone: "neutral" },
              hover: { text: "Resets in 2h 30m" },
            },
            {
              label: "Claude 7-day",
              value: { text: "82% left", tone: "neutral" },
              hover: { text: "Resets in 3d 19h" },
            },
            { label: "Opus 7-day", value: { text: "91% left", tone: "neutral" } },
          ],
        },
      },
    });

    // What the renderer shows: a Claude Thread sees the Claude windows, a GPT Thread only its own.
    const claude = rendererLimitFor(response, CLAUDE_OPUS);
    expect(claude).toEqual([
      {
        limitName: CLAUDE_OPUS,
        blocked: false,
        primary: { usedPercent: 42, windowMinutes: 300, resetAt: 1_790_062_200 },
        secondary: { usedPercent: 18, windowMinutes: 10_080, resetAt: 1_790_380_800 },
      },
    ]);
    expect(rendererLimitFor(response, "gpt-5.5")).toEqual([]);
    expect(rendererLimitFor(response, "codex")).toEqual(rendererLimitFor(original, "codex"));
    expect(rendererEntries(response).some((entry) => entry.blocked)).toBe(false);
  });

  it("builds the ambient section in the Desktop's language", async () => {
    const rewritten = await publisher(claudeReports).rewrite(
      { status: 200, headers, body: Buffer.from(fixture) },
      { language: "zh-CN" },
    );
    const response = JSON.parse(rewritten!.toString()) as {
      ambient_usage: {
        default: {
          profile_subtext: string | null;
          menu: { rows: { label: string; value: { text: string } }[] };
        };
      };
    };
    expect(response.ambient_usage.default.profile_subtext).toBeNull();
    expect(
      response.ambient_usage.default.menu.rows.map((row) => `${row.label} ${row.value.text}`),
    ).toEqual([
      "Codex 7 天 剩余 73%",
      "Claude 5 小时 剩余 58%",
      "Claude 7 天 剩余 82%",
      "Opus 7 天 剩余 91%",
    ]);
  });

  it("prefers a configured language over the request's", async () => {
    const usage = new DesktopUsagePublisher({ language: "zh-CN", now: () => NOW });
    usage.attach(claudeReports);
    const rewritten = await usage.rewrite(
      { status: 200, headers, body: Buffer.from(fixture) },
      { language: "en-US" },
    );
    const response = JSON.parse(rewritten!.toString()) as {
      ambient_usage: { default: { menu: { rows: { label: string }[] } } };
    };
    expect(response.ambient_usage.default.menu.rows[0]!.label).toBe("Codex 7 天");
  });

  it("extends a server-sent ambient usage section instead of replacing it", async () => {
    const body = JSON.stringify({
      rate_limit: {
        allowed: true,
        primary_window: { used_percent: 27, limit_window_seconds: 604800 },
      },
      ambient_usage: {
        default: {
          profile_subtext: "native subtext",
          menu: {
            rows: [{ label: "Native", value: { text: "1% left", tone: "neutral" } }],
            actions: [{ action: "invite" }],
          },
        },
        extra: "kept",
      },
    });
    const rewritten = await publisher(claudeReports).rewrite({
      status: 200,
      headers,
      body: Buffer.from(body),
    });
    const response = JSON.parse(rewritten!.toString()) as {
      ambient_usage: {
        extra: string;
        default: {
          profile_subtext: string;
          menu: { rows: { label: string }[]; actions: unknown[] };
        };
      };
    };
    expect(response.ambient_usage.extra).toBe("kept");
    expect(response.ambient_usage.default.profile_subtext).toBe("native subtext");
    expect(response.ambient_usage.default.menu.actions).toEqual([{ action: "invite" }]);
    expect(response.ambient_usage.default.menu.rows.map((row) => row.label)).toEqual([
      "Native",
      "Claude 5-hour",
      "Claude 7-day",
      "Opus 7-day",
    ]);
  });

  it("keeps existing bucket entries, skips duplicate limit names, and leaves odd shapes alone", async () => {
    const body = JSON.stringify({
      rate_limit: { allowed: true },
      ambient_usage: { unexpected: true },
      additional_rate_limits: [
        { limit_name: CLAUDE_OPUS, rate_limit: { allowed: true, note: "native" } },
        { limit_name: "codex-auto-review", rate_limit: { allowed: true } },
      ],
    });
    const rewritten = await publisher(claudeReports).rewrite({
      status: 200,
      headers,
      body: Buffer.from(body),
    });
    const response = JSON.parse(rewritten!.toString()) as {
      ambient_usage: unknown;
      additional_rate_limits: { limit_name: string; rate_limit: unknown }[];
    };
    expect(response.ambient_usage).toEqual({ unexpected: true });
    expect(response.additional_rate_limits.map((entry) => entry.limit_name)).toEqual([
      CLAUDE_OPUS,
      "codex-auto-review",
      CLAUDE_SONNET,
    ]);
    expect(response.additional_rate_limits[0]!.rate_limit).toEqual({
      allowed: true,
      note: "native",
    });
    const odd = await publisher(claudeReports).rewrite({
      status: 200,
      headers,
      body: Buffer.from(
        '{"additional_rate_limits":{"unexpected":true},"ambient_usage":{"unexpected":true}}',
      ),
    });
    expect(odd).toBeNull();
  });

  it("sends the original bytes for anything it does not understand", async () => {
    const usage = publisher(claudeReports);
    const body = Buffer.from(fixture);
    await expect(usage.rewrite({ status: 401, headers, body })).resolves.toBeNull();
    await expect(
      usage.rewrite({ status: 200, headers: { "content-type": "text/html" }, body }),
    ).resolves.toBeNull();
    await expect(
      usage.rewrite({ status: 200, headers, body: Buffer.from("{not json") }),
    ).resolves.toBeNull();
    await expect(
      usage.rewrite({ status: 200, headers, body: Buffer.from("[1,2]") }),
    ).resolves.toBeNull();
    await expect(
      publisher(() => Promise.reject(new Error("boom"))).rewrite({ status: 200, headers, body }),
    ).resolves.toBeNull();
    await expect(
      publisher(() => Promise.resolve([])).rewrite({ status: 200, headers, body }),
    ).resolves.toBeNull();
    await expect(
      publisher(() => Promise.resolve([{ ...claudeReport, account: null }])).rewrite({
        status: 200,
        headers,
        body,
      }),
    ).resolves.toBeNull();
    usage.detach();
    await expect(usage.rewrite({ status: 200, headers, body })).resolves.toBeNull();
    await expect(
      new DesktopUsagePublisher().rewrite({ status: 200, headers, body }),
    ).resolves.toBeNull();
  });
});
