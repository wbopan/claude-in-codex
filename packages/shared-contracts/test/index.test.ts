import { describe, expect, it } from "vitest";

import {
  claudeInCodexErrorSchema,
  harnessIdSchema,
  harnessInspectionSchema,
  harnessModelRefSchema,
  harnessThinkingOptionSchema,
  hostThreadIdSchema,
  jsonRpcEnvelopeSchema,
  jsonValueSchema,
  nativeSessionRefSchema,
  packageMetadata,
  WORKSPACE_CONTRACT_VERSION,
  workspaceContractVersionSchema,
} from "@claude-in-codex/shared-contracts";

describe("shared-contracts public package", () => {
  it("exports the unchanged workspace contract version", () => {
    expect(WORKSPACE_CONTRACT_VERSION).toBe(1);
    expect(workspaceContractVersionSchema.parse(1)).toBe(1);
    expect(packageMetadata.contractVersion).toBe(1);
  });

  it("exports representative runtime contracts from the package root", () => {
    expect(jsonValueSchema.parse({ public: true })).toEqual({ public: true });
    expect(harnessIdSchema.parse("example-harness")).toBe("example-harness");
    expect(harnessModelRefSchema.parse({ id: "example-model-v1.synthetic" })).toEqual({
      id: "example-model-v1.synthetic",
    });
    expect(
      harnessInspectionSchema.parse({
        status: "ready",
        catalog: {
          models: [
            {
              ref: { id: "example-model-v1.synthetic" },
              label: "Synthetic",
              supportedThinkingOptionIds: ["off", "high"],
            },
          ],
          defaultModel: { id: "example-model-v1.synthetic" },
          thinkingOptions: [
            { id: "off", label: "Off" },
            { id: "high", label: "High" },
          ],
          defaultThinkingOptionId: "high",
        },
        capabilities: {
          configuration: {
            selectModel: true,
            selectThinkingOption: true,
            selectPermissionMode: false,
          },
          history: { fork: true, forkAcrossCwd: true, rollbackLastTurn: false },
        },
      }),
    ).toMatchObject({ status: "ready" });
    expect(harnessThinkingOptionSchema.parse({ id: "high", label: "High" })).toEqual({
      id: "high",
      label: "High",
    });
    expect(hostThreadIdSchema.parse("thread")).toBe("thread");
    expect(jsonRpcEnvelopeSchema.parse({ id: 1, result: null })).toEqual({ id: 1, result: null });
    expect(
      nativeSessionRefSchema.parse({
        harnessId: "example-harness",
        nativeSessionId: "synthetic-session",
        formatVersion: 1,
      }),
    ).toEqual({
      harnessId: "example-harness",
      nativeSessionId: "synthetic-session",
      formatVersion: 1,
    });
    expect(
      claudeInCodexErrorSchema.parse({
        code: "SYNTHETIC",
        message: "Synthetic error.",
        retryable: false,
      }),
    ).toEqual({ code: "SYNTHETIC", message: "Synthetic error.", retryable: false });
  });
});
