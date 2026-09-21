import { describe, expect, it } from "vitest";
import type { JsonRpcRequest } from "@codexhost/protocol-core";

import { classifyCreateRequestRoute, officialEnvironment, packageMetadata } from "../src/index.js";

import { transportModelIdForHarness } from "@codexhost/protocol-core";

const PI_NATIVE_TRANSPORT_MODEL_ID = transportModelIdForHarness("pi");

describe("host-runtime package", () => {
  it("declares the composition-root dependencies", () => {
    expect(packageMetadata.dependencies).toHaveLength(6);
    expect(
      packageMetadata.dependencies.some((name) => name.startsWith("@codexhost/adapter-")),
    ).toBe(false);
    expect(packageMetadata.dependencies).toContain("@codexhost/protocol-core");
    expect(packageMetadata.dependencies).toContain("@codexhost/harness-adapter");
    expect(packageMetadata.dependencies).toContain("@codexhost/harness-broker");
    expect(packageMetadata.dependencies).toContain("@codexhost/shared-contracts");
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
    expect(classifyCreateRequestRoute(request("codexhost/claude-code-native"))).toEqual({
      requestMethod: "thread/start",
      modelCarrier: "claude-code-transport",
      selectedHarness: "claude-code",
      selectionSource: "transport-model",
    });
    expect(classifyCreateRequestRoute(request("codexhost/grok-native"))).toEqual({
      requestMethod: "thread/start",
      modelCarrier: "official-model",
      selectedHarness: "codex",
      selectionSource: "official-model",
    });
    expect(
      classifyCreateRequestRoute({ id: 43, method: "thread/read", params: {} }),
    ).toBeNull();
  });

  it("keeps codexhost-internal variables out of the official Codex environment", () => {
    const official = officialEnvironment({
      PATH: "/usr/bin",
      CODEX_CLI_PATH: "/opt/shim",
      CODEXHOST_DATA_DIR: "/opt/data",
      CODEXHOST_STOCK_CODEX_PATH: "/opt/codex",
      CODEXHOST_NPM_NODE_PATH: "/opt/node",
      CODEXHOST_NPM_CLI_PATH: "/opt/npm-cli.js",
      CODEXHOST_NPM_LAUNCHER_PATH: "/opt/launcher.mjs",
      CODEXHOST_NPM_PACKAGE_ROOT: "/opt/package",
    });

    expect(official).toEqual({ PATH: "/usr/bin" });
  });
});
