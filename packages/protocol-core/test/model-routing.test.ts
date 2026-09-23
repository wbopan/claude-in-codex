import {
  encodeHarnessPluginRoute,
  harnessPluginRouteSchema,
  harnessModelRefSchema,
  harnessPermissionModeIdSchema,
  harnessThinkingOptionIdSchema,
  type JsonRpcRequest,
} from "@claude-in-codex/shared-contracts";
import { describe, expect, it } from "vitest";

import {
  CLAUDE_CODE_NATIVE_TRANSPORT_MODEL_ID,
  decodeClaudeTransportSelection,
  decodeCreateRoute,
  decodeExternalTransportModel,
  decodeExternalTransportSelection,
  encodeExternalTransportSelection,
  encodeClaudeTransportModel,
  transportModelIdForHarness,
} from "../src/index.js";

describe("external Harness transport model routing", () => {
  it.each([{}, { model: null }])("preserves the official default Model for %j", (params) => {
    expect(decodeCreateRoute({ id: 98, method: "thread/start", params })).toEqual({
      harnessId: "codex",
    });
  });
  it("routes arbitrary installed plugin identities with a shared configuration codec", () => {
    const configuration = {
      model: harnessModelRefSchema.parse({ id: "opaque-model" }),
      thinkingOptionId: harnessThinkingOptionIdSchema.parse("high"),
      permissionModeId: harnessPermissionModeIdSchema.parse("ask"),
    };
    const transportModelId = encodeExternalTransportSelection("sample-agent", configuration);
    expect(
      decodeCreateRoute({ id: 99, method: "thread/start", params: { model: transportModelId } }),
    ).toEqual({
      harnessId: "sample-agent",
      routeMode: "native",
      transportModelId,
      ...configuration,
    });
    expect(decodeExternalTransportSelection("sample-agent", transportModelId)).toEqual(
      configuration,
    );
    expect(decodeExternalTransportSelection("another-agent", transportModelId)).toBeNull();
    expect(transportModelIdForHarness("sample-agent")).toMatch(/^claude-in-codex\/plugin-v1@/u);
  });

  it.each(["claude-code", "pi", "sample-agent"])(
    "also accepts the shared codec for transitional identity %s",
    (harnessId) => {
      const route = harnessPluginRouteSchema.parse({ harnessId, model: { id: "opaque-model" } });
      expect(decodeExternalTransportSelection(harnessId, encodeHarnessPluginRoute(route))).toEqual({
        model: route.model,
      });
    },
  );

  it.each([["claude-code", CLAUDE_CODE_NATIVE_TRANSPORT_MODEL_ID]] as const)(
    "decodes the %s native transport token",
    (harnessId, transportModelId) => {
      const request: JsonRpcRequest = {
        id: 2,
        method: "thread/start",
        params: { model: transportModelId },
      };
      expect(decodeCreateRoute(request)).toEqual({
        harnessId,
        routeMode: "native",
        transportModelId,
      });
      expect(transportModelIdForHarness(harnessId)).toBe(transportModelId);
    },
  );

  it("keeps official models transparent and ignores other methods", () => {
    expect(
      decodeCreateRoute({ id: 3, method: "thread/start", params: { model: "official/model" } }),
    ).toEqual({ harnessId: "codex", transportModelId: "official/model" });
    expect(decodeCreateRoute({ id: 4, method: "model/list", params: {} })).toBeNull();
  });

  it("round-trips a request-scoped Claude Code Model Ref", () => {
    const model = harnessModelRefSchema.parse({ id: "claude-model-v1.c29ubmV0" });
    const transportModelId = encodeClaudeTransportModel(model);

    expect(transportModelId).toBe(`${CLAUDE_CODE_NATIVE_TRANSPORT_MODEL_ID}@${model.id}`);
    expect(decodeClaudeTransportSelection(transportModelId)).toEqual({ model });
    expect(
      decodeCreateRoute({
        id: 7,
        method: "thread/start",
        params: { model: transportModelId },
      }),
    ).toEqual({
      harnessId: "claude-code",
      routeMode: "native",
      transportModelId,
      model,
    });
    expect(encodeClaudeTransportModel()).toBe(CLAUDE_CODE_NATIVE_TRANSPORT_MODEL_ID);
  });

  it("round-trips request-scoped Claude Code Model and Permission Mode", () => {
    const model = harnessModelRefSchema.parse({ id: "claude-model-v1.ZGVmYXVsdA" });
    const permissionModeId = harnessPermissionModeIdSchema.parse("acceptEdits");
    const transportModelId = encodeClaudeTransportModel(model, permissionModeId);

    expect(transportModelId).toBe(
      `${CLAUDE_CODE_NATIVE_TRANSPORT_MODEL_ID}@${model.id}@${permissionModeId}`,
    );
    expect(decodeClaudeTransportSelection(transportModelId)).toEqual({
      model,
      permissionModeId,
    });
    expect(
      decodeCreateRoute({
        id: 8,
        method: "thread/start",
        params: { model: transportModelId },
      }),
    ).toMatchObject({ harnessId: "claude-code", model, permissionModeId });
    expect(() => encodeClaudeTransportModel(undefined, permissionModeId)).toThrow(
      "requires a Model Ref",
    );
  });

  it("round-trips request-scoped Claude Code Thinking with optional Permission Mode", () => {
    const model = harnessModelRefSchema.parse({ id: "claude-model-v1.ZGVmYXVsdA" });
    const permissionModeId = harnessPermissionModeIdSchema.parse("acceptEdits");
    const thinkingOptionId = harnessThinkingOptionIdSchema.parse("xhigh");
    const configured = encodeClaudeTransportModel(model, permissionModeId, thinkingOptionId);
    const withoutPermission = encodeClaudeTransportModel(model, undefined, thinkingOptionId);

    expect(configured).toBe(
      `${CLAUDE_CODE_NATIVE_TRANSPORT_MODEL_ID}@${model.id}@${permissionModeId}@${thinkingOptionId}`,
    );
    expect(decodeClaudeTransportSelection(configured)).toEqual({
      model,
      permissionModeId,
      thinkingOptionId,
    });
    expect(withoutPermission).toBe(
      `${CLAUDE_CODE_NATIVE_TRANSPORT_MODEL_ID}@${model.id}@@${thinkingOptionId}`,
    );
    expect(decodeClaudeTransportSelection(withoutPermission)).toEqual({ model, thinkingOptionId });
    expect(
      decodeCreateRoute({ id: 9, method: "thread/start", params: { model: configured } }),
    ).toMatchObject({ harnessId: "claude-code", model, permissionModeId, thinkingOptionId });
  });

  it("rejects malformed selected Claude carriers instead of forwarding them as official Models", () => {
    for (const model of [
      `${CLAUDE_CODE_NATIVE_TRANSPORT_MODEL_ID}@`,
      `${CLAUDE_CODE_NATIVE_TRANSPORT_MODEL_ID}@provider/model`,
      `${CLAUDE_CODE_NATIVE_TRANSPORT_MODEL_ID}@${"x".repeat(513)}`,
      `${CLAUDE_CODE_NATIVE_TRANSPORT_MODEL_ID}@claude-model-v1.valid@provider/mode`,
      `${CLAUDE_CODE_NATIVE_TRANSPORT_MODEL_ID}@claude-model-v1.valid@default@high@extra`,
      `${CLAUDE_CODE_NATIVE_TRANSPORT_MODEL_ID}@claude-model-v1.valid@default@`,
    ]) {
      expect(() => decodeCreateRoute({ id: 8, method: "thread/start", params: { model } })).toThrow(
        /invalid Model Ref|invalid Permission Mode|invalid component count|empty Thinking option/u,
      );
    }
    expect(() =>
      decodeExternalTransportModel(
        "claude-code",
        `${CLAUDE_CODE_NATIVE_TRANSPORT_MODEL_ID}@provider/model`,
      ),
    ).toThrow("invalid Model Ref");
  });
});
