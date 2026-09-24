import { describe, expect, it } from "vitest";

import {
  HARNESS_MODEL_REF_MAX_LENGTH,
  HARNESS_THINKING_OPTION_ID_MAX_LENGTH,
  harnessInspectionSchema,
  harnessModelCatalogSchema,
  harnessModelRefSchema,
  harnessModelSelectionStateSchema,
  harnessThinkingOptionIdSchema,
} from "@claude-in-codex/shared-contracts";

const firstRef = { id: "example-model-v1.cHJvdmlkZXI6bW9kZWw" };
const secondRef = { id: "example-model-v1.b3RoZXI6bW9kZWw" };

function readyInspection() {
  return {
    status: "ready",
    catalog: {
      models: [
        {
          ref: firstRef,
          label: "provider / model",
          resolvedModelLabel: "runtime/model-v1",
          supportedThinkingOptionIds: ["off", "high"],
        },
        { ref: secondRef, label: "other / model" },
      ],
      defaultModel: firstRef,
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
        permissionModeScope: "live",
      },
      history: { fork: true, forkAcrossCwd: true, rollbackLastTurn: true },
    },
  };
}

describe("Harness Model runtime contracts", () => {
  it("accepts a strict ready inspection", () => {
    expect(harnessInspectionSchema.parse(readyInspection())).toEqual(readyInspection());
    expect(
      harnessModelSelectionStateSchema.parse({
        effectiveModel: firstRef,
        resolvedModelLabel: "runtime/model-v1",
        effectiveThinkingOptionId: "high",
        availableThinkingOptions: [
          { id: "off", label: "Off" },
          { id: "high", label: "High" },
        ],
      }),
    ).toMatchObject({
      effectiveModel: firstRef,
      resolvedModelLabel: "runtime/model-v1",
      effectiveThinkingOptionId: "high",
    });
    expect(JSON.parse(JSON.stringify(harnessInspectionSchema.parse(readyInspection())))).toEqual(
      readyInspection(),
    );
  });

  it("rejects native configuration and unknown fields", () => {
    expect(
      harnessInspectionSchema.safeParse({
        ...readyInspection(),
        capabilities: {
          configuration: {
            selectModel: true,
            selectThinkingOption: true,
            selectPermissionMode: false,
          },
          history: { fork: true },
        },
      }).success,
    ).toBe(false);
    expect(
      harnessInspectionSchema.safeParse({
        ...readyInspection(),
        capabilities: {
          configuration: {
            selectModel: true,
            selectThinkingOption: true,
            selectPermissionMode: false,
          },
          history: { fork: false, forkAcrossCwd: true, rollbackLastTurn: false },
        },
      }).success,
    ).toBe(false);
    expect(
      harnessInspectionSchema.safeParse({
        ...readyInspection(),
        catalog: {
          ...readyInspection().catalog,
          models: [
            {
              ref: firstRef,
              label: "provider / model",
              provider: { baseUrl: "https://private.invalid", apiKey: "secret" },
            },
          ],
        },
      }).success,
    ).toBe(false);
    expect(
      harnessModelSelectionStateSchema.safeParse({
        effectiveModel: firstRef,
        nativeState: { modelId: "private" },
      }).success,
    ).toBe(false);
    for (const resolvedModelLabel of ["", "   ", "x".repeat(257)]) {
      expect(
        harnessModelSelectionStateSchema.safeParse({
          effectiveModel: firstRef,
          resolvedModelLabel,
        }).success,
      ).toBe(false);
    }
  });

  it("requires bounded transport-safe opaque Model refs", () => {
    for (const id of [
      "",
      "   ",
      "provider/model",
      "provider:model",
      "provider model",
      "x".repeat(HARNESS_MODEL_REF_MAX_LENGTH + 1),
    ]) {
      expect(harnessModelRefSchema.safeParse({ id }).success).toBe(false);
    }
    expect(harnessModelRefSchema.parse(firstRef)).toEqual(firstRef);
    for (const id of [
      "",
      "thinking option",
      "thinking/option",
      "x".repeat(HARNESS_THINKING_OPTION_ID_MAX_LENGTH + 1),
    ]) {
      expect(harnessThinkingOptionIdSchema.safeParse(id).success).toBe(false);
    }
    expect(harnessThinkingOptionIdSchema.parse("xhigh")).toBe("xhigh");
  });

  it("rejects duplicate refs and a default outside the catalog", () => {
    expect(
      harnessModelCatalogSchema.safeParse({
        models: [
          { ref: firstRef, label: "first" },
          { ref: firstRef, label: "duplicate" },
        ],
        defaultModel: firstRef,
        thinkingOptions: [],
      }).success,
    ).toBe(false);
    expect(
      harnessModelCatalogSchema.safeParse({
        models: [{ ref: firstRef, label: "first" }],
        defaultModel: secondRef,
        thinkingOptions: [],
      }).success,
    ).toBe(false);
    expect(
      harnessModelCatalogSchema.safeParse({
        models: [
          {
            ref: firstRef,
            label: "first",
            supportedThinkingOptionIds: ["missing"],
          },
        ],
        defaultModel: firstRef,
        thinkingOptions: [{ id: "off", label: "Off" }],
        defaultThinkingOptionId: "missing",
      }).success,
    ).toBe(false);
    expect(
      harnessModelCatalogSchema.safeParse({
        models: [
          {
            ref: firstRef,
            label: "first",
            supportedThinkingOptionIds: ["off", "off"],
          },
        ],
        thinkingOptions: [{ id: "off", label: "Off" }],
      }).success,
    ).toBe(false);
    expect(
      harnessModelSelectionStateSchema.safeParse({
        effectiveThinkingOptionId: "high",
        availableThinkingOptions: [{ id: "off", label: "Off" }],
      }).success,
    ).toBe(false);
  });

  it("validates normalized inspection failures without arbitrary diagnostics", () => {
    expect(
      harnessInspectionSchema.parse({
        status: "notInstalled",
        error: {
          code: "notInstalled",
          message: "Example Harness is not installed",
          retryable: false,
        },
      }),
    ).toMatchObject({ status: "notInstalled", error: { code: "notInstalled" } });
    expect(
      harnessInspectionSchema.safeParse({
        status: "error",
        error: {
          code: "nativeFailure",
          message: "Private failure",
          retryable: false,
          nativePayload: { apiKey: "secret" },
        },
      }).success,
    ).toBe(false);
  });
});
