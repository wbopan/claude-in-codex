import { execFileSync } from "node:child_process";
import type { IncomingHttpHeaders } from "node:http";

import type { JsonObject } from "@codexhost/protocol-core";
import type { AccountCreditsSnapshot, HarnessAccountSnapshot } from "@codexhost/shared-contracts";

import type { DesktopBackendRewrite, DesktopRewriteRequest } from "./desktop-backend-proxy.js";

/**
 * Phase B of the Desktop backend proxy: the only response rewrite. Two native surfaces read
 * `GET /backend-api/wham/usage`:
 *
 * - `additional_rate_limits[]`: per-Model windows keyed by `limit_name`; the profile menu's
 *   "Usage remaining" submenu shows the entry matching the selected Model. Each Harness with
 *   account telemetry contributes one entry per route id it publishes in `model/list`. Entries
 *   are inert for every other Model: `allowed` stays true and `limit_reached` false.
 * - `ambient_usage.default`: a server-driven "Usage" section (rows of label/value/hover) in the
 *   profile menu. The Desktop renders it whenever present, on every account shape, so this is
 *   where Harness usage becomes visible. When the backend sends none, the section is built here
 *   with the core Codex window first so nothing the native menu used to show is lost; when it
 *   does, Harness rows are appended. The account footer stays native: no `profile_subtext` is
 *   invented, a server-sent one is kept.
 */
export const DESKTOP_USAGE_PATH = "/backend-api/wham/usage";
const MAX_BUCKETS = 64;
const MAX_ROWS_PER_HARNESS = 6;
const SECONDS_PER_WINDOW: Record<AccountCreditsSnapshot["periodType"], number | null> = {
  five_hour: 5 * 60 * 60,
  seven_day: 7 * 24 * 60 * 60,
  weekly: 7 * 24 * 60 * 60,
  monthly: 30 * 24 * 60 * 60,
  unknown: null,
};
const SEVEN_DAY_PRODUCT = "7-day window";
const WARNING_USED_PERCENT = 90;

interface UsageWindow {
  used_percent: number;
  limit_window_seconds: number;
  reset_at: number | null;
  reset_after_seconds: number | null;
}

/** What a Harness contributes; the publisher formats it for both surfaces. */
export interface HarnessUsageReport {
  harnessName: string;
  limitNames: readonly string[];
  account: HarnessAccountSnapshot | null;
}

export interface AmbientUsageRow {
  label: string;
  value: { text: string; tone: "neutral" | "warning" };
  hover?: { text: string };
}

function unixSeconds(iso: string | undefined): number | null {
  if (!iso) return null;
  const millis = Date.parse(iso);
  return Number.isFinite(millis) ? Math.floor(millis / 1000) : null;
}

function usageWindow(
  usedPercent: number,
  seconds: number | null,
  resetsAt: string | undefined,
  now: number,
): UsageWindow | null {
  if (seconds === null) return null;
  const resetAt = unixSeconds(resetsAt);
  return {
    used_percent: Math.round(usedPercent),
    limit_window_seconds: seconds,
    reset_at: resetAt,
    reset_after_seconds: resetAt === null ? null : Math.max(0, resetAt - Math.floor(now / 1000)),
  };
}

/** The account's primary window plus its 7-day window when the primary is the 5-hour one. */
export function accountUsageWindows(
  credits: AccountCreditsSnapshot,
  now = Date.now(),
): { primary: UsageWindow; secondary: UsageWindow | null } | null {
  const primary = usageWindow(
    credits.usedPercent,
    SECONDS_PER_WINDOW[credits.periodType],
    credits.resetsAt,
    now,
  );
  if (!primary) return null;
  const weekly =
    credits.periodType === "five_hour"
      ? credits.productUsage?.find((product) => product.product === SEVEN_DAY_PRODUCT)
      : undefined;
  const secondary = weekly
    ? usageWindow(weekly.usagePercent, SECONDS_PER_WINDOW.seven_day, weekly.resetsAt, now)
    : null;
  return { primary, secondary };
}

export function harnessUsageBuckets(input: {
  account: HarnessAccountSnapshot | null;
  limitNames: readonly string[];
  now?: number;
}): JsonObject[] {
  if (!input.account) return [];
  const windows = accountUsageWindows(input.account.credits, input.now);
  if (!windows) return [];
  const rateLimit: JsonObject = {
    allowed: true,
    limit_reached: false,
    primary_window: { ...windows.primary },
    secondary_window: windows.secondary ? { ...windows.secondary } : null,
  };
  const names = [...new Set(input.limitNames.filter((name) => name.trim().length > 0))];
  return names.slice(0, MAX_BUCKETS).map((limit_name) => ({ limit_name, rate_limit: rateLimit }));
}

type WindowKind = "five_hour" | "weekly" | "monthly" | { hours: number } | { days: number };

interface UsageMessages {
  window(kind: WindowKind): string;
  left(percent: number): string;
  resetsIn(days: number, hours: number, minutes: number): string;
  /** A product-scoped label as Claude reports it ("Opus · 7-day") becomes "Opus 7-day". */
  product(label: string): string;
}

const MESSAGES: Record<"en" | "zh", UsageMessages> = {
  en: {
    window: (kind) =>
      kind === "five_hour"
        ? "5-hour"
        : kind === "weekly"
          ? "7-day"
          : kind === "monthly"
            ? "monthly"
            : "hours" in kind
              ? `${kind.hours}-hour`
              : `${kind.days}-day`,
    left: (percent) => `${percent}% left`,
    resetsIn: (days, hours, minutes) =>
      days > 0
        ? `Resets in ${days}d ${hours}h`
        : hours > 0
          ? `Resets in ${hours}h ${minutes}m`
          : `Resets in ${Math.max(minutes, 1)}m`,
    product: (label) => label.replace(/\s*·\s*/gu, " "),
  },
  zh: {
    window: (kind) =>
      kind === "five_hour"
        ? "5 小时"
        : kind === "weekly"
          ? "7 天"
          : kind === "monthly"
            ? "每月"
            : "hours" in kind
              ? `${kind.hours} 小时`
              : `${kind.days} 天`,
    left: (percent) => `剩余 ${percent}%`,
    resetsIn: (days, hours, minutes) =>
      days > 0
        ? `${days} 天 ${hours} 小时后重置`
        : hours > 0
          ? `${hours} 小时 ${minutes} 分钟后重置`
          : `${Math.max(minutes, 1)} 分钟后重置`,
    product: (label) =>
      label
        .replace(/\s*·\s*/gu, " ")
        .replace(/(\d+)-day\b/u, "$1 天")
        .replace(/(\d+)-hour\b/u, "$1 小时"),
  },
};

export const DESKTOP_LANGUAGE_ENV = "CODEXHOST_DESKTOP_LANGUAGE";

/** First entry of a `defaults read -g AppleLanguages` listing, e.g. `zh-Hans-CN`. */
export function parseAppleLanguages(output: string): string | null {
  const match = /"?([A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})*)"?\s*(?:,|\))/u.exec(
    output.replace(/^\s*\(/u, ""),
  );
  return match?.[1] ?? null;
}

/**
 * The Desktop renders its UI in the macOS preferred language (its `systemLocale`), while its
 * backend requests carry the Chromium locale (`en-US` here), so the header is not the UI
 * language. `CODEXHOST_DESKTOP_LANGUAGE` overrides; other platforms fall back to the request.
 */
export function desktopUiLanguage(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const override = environment[DESKTOP_LANGUAGE_ENV]?.trim();
  if (override) return override;
  if (platform !== "darwin") return null;
  try {
    return parseAppleLanguages(
      execFileSync("/usr/bin/defaults", ["read", "-g", "AppleLanguages"], {
        encoding: "utf8",
        timeout: 2_000,
        stdio: ["ignore", "pipe", "ignore"],
      }),
    );
  } catch {
    return null;
  }
}

export function usageMessages(language: string | null | undefined): UsageMessages {
  return language?.trim().toLowerCase().startsWith("zh") ? MESSAGES.zh : MESSAGES.en;
}

function windowKind(seconds: number): WindowKind {
  if (Math.abs(seconds - 5 * 60 * 60) <= 60) return "five_hour";
  if (Math.abs(seconds - 7 * 24 * 60 * 60) <= 60) return "weekly";
  if (Math.abs(seconds - 30 * 24 * 60 * 60) <= 3600) return "monthly";
  const hours = Math.round(seconds / 3600);
  return hours >= 48 ? { days: Math.round(hours / 24) } : { hours };
}

export function formatResetIn(seconds: number, messages: UsageMessages = MESSAGES.en): string {
  const total = Math.max(0, Math.floor(seconds));
  return messages.resetsIn(
    Math.floor(total / 86_400),
    Math.floor((total % 86_400) / 3600),
    Math.floor((total % 3600) / 60),
  );
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, Math.round(value)));
}

/** Menu rows are narrow: "Claude Code" reads as "Claude", "Gemini CLI" as "Gemini". */
function shortName(name: string): string {
  return name.trim().split(/\s+/u)[0] || name;
}

function usageRow(
  messages: UsageMessages,
  label: string,
  usedPercent: number,
  resetAfterSeconds: number | null,
): AmbientUsageRow {
  const used = clampPercent(usedPercent);
  return {
    label,
    value: {
      text: messages.left(100 - used),
      tone: used >= WARNING_USED_PERCENT ? "warning" : "neutral",
    },
    ...(resetAfterSeconds !== null
      ? { hover: { text: formatResetIn(resetAfterSeconds, messages) } }
      : {}),
  };
}

/**
 * One row per window the Harness reports: the primary, the 7-day window, then product scopes.
 * Labels are terse ("Claude 5-hour", "Claude 7-day"); a product-scoped label names its own
 * scope ("Fable 7-day"), so it carries no Harness prefix.
 */
export function harnessUsageRows(input: {
  harnessName: string;
  account: HarnessAccountSnapshot | null;
  language?: string | null;
  now?: number;
}): AmbientUsageRow[] {
  const account = input.account;
  if (!account) return [];
  const now = input.now ?? Date.now();
  const messages = usageMessages(input.language);
  const windows = accountUsageWindows(account.credits, now);
  if (!windows) return [];
  const prefix = shortName(input.harnessName);
  const rows: AmbientUsageRow[] = [
    usageRow(
      messages,
      account.credits.label
        ? messages.product(account.credits.label)
        : `${prefix} ${messages.window(windowKind(windows.primary.limit_window_seconds))}`,
      windows.primary.used_percent,
      windows.primary.reset_after_seconds,
    ),
  ];
  if (windows.secondary) {
    rows.push(
      usageRow(
        messages,
        `${prefix} ${messages.window(windowKind(windows.secondary.limit_window_seconds))}`,
        windows.secondary.used_percent,
        windows.secondary.reset_after_seconds,
      ),
    );
  }
  for (const product of account.credits.productUsage ?? []) {
    if (product.product === SEVEN_DAY_PRODUCT) continue;
    const resetAt = unixSeconds(product.resetsAt);
    rows.push(
      usageRow(
        messages,
        messages.product(product.product),
        product.usagePercent,
        resetAt === null ? null : Math.max(0, resetAt - Math.floor(now / 1000)),
      ),
    );
  }
  return rows.slice(0, MAX_ROWS_PER_HARNESS);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** The core Codex windows as rows, mirroring what the simplified native menu item shows. */
export function codexUsageRows(
  response: Record<string, unknown>,
  now = Date.now(),
  language: string | null = null,
): AmbientUsageRow[] {
  const messages = usageMessages(language);
  const rateLimit = isRecord(response.rate_limit) ? response.rate_limit : null;
  if (!rateLimit) return [];
  const rows: AmbientUsageRow[] = [];
  for (const key of ["primary_window", "secondary_window"] as const) {
    const window = isRecord(rateLimit[key]) ? rateLimit[key] : null;
    if (!window) continue;
    const used = finiteNumber(window.used_percent);
    const seconds = finiteNumber(window.limit_window_seconds);
    if (used === null || seconds === null) continue;
    const resetAt = finiteNumber(window.reset_at);
    const resetAfter =
      finiteNumber(window.reset_after_seconds) ??
      (resetAt === null ? null : Math.max(0, resetAt - Math.floor(now / 1000)));
    rows.push(
      usageRow(messages, `Codex ${messages.window(windowKind(seconds))}`, used, resetAfter),
    );
  }
  return rows;
}

function isJson(headers: IncomingHttpHeaders): boolean {
  const type = headers["content-type"];
  return typeof type === "string" && /\bjson\b/iu.test(type);
}

function ambientUsageWith(
  response: Record<string, unknown>,
  harnessRows: readonly AmbientUsageRow[],
  now: number,
  language: string | null,
): JsonObject | null {
  if (harnessRows.length === 0) return null;
  const existing = isRecord(response.ambient_usage) ? response.ambient_usage : null;
  const existingDefault = existing && isRecord(existing.default) ? existing.default : null;
  const existingMenu =
    existingDefault && isRecord(existingDefault.menu) ? existingDefault.menu : null;
  if (existing && (!existingDefault || !existingMenu || !Array.isArray(existingMenu.rows))) {
    // An unexpected server shape is left alone rather than guessed at.
    return null;
  }
  const rows: unknown[] = existingMenu
    ? [...(existingMenu.rows as unknown[]), ...harnessRows]
    : [...codexUsageRows(response, now, language), ...harnessRows];
  return {
    ...(existing ?? {}),
    default: {
      profile_subtext: null,
      ...(existingDefault ?? {}),
      menu: { ...(existingMenu ?? { actions: [] }), rows: rows as JsonObject[] },
    },
  };
}

/**
 * Appends Harness usage to the response. The original bytes are sent whenever the response is
 * not a 200 JSON object, the source is detached or fails, it yields nothing, or the fields to
 * extend have an unexpected shape.
 */
export class DesktopUsagePublisher implements DesktopBackendRewrite {
  #source: (() => Promise<HarnessUsageReport[]>) | null = null;
  readonly #now: () => number;
  readonly #language: string | null;

  constructor(options: { language?: string | null; now?: () => number } = {}) {
    this.#now = options.now ?? Date.now;
    this.#language = options.language ?? null;
  }

  attach(source: () => Promise<HarnessUsageReport[]>): void {
    this.#source = source;
  }

  detach(): void {
    this.#source = null;
  }

  /** Populate the source's native account cache before the first interactive menu read. */
  async warmup(): Promise<void> {
    await this.#source?.();
  }

  matches(request: { method: string; path: string }): boolean {
    return request.method === "GET" && request.path === DESKTOP_USAGE_PATH;
  }

  async rewrite(
    response: { status: number; headers: IncomingHttpHeaders; body: Buffer },
    request: Pick<DesktopRewriteRequest, "language"> = { language: null },
  ): Promise<Buffer | null> {
    const source = this.#source;
    if (!source || response.status !== 200 || !isJson(response.headers)) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(response.body.toString("utf8"));
    } catch {
      return null;
    }
    if (!isRecord(parsed)) return null;
    let reports: HarnessUsageReport[];
    try {
      reports = await source();
    } catch {
      return null;
    }
    const now = this.#now();
    const language = this.#language ?? request.language;
    const existing = parsed.additional_rate_limits;
    const bucketsExtendable =
      existing === undefined || existing === null || Array.isArray(existing);
    const taken = new Set(
      (Array.isArray(existing) ? existing : []).flatMap((entry) =>
        isRecord(entry) && typeof entry.limit_name === "string" ? [entry.limit_name] : [],
      ),
    );
    const buckets = bucketsExtendable
      ? reports
          .flatMap((report) =>
            harnessUsageBuckets({ account: report.account, limitNames: report.limitNames, now }),
          )
          .filter(
            (bucket) => typeof bucket.limit_name === "string" && !taken.has(bucket.limit_name),
          )
      : [];
    const rows = reports.flatMap((report) =>
      harnessUsageRows({
        harnessName: report.harnessName,
        account: report.account,
        language,
        now,
      }),
    );
    const ambient = ambientUsageWith(parsed, rows, now, language);
    if (buckets.length === 0 && !ambient) return null;
    return Buffer.from(
      JSON.stringify({
        ...parsed,
        ...(buckets.length > 0
          ? { additional_rate_limits: [...(Array.isArray(existing) ? existing : []), ...buckets] }
          : {}),
        ...(ambient ? { ambient_usage: ambient } : {}),
      }),
    );
  }
}
