/**
 * Native Model picker projection.
 *
 * Codex Desktop renders its Model and reasoning-effort controls from `model/list` and
 * `config/read`, and persists a selection with `config/batchWrite`. Projecting an external
 * Harness catalog into those responses lets the user pick a Harness Model with the official
 * controls, so nothing has to be injected into the Desktop renderer.
 *
 * The route id placed in the official `model` field is only a routing token. It must never be
 * written to the user's real `config.toml`: a plain Codex CLI would then start with an unknown
 * Model. Selection writes are therefore kept in a Host-owned file and overlaid on `config/read`.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type {
  HarnessModel,
  HarnessModelCatalog,
  HarnessThinkingOptionId,
  JsonObject,
  JsonValue,
} from "@codexhost/shared-contracts";

export const NATIVE_ROUTE_PREFIX = "codexhost/";

/** Reasoning efforts the official picker can display, in display order. */
const NATIVE_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
const FALLBACK_EFFORT = "medium";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function isNativeRouteModel(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(NATIVE_ROUTE_PREFIX);
}

function modelEfforts(model: HarnessModel, catalog: HarnessModelCatalog): string[] {
  const supported = new Set<string>(
    model.supportedThinkingOptionIds ?? catalog.thinkingOptions.map(({ id }) => id),
  );
  return NATIVE_EFFORTS.filter((effort) => supported.has(effort));
}

export interface NativeModelProjectionInput {
  harnessName: string;
  catalog: HarnessModelCatalog;
  /** Encodes a Harness Model Ref into the route id carried by the official `model` field. */
  routeId(model: HarnessModel): string;
}

/** Project a Harness Model Catalog into official `model/list` entries. */
export function projectNativeModels(input: NativeModelProjectionInput): JsonObject[] {
  const labels = new Map(input.catalog.thinkingOptions.map(({ id, label }) => [id, label]));
  return input.catalog.models.map((model) => {
    const efforts = modelEfforts(model, input.catalog);
    const advertised = efforts.length > 0 ? efforts : [FALLBACK_EFFORT];
    const preferred = input.catalog.defaultThinkingOptionId;
    const defaultEffort =
      preferred && advertised.includes(preferred)
        ? preferred
        : advertised.includes(FALLBACK_EFFORT)
          ? FALLBACK_EFFORT
          : (advertised[0] ?? FALLBACK_EFFORT);
    const route = input.routeId(model);
    const displayName = model.label.toLowerCase().includes(input.harnessName.toLowerCase())
      ? model.label
      : `${input.harnessName} · ${model.label}`;
    return {
      id: route,
      model: route,
      displayName,
      description: model.resolvedModelLabel ?? `${input.harnessName} Model`,
      hidden: false,
      isDefault: false,
      defaultReasoningEffort: defaultEffort,
      supportedReasoningEfforts: advertised.map((effort) => ({
        reasoningEffort: effort,
        description: labels.get(effort as HarnessThinkingOptionId) ?? effort,
      })),
      inputModalities: ["text", "image"],
      supportsPersonality: false,
      additionalSpeedTiers: [],
      serviceTiers: [],
      upgrade: null,
      upgradeInfo: null,
      availabilityNux: null,
    } satisfies JsonObject;
  });
}

/** Map an official reasoning effort to a Thinking option of the catalog, when one matches. */
export function thinkingOptionForEffort(
  effort: unknown,
  catalog: Pick<HarnessModelCatalog, "thinkingOptions">,
): HarnessThinkingOptionId | undefined {
  if (typeof effort !== "string") return undefined;
  const wanted = effort === "none" || effort === "minimal" ? "off" : effort;
  return catalog.thinkingOptions.find(({ id }) => id === wanted)?.id;
}

/** Map a Thinking option back to the official effort the picker shows for a Thread. */
export function effortForThinkingOption(thinkingOptionId: string | undefined): string {
  if (thinkingOptionId === "off") return "none";
  return (NATIVE_EFFORTS as readonly string[]).includes(thinkingOptionId ?? "")
    ? (thinkingOptionId as string)
    : FALLBACK_EFFORT;
}

export interface RequestedNativeSelection {
  model?: string;
  effort?: string;
}

/**
 * Model and effort carried by `thread/start`, `turn/start` or `thread/settings/update`.
 * The official schema gives `collaborationMode.settings` precedence over top-level fields.
 */
export function requestedNativeSelection(params: JsonObject): RequestedNativeSelection {
  const settings =
    isRecord(params.collaborationMode) && isRecord(params.collaborationMode.settings)
      ? params.collaborationMode.settings
      : undefined;
  const config = isRecord(params.config) ? params.config : undefined;
  const model = [settings?.model, params.model].find((value) => typeof value === "string");
  const effort = [
    settings?.reasoning_effort,
    params.effort,
    params.reasoningEffort,
    config?.model_reasoning_effort,
  ].find((value) => typeof value === "string");
  return {
    ...(typeof model === "string" ? { model } : {}),
    ...(typeof effort === "string" ? { effort } : {}),
  };
}

/** The three levels of the official permission selector, plus the Plan collaboration mode. */
export type NativePermissionLevel = "ask" | "auto-review" | "full-access";

const FULL_ACCESS_PROFILE = ":danger-full-access";
const FULL_ACCESS_SANDBOXES = new Set(["dangerFullAccess", "danger-full-access"]);
const AUTO_REVIEWERS = new Set(["guardian_subagent", "auto_review"]);

/**
 * Permission level carried by `thread/start` or `thread/settings/update`.
 *
 * Full access is recognised only by its explicit profile or sandbox. `approvalPolicy: "never"`
 * alone is not a signal: responses echo it, and treating it as consent would silently turn the
 * most restrictive level into the least restrictive one.
 */
export function nativePermissionLevel(params: JsonObject): NativePermissionLevel | undefined {
  const profileOf = (value: unknown): string | undefined =>
    typeof value === "string"
      ? value
      : isRecord(value) && typeof value.id === "string"
        ? value.id
        : undefined;
  const profile =
    profileOf(params.permissions) ??
    profileOf(params.activePermissionProfile) ??
    profileOf(params.permissionProfile);
  const sandbox =
    isRecord(params.sandboxPolicy) && typeof params.sandboxPolicy.type === "string"
      ? params.sandboxPolicy.type
      : typeof params.sandbox === "string"
        ? params.sandbox
        : undefined;
  if (profile === FULL_ACCESS_PROFILE || (sandbox && FULL_ACCESS_SANDBOXES.has(sandbox)))
    return "full-access";
  if (typeof params.approvalsReviewer === "string") {
    return AUTO_REVIEWERS.has(params.approvalsReviewer) ? "auto-review" : "ask";
  }
  return profile !== undefined || params.approvalPolicy !== undefined ? "ask" : undefined;
}

/**
 * Permission fields a Thread response must carry so the official selector shows the Thread's
 * level. Values mirror the Desktop presets; anything else is displayed as a custom level.
 */
export function nativePermissionResponse(
  level: NativePermissionLevel,
  approvalPolicy?: JsonValue,
): JsonObject {
  if (level === "full-access")
    return {
      approvalPolicy: "never",
      approvalsReviewer: "user",
      activePermissionProfile: { id: FULL_ACCESS_PROFILE, extends: null },
      sandbox: { type: "dangerFullAccess" },
    };
  return {
    approvalPolicy:
      level === "ask" && isRecord(approvalPolicy) ? (approvalPolicy as JsonObject) : "on-request",
    approvalsReviewer: level === "auto-review" ? "guardian_subagent" : "user",
    activePermissionProfile: { id: ":workspace", extends: null },
  };
}

/** Text of items sent with `thread/inject_items` (side chat context). */
export function injectedItemsText(params: JsonObject): string[] {
  if (!Array.isArray(params.items)) return [];
  return params.items.flatMap((item) =>
    isRecord(item) && Array.isArray(item.content)
      ? item.content.flatMap((part) =>
          isRecord(part) && typeof part.text === "string" && part.text.trim() ? [part.text] : [],
        )
      : [],
  );
}

/** Whether the request turns the native Plan collaboration mode on (`true`) or off (`false`). */
export function nativePlanMode(params: JsonObject): boolean | undefined {
  const mode = isRecord(params.collaborationMode) ? params.collaborationMode.mode : undefined;
  return typeof mode === "string" ? mode === "plan" : undefined;
}

/** Harness Permission Mode for a native level, limited to the modes the Harness offers. */
export function permissionModeForLevel(
  level: NativePermissionLevel,
  offered: readonly string[],
): string | undefined {
  const preference = {
    ask: ["default"],
    "auto-review": ["auto", "acceptEdits"],
    "full-access": ["bypassPermissions"],
  }[level];
  return preference.find((id) => offered.includes(id));
}

/** Permission-related fields of a request, reduced to enum-like values for tracing/mapping. */
export function requestedNativePermission(params: JsonObject): JsonObject {
  const kind = (value: unknown): JsonValue =>
    typeof value === "string"
      ? value
      : isRecord(value) && typeof value.type === "string"
        ? value.type
        : value === undefined
          ? null
          : isRecord(value)
            ? Object.keys(value).sort().join(",")
            : null;
  // Shape only: paths and long strings are replaced so a trace never records the workspace.
  const shape = (value: unknown, depth = 0): JsonValue => {
    if (typeof value === "string")
      return value.includes("/") || value.length > 40 ? "<str>" : value;
    if (value === null || typeof value === "boolean" || typeof value === "number") return value;
    if (Array.isArray(value))
      return depth > 3 ? "<array>" : value.slice(0, 4).map((v) => shape(v, depth + 1));
    if (isRecord(value))
      return depth > 3
        ? "<object>"
        : Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shape(v, depth + 1)]));
    return null;
  };
  const mode = isRecord(params.collaborationMode) ? params.collaborationMode.mode : undefined;
  return {
    permissions: shape(params.permissions),
    approvalPolicy: kind(params.approvalPolicy),
    approvalsReviewer: kind(params.approvalsReviewer),
    sandbox: kind(params.sandbox),
    sandboxPolicy: kind(params.sandboxPolicy),
    permissionProfile: kind(params.permissionProfile ?? params.activePermissionProfile),
    collaborationMode: typeof mode === "string" ? mode : null,
  };
}

const SELECTION_KEY = /^(?:profiles\.(?<profile>[^.]+)\.)?(?<key>model|model_reasoning_effort)$/u;

export interface NativeSelection {
  model: string;
  effort?: string;
}

export interface ConfigEditPlan {
  /** Edits that still belong to the official configuration, in their original order. */
  official: JsonValue[];
  /** Selection to store in the Host, `null` to clear it, `undefined` to leave it unchanged. */
  selection: NativeSelection | null | undefined;
}

/** Split configuration edits between the official config file and the Host-owned selection. */
export function planConfigEdits(
  edits: readonly JsonValue[],
  current: NativeSelection | null,
): ConfigEditPlan {
  const selectionEdits = edits.flatMap((edit) => {
    if (!isRecord(edit) || typeof edit.keyPath !== "string") return [];
    const match = SELECTION_KEY.exec(edit.keyPath);
    return match?.groups?.key ? [{ edit, key: match.groups.key, value: edit.value }] : [];
  });
  const modelEdit = selectionEdits.find(({ key }) => key === "model");
  const effortEdit = selectionEdits.find(({ key }) => key === "model_reasoning_effort");
  const effort = typeof effortEdit?.value === "string" ? effortEdit.value : undefined;
  if (modelEdit && isNativeRouteModel(modelEdit.value)) {
    const owned = new Set<JsonValue>(selectionEdits.map(({ edit }) => edit as JsonValue));
    const previousEffort = current?.model === modelEdit.value ? current.effort : undefined;
    const nextEffort = effort ?? previousEffort;
    return {
      official: edits.filter((edit) => !owned.has(edit)),
      selection: { model: modelEdit.value, ...(nextEffort ? { effort: nextEffort } : {}) },
    };
  }
  // Choosing an official Model returns ownership of both keys to the official config.
  if (modelEdit) return { official: [...edits], selection: null };
  if (current && effortEdit) {
    return {
      official: edits.filter((edit) => edit !== effortEdit.edit),
      selection: { model: current.model, ...(effort ? { effort } : {}) },
    };
  }
  return { official: [...edits], selection: undefined };
}

/** Overlay the Host-owned selection on an official `config/read` result. */
export function overlayNativeSelection(
  result: JsonObject,
  selection: NativeSelection | null,
): JsonObject {
  if (!selection || !isRecord(result.config)) return result;
  return {
    ...result,
    config: {
      ...result.config,
      model: selection.model,
      ...(selection.effort ? { model_reasoning_effort: selection.effort } : {}),
    } as JsonObject,
  };
}

/** Persists the native picker selection outside the official Codex configuration. */
export class NativeSelectionStore {
  #loaded = false;
  #selection: NativeSelection | null = null;
  readonly #file: string | undefined;

  constructor(dataDirectory: string | undefined) {
    this.#file = dataDirectory
      ? path.join(path.resolve(dataDirectory), "native-picker-selection.json")
      : undefined;
  }

  async get(): Promise<NativeSelection | null> {
    if (this.#loaded || !this.#file) return this.#selection;
    this.#loaded = true;
    try {
      const parsed: unknown = JSON.parse(await readFile(this.#file, "utf8"));
      if (isRecord(parsed) && isNativeRouteModel(parsed.model)) {
        this.#selection = {
          model: parsed.model,
          ...(typeof parsed.effort === "string" ? { effort: parsed.effort } : {}),
        };
      }
    } catch {
      this.#selection = null;
    }
    return this.#selection;
  }

  async set(selection: NativeSelection | null): Promise<void> {
    this.#loaded = true;
    this.#selection = selection;
    if (!this.#file) return;
    await mkdir(path.dirname(this.#file), { recursive: true, mode: 0o700 });
    const staging = `${this.#file}.${process.pid}.tmp`;
    await writeFile(staging, `${JSON.stringify(selection)}\n`, { mode: 0o600 });
    await rename(staging, this.#file);
  }
}
