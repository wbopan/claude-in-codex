import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  DESKTOP_PROFILE_SUBTEXT,
  DesktopProfileSubtextPublisher,
  codexUsageRows,
  formatResetIn,
  withProfileSubtext,
} from "../src/desktop-profile-subtext.js";

const fixture = readFileSync(path.join(import.meta.dirname, "fixtures/wham-usage.json"), "utf8");
const NOW = Date.parse("2026-09-22T05:00:00Z");
const headers = { "content-type": "application/json" };

function rewrittenJson<T>(body: Buffer | null): T {
  if (!body) throw new Error("The usage response was not rewritten");
  return JSON.parse(body.toString()) as T;
}

function attached(): DesktopProfileSubtextPublisher {
  const publisher = new DesktopProfileSubtextPublisher({ now: () => NOW });
  publisher.attach();
  return publisher;
}

describe("withProfileSubtext", () => {
  it("adds the subtext and mirrors the core Codex windows when the backend sends no section", () => {
    const original = JSON.parse(fixture) as Record<string, unknown>;
    const response = withProfileSubtext(original, NOW);
    expect(response).not.toBeNull();
    const { ambient_usage, ...rest } = response as Record<string, unknown>;
    expect(rest).toEqual(original);
    expect(ambient_usage).toEqual({
      default: {
        profile_subtext: DESKTOP_PROFILE_SUBTEXT,
        menu: {
          actions: [],
          rows: [
            {
              label: "Codex 7-day",
              value: { text: "73% left", tone: "neutral" },
              hover: { text: "Resets in 4d 7h" },
            },
          ],
        },
      },
    });
    expect(codexUsageRows({}, NOW)).toEqual([]);
    expect(formatResetIn(90)).toBe("Resets in 1m");
  });

  it("replaces a server-sent subtext and keeps the rest of the section", () => {
    const response = withProfileSubtext({
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
    expect(response?.ambient_usage).toEqual({
      default: {
        profile_subtext: DESKTOP_PROFILE_SUBTEXT,
        menu: {
          rows: [{ label: "Native", value: { text: "1% left", tone: "neutral" } }],
          actions: [{ action: "invite" }],
        },
      },
      extra: "kept",
    });
  });

  it("leaves an unexpected section shape alone", () => {
    expect(withProfileSubtext({ ambient_usage: { unexpected: true } })).toBeNull();
    expect(withProfileSubtext({ ambient_usage: { default: { menu: { rows: 1 } } } })).toBeNull();
  });
});

describe("DesktopProfileSubtextPublisher", () => {
  it("rewrites only while attached", () => {
    const body = Buffer.from(fixture);
    const publisher = new DesktopProfileSubtextPublisher({ now: () => NOW });
    expect(publisher.rewrite({ status: 200, headers, body })).toBeNull();
    publisher.attach();
    const response = rewrittenJson<{ ambient_usage: { default: { profile_subtext: string } } }>(
      publisher.rewrite({ status: 200, headers, body }),
    );
    expect(response.ambient_usage.default.profile_subtext).toBe("Claude Connected");
    publisher.detach();
    expect(publisher.rewrite({ status: 200, headers, body })).toBeNull();
  });

  it("sends the original bytes for anything it does not understand", () => {
    const publisher = attached();
    const body = Buffer.from(fixture);
    expect(publisher.rewrite({ status: 401, headers, body })).toBeNull();
    expect(
      publisher.rewrite({ status: 200, headers: { "content-type": "text/html" }, body }),
    ).toBeNull();
    expect(publisher.rewrite({ status: 200, headers, body: Buffer.from("{not json") })).toBeNull();
    expect(publisher.rewrite({ status: 200, headers, body: Buffer.from("[1,2]") })).toBeNull();
    expect(
      publisher.rewrite({ status: 200, headers, body: Buffer.from('{"ambient_usage":{"x":1}}') }),
    ).toBeNull();
  });
});
