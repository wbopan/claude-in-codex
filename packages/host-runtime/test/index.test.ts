import { describe, expect, it } from "vitest";
import type { JsonRpcRequest } from "@claude-in-codex/protocol-core";

import { classifyCreateRequestRoute, officialEnvironment, packageMetadata } from "../src/index.js";

import { transportModelIdForHarness } from "@claude-in-codex/protocol-core";

const PI_NATIVE_TRANSPORT_MODEL_ID = transportModelIdForHarness("pi");

describe("host-runtime package", () => {
  it("declares the composition-root dependencies", () => {
    expect(packageMetadata.dependencies).toHaveLength(6);
    expect(
      packageMetadata.dependencies.some((name) => name.startsWith("@claude-in-codex/adapter-")),
    ).toBe(false);
    expect(packageMetadata.dependencies).toContain("@claude-in-codex/protocol-core");
    expect(packageMetadata.dependencies).toContain("@claude-in-codex/harness-adapter");
    expect(packageMetadata.dependencies).toContain("@claude-in-codex/harness-broker");
    expect(packageMetadata.dependencies).toContain("@claude-in-codex/shared-contracts");
  });

  it("classifies create routes without exposing Model values or request IDs", () => {
    const request = (model: string): JsonRpcRequest => ({
      id: 42,
      method: "thread/start",
      params: { model },
    });

    expect(classifyCreateRequestRoute(request("official/model"))).toEqual({
      requestMethod: "thread/start",
      modelCarrier: "official-model",
      selectedHarness: "codex",
      selectionSource: "official-model",
    });
    expect(classifyCreateRequestRoute(request(PI_NATIVE_TRANSPORT_MODEL_ID))).toEqual({
      requestMethod: "thread/start",
      modelCarrier: "pi-transport",
      selectedHarness: "pi",
      selectionSource: "transport-model",
    });
    expect(classifyCreateRequestRoute(request("claude-in-codex/claude-code-native"))).toEqual({
      requestMethod: "thread/start",
      modelCarrier: "claude-code-transport",
      selectedHarness: "claude-code",
      selectionSource: "transport-model",
    });
    expect(classifyCreateRequestRoute(request("claude-in-codex/grok-native"))).toEqual({
      requestMethod: "thread/start",
      modelCarrier: "official-model",
      selectedHarness: "codex",
      selectionSource: "official-model",
    });
    expect(classifyCreateRequestRoute({ id: 43, method: "thread/read", params: {} })).toBeNull();
  });

  it("keeps claude-in-codex-internal variables out of the official Codex environment", () => {
    const official = officialEnvironment({
      PATH: "/usr/bin",
      CODEX_CLI_PATH: "/opt/shim",
      CLAUDE_IN_CODEX_DATA_DIR: "/opt/data",
      CODEXHOST_CONTROL_NONCE: "legacy-secret",
      CLAUDE_IN_CODEX_STOCK_CODEX_PATH: "/opt/codex",
      CLAUDE_IN_CODEX_NPM_NODE_PATH: "/opt/node",
      CLAUDE_IN_CODEX_NPM_CLI_PATH: "/opt/npm-cli.js",
      CLAUDE_IN_CODEX_NPM_LAUNCHER_PATH: "/opt/launcher.mjs",
      CLAUDE_IN_CODEX_NPM_PACKAGE_ROOT: "/opt/package",
      CLAUDE_IN_CODEX_DESKTOP_PROXY: "1",
      CLAUDE_IN_CODEX_DESKTOP_PROXY_SPKI: "pin",
      CLAUDE_IN_CODEX_DESKTOP_PROXY_TRACE: "1",
    });

    expect(official).toEqual({ PATH: "/usr/bin" });
  });
});
