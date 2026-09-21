import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import path from "node:path";

/**
 * Sanitized Subagent-lifecycle trace, written to the same acceptance file as
 * the Host's native picker trace. It records event names, enums and shapes so a
 * background Agent that stops can be attributed to a code path. It never
 * records prompts, replies, native identifiers or file paths.
 */
export function traceClaude(event: Record<string, unknown>): void {
  const environment = process.env;
  const enabled =
    environment.CODEXHOST_NATIVE_PICKER_TRACE === "1" ||
    environment.CODEXHOST_STARTUP_TRACE === "1";
  if (!enabled || !environment.CODEXHOST_DATA_DIR) return;
  try {
    appendFileSync(
      path.join(path.resolve(environment.CODEXHOST_DATA_DIR), "native-picker-trace.jsonl"),
      `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`,
      { mode: 0o600 },
    );
  } catch {
    // Tracing is diagnostic only.
  }
}

/** Correlates trace lines across Sessions without recording an identifier. */
export function traceRef(id: string | undefined | null): string | null {
  return id ? createHash("sha256").update(id).digest("hex").slice(0, 8) : null;
}

/**
 * Function names of the callers that reached this point. Only a call path
 * explains why a Session with live background tasks was closed, and names alone
 * carry no identifiers or absolute paths.
 */
export function traceCallers(depth = 8): string[] {
  return (new Error("trace").stack ?? "")
    .split("\n")
    .slice(2, 2 + depth)
    .flatMap((line) => {
      const name = /^\s*at\s+(?:async\s+)?([^\s(]+)/u.exec(line)?.[1];
      return name && !name.startsWith("/") && !name.startsWith("file:") ? [name] : [];
    });
}
