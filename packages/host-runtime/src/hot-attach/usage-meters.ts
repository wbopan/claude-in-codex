import type { AccountCreditsSnapshot } from "@codexhost/shared-contracts";

/**
 * One quota window as the MenuBar shows it: how much is left and when it resets. `window` is a
 * machine key the MenuBar localizes ("five_hour", "weekly", "monthly", "<n>h", "<n>d").
 * Server-driven rows that carry only text keep `label`/`text` and no percentage.
 */
export interface UsageMeter {
  source: string;
  window: string | null;
  scope?: string;
  label?: string;
  text?: string;
  remainingPercent: number | null;
  resetsAt: string | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const finite = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const remaining = (used: number) => Math.min(100, Math.max(0, Math.round(100 - used)));

function windowKey(seconds: number): string {
  const hours = seconds / 3600;
  if (Math.abs(seconds - 5 * 3600) <= 60) return "five_hour";
  if (Math.abs(seconds - 7 * 86400) <= 3600) return "weekly";
  if (Math.abs(hours - 30 * 24) <= 48) return "monthly";
  return hours < 48 ? `${Math.round(hours)}h` : `${Math.round(hours / 24)}d`;
}

/**
 * The Codex windows from the Desktop's own `/backend-api/wham/usage` body. The structured
 * `rate_limit` windows win; without them the server-driven `ambient_usage` rows are kept as text,
 * reading a percentage only when the row states what is left.
 */
export function codexUsageMeters(body: unknown, now = Date.now()): UsageMeter[] {
  if (!isRecord(body)) return [];
  const meters: UsageMeter[] = [];
  const rateLimit = isRecord(body.rate_limit) ? body.rate_limit : null;
  for (const key of ["primary_window", "secondary_window"] as const) {
    const window = rateLimit && isRecord(rateLimit[key]) ? rateLimit[key] : null;
    const used = finite(window?.used_percent);
    const seconds = finite(window?.limit_window_seconds);
    if (!window || used === null || seconds === null || seconds <= 0) continue;
    const resetAt = finite(window.reset_at);
    const resetAfter = finite(window.reset_after_seconds);
    const resetsAtMs =
      resetAt !== null ? resetAt * 1000 : resetAfter !== null ? now + resetAfter * 1000 : null;
    meters.push({
      source: "codex",
      window: windowKey(seconds),
      remainingPercent: remaining(used),
      resetsAt: resetsAtMs === null ? null : new Date(resetsAtMs).toISOString(),
    });
  }
  if (meters.length > 0) return meters.sort((a, b) => order(a.window) - order(b.window));
  const ambient = isRecord(body.ambient_usage) ? body.ambient_usage : null;
  const menu =
    ambient && isRecord(ambient.default) && isRecord(ambient.default.menu)
      ? ambient.default.menu
      : null;
  for (const row of Array.isArray(menu?.rows) ? menu.rows : []) {
    if (!isRecord(row) || typeof row.label !== "string") continue;
    const text = isRecord(row.value) && typeof row.value.text === "string" ? row.value.text : "";
    const percent = text.match(/(\d{1,3})\s*%/u);
    const left = percent && /left|remaining|剩余/iu.test(text) ? Number(percent[1]) : null;
    meters.push({
      source: "codex",
      window: null,
      label: row.label.slice(0, 80),
      ...(text ? { text: text.slice(0, 40) } : {}),
      remainingPercent: left !== null && left <= 100 ? left : null,
      resetsAt: null,
    });
    if (meters.length >= 6) break;
  }
  return meters;
}

function order(window: string | null): number {
  return window === "five_hour" ? 0 : window === "weekly" ? 1 : window === "monthly" ? 2 : 3;
}

const PERIOD_WINDOW: Record<AccountCreditsSnapshot["periodType"], string | null> = {
  five_hour: "five_hour",
  seven_day: "weekly",
  weekly: "weekly",
  monthly: "monthly",
  unknown: null,
};

/** A Claude product label ("5-hour window", "Fable · 7-day") as a window plus its scope. */
function productWindow(product: string): { window: string | null; scope?: string } {
  if (product === "5-hour window") return { window: "five_hour" };
  if (product === "7-day window") return { window: "weekly" };
  const [, scope, span] = product.match(/^(.+?)\s*·\s*(5-hour|7-day)$/u) ?? [];
  if (scope && span)
    return { window: span === "5-hour" ? "five_hour" : "weekly", scope: scope.trim() };
  return { window: null, scope: product };
}

/** A Harness account snapshot's windows: the primary first, then each product window. */
export function accountUsageMeters(source: string, credits: AccountCreditsSnapshot): UsageMeter[] {
  const primary = credits.label
    ? { ...productWindow(credits.label), window: PERIOD_WINDOW[credits.periodType] }
    : { window: PERIOD_WINDOW[credits.periodType] };
  return [
    {
      source,
      ...primary,
      remainingPercent: remaining(credits.usedPercent),
      resetsAt: credits.resetsAt ?? null,
    },
    ...(credits.productUsage ?? []).map((product) => ({
      source,
      ...productWindow(product.product),
      remainingPercent: remaining(product.usagePercent),
      resetsAt: product.resetsAt ?? null,
    })),
  ];
}
