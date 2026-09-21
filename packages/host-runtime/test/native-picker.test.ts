import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { harnessModelCatalogSchema } from "@codexhost/shared-contracts";
import { describe, expect, it } from "vitest";

import {
  NativeSelectionStore,
  effortForThinkingOption,
  injectedItemsText,
  toolOutputText,
  modelFamilyVersion,
  nativePermissionLevel,
  nativePermissionResponse,
  nativePlanMode,
  permissionModeForLevel,
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
      displayName: "Opus",
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

  it("reads family and version from resolved Model ids without a Model table", () => {
    expect(modelFamilyVersion("claude-fable-5-1", "Fable")).toEqual({
      family: "Fable",
      version: "5.1",
    });
    expect(modelFamilyVersion("claude-haiku-4-5-20251001", "Haiku")?.version).toBe("4.5");
    expect(modelFamilyVersion("claude-opus-5[1m]", "Opus")?.version).toBe("5");
    expect(modelFamilyVersion("claude-3-5-sonnet-20241022", "Sonnet")?.version).toBe("3.5");
    expect(modelFamilyVersion("gpt-5.5", "gpt")?.version).toBe("5.5");
    // A future release needs no code change.
    expect(modelFamilyVersion("claude-opus-7-2-20290101", "Opus")?.version).toBe("7.2");
    // An alias is resolved to the family its id names.
    expect(modelFamilyVersion("claude-opus-5[1m]", "Default")).toBeUndefined();
    expect(modelFamilyVersion("claude-opus-5[1m]")).toEqual({ family: "Opus", version: "5" });
    expect(modelFamilyVersion("claude-3-5-sonnet-20241022")).toEqual({
      family: "Sonnet",
      version: "3.5",
    });
    expect(modelFamilyVersion("claude-sonnet-20250101", "Sonnet")).toBeUndefined();
    expect(modelFamilyVersion("custom-model")).toBeUndefined();
  });

  it("adds the resolved version to picker names", () => {
    const entries = projectNativeModels({
      harnessName: "Claude Code",
      catalog: harnessModelCatalogSchema.parse({
        models: [
          {
            ref: { id: "d" },
            label: "Default (recommended)",
            resolvedModelLabel: "claude-opus-5[1m]",
          },
          { ref: { id: "f" }, label: "Fable", resolvedModelLabel: "claude-fable-5-1" },
          { ref: { id: "h" }, label: "Haiku", resolvedModelLabel: "claude-haiku-4-5-20251001" },
          { ref: { id: "o" }, label: "Opus (1M context)", resolvedModelLabel: "claude-opus-5[1m]" },
          { ref: { id: "s" }, label: "Sonnet", resolvedModelLabel: "claude-sonnet-5" },
          { ref: { id: "x" }, label: "Custom" },
        ],
        thinkingOptions: [{ id: "auto", label: "Auto" }],
        defaultThinkingOptionId: "auto",
      }),
      routeId: (model) => `codexhost/claude-code-native@${model.ref.id}`,
    });
    expect(entries.map((entry) => entry.displayName)).toEqual([
      "Default (Opus 5)",
      "Fable 5.1",
      "Haiku 4.5",
      "Opus 5",
      "Sonnet 5",
      "Custom",
    ]);
  });

  it("names Models by their bare name unless that would be ambiguous", () => {
    const names = (labels: string[]) =>
      projectNativeModels({
        harnessName: "Claude Code",
        catalog: harnessModelCatalogSchema.parse({
          models: labels.map((label, index) => ({ ref: { id: `m${index}` }, label })),
          thinkingOptions: [{ id: "auto", label: "Auto" }],
          defaultThinkingOptionId: "auto",
        }),
        routeId: (model) => `codexhost/claude-code-native@${model.ref.id}`,
      }).map((entry) => entry.displayName);
    expect(names(["Default (recommended)", "Opus (1M context)", "Sonnet", "Haiku"])).toEqual([
      "Default",
      "Opus",
      "Sonnet",
      "Haiku",
    ]);
    // Two Opus variants stay distinguishable; an all-qualifier label is kept as it is.
    expect(names(["Opus", "Opus (1M context)", "(preview)"])).toEqual([
      "Opus",
      "Opus (1M context)",
      "(preview)",
    ]);
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
  it("maps the official permission selector without inferring full access", () => {
    const workspace = { permissions: ":workspace" };
    expect(
      nativePermissionLevel({
        ...workspace,
        approvalPolicy: { granular: {} },
        approvalsReviewer: "user",
      }),
    ).toBe("ask");
    expect(
      nativePermissionLevel({
        ...workspace,
        approvalPolicy: "on-request",
        approvalsReviewer: "guardian_subagent",
      }),
    ).toBe("auto-review");
    expect(
      nativePermissionLevel({ permissions: ":danger-full-access", approvalPolicy: "never" }),
    ).toBe("full-access");
    expect(nativePermissionLevel({ sandboxPolicy: { type: "dangerFullAccess" } })).toBe(
      "full-access",
    );
    // "never" is echoed by responses and appears under the ask level; it never grants access.
    expect(
      nativePermissionLevel({
        approvalPolicy: "never",
        approvalsReviewer: "user",
        sandboxPolicy: { type: "workspaceWrite" },
      }),
    ).toBe("ask");
    expect(nativePermissionLevel({ approvalPolicy: "never" })).toBe("ask");
    expect(nativePermissionLevel({ model: "gpt" })).toBeUndefined();
  });

  it("selects only Permission Modes the Harness offers and reads the Plan toggle", () => {
    const claude = ["plan", "default", "acceptEdits", "auto", "bypassPermissions"];
    expect(permissionModeForLevel("ask", claude)).toBe("default");
    expect(permissionModeForLevel("auto-review", claude)).toBe("auto");
    expect(permissionModeForLevel("auto-review", ["default", "acceptEdits"])).toBe("acceptEdits");
    expect(permissionModeForLevel("full-access", claude)).toBe("bypassPermissions");
    expect(permissionModeForLevel("full-access", ["default"])).toBeUndefined();
    expect(nativePlanMode({ collaborationMode: { mode: "plan", settings: {} } })).toBe(true);
    expect(nativePlanMode({ collaborationMode: { mode: "default", settings: {} } })).toBe(false);
    expect(nativePlanMode({})).toBeUndefined();
  });
  it("answers Thread responses with the preset the official selector recognises", () => {
    const granular = { granular: { rules: true } };
    // A response outside these presets is shown as a custom level.
    expect(nativePermissionResponse("ask", granular)).toEqual({
      approvalPolicy: granular,
      approvalsReviewer: "user",
      activePermissionProfile: { id: ":workspace", extends: null },
    });
    expect(nativePermissionResponse("ask")).toMatchObject({ approvalPolicy: "on-request" });
    expect(nativePermissionResponse("auto-review", granular)).toMatchObject({
      approvalPolicy: "on-request",
      approvalsReviewer: "guardian_subagent",
    });
    const fullAccess = nativePermissionResponse("full-access");
    expect(fullAccess).toEqual({
      approvalPolicy: "never",
      approvalsReviewer: "user",
      activePermissionProfile: { id: ":danger-full-access", extends: null },
      sandbox: { type: "dangerFullAccess" },
    });
    // The response round-trips to the same level when the Desktop sends it back.
    expect(nativePermissionLevel(fullAccess)).toBe("full-access");
    expect(nativePermissionLevel(nativePermissionResponse("auto-review"))).toBe("auto-review");
    expect(nativePermissionLevel(nativePermissionResponse("ask", granular))).toBe("ask");
  });

  it("reads the text of injected side chat items", () => {
    expect(
      injectedItemsText({
        threadId: "t",
        items: [
          {
            type: "message",
            role: "user",
            content: [
              { type: "input_text", text: "parent context" },
              { type: "input_image", image_url: "data:..." },
              { type: "input_text", text: "  " },
            ],
          },
          { type: "message", role: "user", content: [{ type: "input_text", text: "second" }] },
          "unexpected",
        ],
      }),
    ).toEqual(["parent context", "second"]);
    expect(injectedItemsText({ threadId: "t" })).toEqual([]);
  });

  it("reads the message of a Turn started by another Thread from its tool output", () => {
    const output =
      "<codex_delegation>\n  <source_thread_id>a</source_thread_id>\n  <input>hi</input>\n</codex_delegation>";
    expect(
      toolOutputText({
        threadId: "t",
        input: [],
        toolOutput: { name: "create_thread", namespace: "codex_app", output },
      }),
    ).toBe(output);
    expect(toolOutputText({ threadId: "t", input: [], toolOutput: null })).toBeUndefined();
    expect(
      toolOutputText({ toolOutput: { name: "x", namespace: "other", output: "text" } }),
    ).toBeUndefined();
    expect(
      toolOutputText({ toolOutput: { name: "x", namespace: "codex_app", output: "  " } }),
    ).toBeUndefined();
  });
});
