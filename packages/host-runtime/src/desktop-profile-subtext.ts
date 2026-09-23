import type { IncomingHttpHeaders } from "node:http";

/**
 * The only Desktop response rewrite. The sidebar footer reads `ambient_usage.default.profile_subtext`
 * from `GET /backend-api/wham/usage` and shows it under the account name. While attached it reads
 * `DESKTOP_PROFILE_SUBTEXT`, replacing a server-sent line, so the Desktop window itself shows that
 * Claude is connected. Nothing else in the response is touched: quota stays native, and Harness
 * usage is the standalone App's job.
 *
 * The renderer requires `ambient_usage.default.menu.rows` whenever the section is present. When the
 * backend sends no section, one is built with the core Codex windows as rows, mirroring what the
 * native menu item shows, so nothing the profile menu used to show is lost.
 */
export const DESKTOP_USAGE_PATH = "/backend-api/wham/usage";
/** Shown under the account name in the sidebar footer while attached. */
export const DESKTOP_PROFILE_SUBTEXT = "Claude Connected";

interface AmbientUsageRow {
  label: string;
  value: { text: string; tone: "neutral" | "warning" };
  hover?: { text: string };
}

const WARNING_USED_PERCENT = 90;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isJson(headers: IncomingHttpHeaders): boolean {
  const type = headers["content-type"];
  return typeof type === "string" && /\bjson\b/iu.test(type);
}

function windowLabel(seconds: number): string {
  if (Math.abs(seconds - 5 * 60 * 60) <= 60) return "5-hour";
  if (Math.abs(seconds - 7 * 24 * 60 * 60) <= 60) return "7-day";
  if (Math.abs(seconds - 30 * 24 * 60 * 60) <= 3600) return "monthly";
  const hours = Math.round(seconds / 3600);
  return hours >= 48 ? `${Math.round(hours / 24)}-day` : `${hours}-hour`;
}

export function formatResetIn(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  return days > 0
    ? `Resets in ${days}d ${hours}h`
    : hours > 0
      ? `Resets in ${hours}h ${minutes}m`
      : `Resets in ${Math.max(minutes, 1)}m`;
}

/** The core Codex windows as rows, mirroring what the simplified native menu item shows. */
export function codexUsageRows(
  response: Record<string, unknown>,
  now = Date.now(),
): AmbientUsageRow[] {
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
    const clamped = Math.min(100, Math.max(0, Math.round(used)));
    rows.push({
      label: `Codex ${windowLabel(seconds)}`,
      value: {
        text: `${100 - clamped}% left`,
        tone: clamped >= WARNING_USED_PERCENT ? "warning" : "neutral",
      },
      ...(resetAfter !== null ? { hover: { text: formatResetIn(resetAfter) } } : {}),
    });
  }
  return rows;
}

/**
 * The response with the subtext set. `null` when its ambient usage section has a shape this does
 * not understand; the original bytes are sent then.
 */
export function withProfileSubtext(
  response: Record<string, unknown>,
  now = Date.now(),
): Record<string, unknown> | null {
  const existing = isRecord(response.ambient_usage) ? response.ambient_usage : null;
  const existingDefault = existing && isRecord(existing.default) ? existing.default : null;
  const existingMenu =
    existingDefault && isRecord(existingDefault.menu) ? existingDefault.menu : null;
  if (existing && (!existingDefault || !existingMenu || !Array.isArray(existingMenu.rows))) {
    return null;
  }
  return {
    ...response,
    ambient_usage: {
      ...(existing ?? {}),
      default: {
        ...(existingDefault ?? {}),
        profile_subtext: DESKTOP_PROFILE_SUBTEXT,
        menu: existingMenu ?? { actions: [], rows: codexUsageRows(response, now) },
      },
    },
  };
}

export class DesktopProfileSubtextPublisher {
  #attached = false;
  readonly #now: () => number;

  constructor(options: { now?: () => number } = {}) {
    this.#now = options.now ?? Date.now;
  }

  attach(): void {
    this.#attached = true;
  }

  detach(): void {
    this.#attached = false;
  }

  /** The rewritten body, or `null` to send the original bytes (detached, not 200 JSON, odd shape). */
  rewrite(response: { status: number; headers: IncomingHttpHeaders; body: Buffer }): Buffer | null {
    if (!this.#attached || response.status !== 200 || !isJson(response.headers)) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(response.body.toString("utf8"));
    } catch {
      return null;
    }
    if (!isRecord(parsed)) return null;
    const rewritten = withProfileSubtext(parsed, this.#now());
    return rewritten ? Buffer.from(JSON.stringify(rewritten)) : null;
  }
}
