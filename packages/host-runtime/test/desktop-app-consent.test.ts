import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { appConsentEnabled, consentedApp } from "../src/desktop-app-consent.js";

const request = (overrides: Record<string, unknown> = {}, meta: Record<string, unknown> = {}) => ({
  serverName: "cua_repl",
  threadId: "context",
  mode: "form",
  requestedSchema: { type: "object", properties: {} },
  _meta: {
    connector_id: "computer-use",
    codex_approval_kind: "mcp_tool_call",
    persist: ["session", "always"],
    tool_name: "open_app",
    tool_params: { app: "com.apple.TextEdit" },
    ...meta,
  },
  ...overrides,
});

describe("standing Computer Use app consent", () => {
  it("accepts only an empty app-access confirmation that allows a saved approval", () => {
    expect(consentedApp(request(), "context")).toBe("com.apple.TextEdit");
    expect(consentedApp(request(), "another-context")).toBeNull();
    expect(consentedApp(request({ mode: "openai/userVerification" }), "context")).toBeNull();
    expect(consentedApp(request({ serverName: "codex_app" }), "context")).toBeNull();
    expect(
      consentedApp(
        request({ requestedSchema: { type: "object", properties: { password: {} } } }),
        "context",
      ),
    ).toBeNull();
    expect(consentedApp(request({}, { persist: ["session"] }), "context")).toBeNull();
    expect(
      consentedApp(request({}, { tool_params: { app: "x", url: "y" } }), "context"),
    ).toBeNull();
    expect(consentedApp(request({}, { tool_params: { app: "../evil" } }), "context")).toBeNull();
  });

  it("is off unless the Claude profile opts in", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "app-consent-"));
    try {
      const environment = { CLAUDE_CONFIG_DIR: directory };
      expect(appConsentEnabled(environment)).toBe(false);
      writeFileSync(
        path.join(directory, "codex-desktop.json"),
        '{"version":1,"appApprovals":"ask"}',
      );
      expect(appConsentEnabled(environment)).toBe(false);
      writeFileSync(
        path.join(directory, "codex-desktop.json"),
        '{"version":1,"appApprovals":"allow"}',
      );
      expect(appConsentEnabled(environment)).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
