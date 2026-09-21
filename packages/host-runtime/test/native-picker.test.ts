import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { harnessModelCatalogSchema } from "@codexhost/shared-contracts";
import { describe, expect, it } from "vitest";

import {
  NativeSelectionStore,
  effortForThinkingOption,
  overlayNativeSelection,
  planConfigEdits,
  projectNativeModels,
  requestedNativeSelection,
  thinkingOptionForEffort,
} from "../src/native-picker.js";

const catalog = harnessModelCatalogSchema.parse({
  models: [
    { ref: { id: "opus" }, label: "Opus", resolvedModelLabel: "claude-opus" },
    { ref: { id: "haiku" }, label: "Claude Haiku", supportedThinkingOptionIds: ["off", "auto"] },
  ],
  thinkingOptions: [
    { id: "off", label: "Off" },
    { id: "auto", label: "Auto" },
    { id: "low", label: "Low" },
    { id: "high", label: "High" },
    { id: "max", label: "Max" },
  ],
  defaultThinkingOptionId: "auto",
});
const route = "codexhost/claude-code-native@opus";
const edit = (keyPath: string, value: unknown) => ({ keyPath, value, mergeStrategy: "replace" });

describe("native Model picker projection", () => {
  it("projects Harness Models with only efforts the official picker can show", () => {
    const [opus, haiku] = projectNativeModels({
      harnessName: "Claude",
      catalog,
      routeId: (model) => `codexhost/claude-code-native@${model.ref.id}`,
    });
    expect(opus).toMatchObject({
      id: route,
      model: route,
      displayName: "Claude · Opus",
      description: "claude-opus",
      hidden: false,
      isDefault: false,
      defaultReasoningEffort: "low",
    });
    expect(opus?.supportedReasoningEfforts).toEqual([
      { reasoningEffort: "low", description: "Low" },
      { reasoningEffort: "high", description: "High" },
      { reasoningEffort: "max", description: "Max" },
    ]);
    // A Model without a displayable effort still advertises one so the picker stays valid.
    expect(haiku).toMatchObject({ displayName: "Claude Haiku", defaultReasoningEffort: "medium" });
  });

  it("maps official efforts to Thinking options", () => {
    expect(thinkingOptionForEffort("high", catalog)).toBe("high");
    expect(thinkingOptionForEffort("none", catalog)).toBe("off");
    expect(thinkingOptionForEffort("xhigh", catalog)).toBeUndefined();
    expect(thinkingOptionForEffort(null, catalog)).toBeUndefined();
    // The reverse mapping keeps a reopened Thread on a picker-visible effort.
    expect(effortForThinkingOption("high")).toBe("high");
    expect(effortForThinkingOption("off")).toBe("none");
    expect(effortForThinkingOption("auto")).toBe("medium");
    expect(effortForThinkingOption(undefined)).toBe("medium");
  });

  it("gives collaborationMode precedence over top-level Model and effort", () => {
    expect(
      requestedNativeSelection({
        model: "gpt",
        effort: "low",
        collaborationMode: {
          mode: "default",
          settings: { model: route, reasoning_effort: "high" },
        },
      }),
    ).toEqual({ model: route, effort: "high" });
    expect(
      requestedNativeSelection({ model: null, config: { model_reasoning_effort: "max" } }),
    ).toEqual({ effort: "max" });
  });

  it("keeps route ids out of official config edits", () => {
    const other = edit("notify", true);
    expect(
      planConfigEdits([edit("model", route), edit("model_reasoning_effort", "high"), other], null),
    ).toEqual({ official: [other], selection: { model: route, effort: "high" } });
    expect(planConfigEdits([edit("profiles.work.model", route)], null)).toEqual({
      official: [],
      selection: { model: route },
    });
  });

  it("stores effort-only edits while a Harness Model is selected and releases official Models", () => {
    const current = { model: route, effort: "low" };
    expect(planConfigEdits([edit("model_reasoning_effort", "max")], current)).toEqual({
      official: [],
      selection: { model: route, effort: "max" },
    });
    const official = [edit("model", "gpt-5.5"), edit("model_reasoning_effort", "medium")];
    expect(planConfigEdits(official, current)).toEqual({ official, selection: null });
    expect(
      planConfigEdits([edit("model_reasoning_effort", "max")], null).selection,
    ).toBeUndefined();
    expect(planConfigEdits([edit("notify", true)], current).selection).toBeUndefined();
  });

  it("overlays and persists the selection outside the official config", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "native-picker-"));
    try {
      const store = new NativeSelectionStore(directory);
      expect(await store.get()).toBeNull();
      await store.set({ model: route, effort: "high" });
      expect(
        JSON.parse(readFileSync(path.join(directory, "native-picker-selection.json"), "utf8")),
      ).toEqual({ model: route, effort: "high" });
      const restored = await new NativeSelectionStore(directory).get();
      expect(
        overlayNativeSelection({ config: { model: "gpt-5.5", notify: true } }, restored),
      ).toEqual({
        config: { model: route, model_reasoning_effort: "high", notify: true },
      });
      await store.set(null);
      expect(await new NativeSelectionStore(directory).get()).toBeNull();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
