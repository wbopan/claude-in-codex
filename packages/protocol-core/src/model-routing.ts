import {
  decodeHarnessPluginRoute,
  encodeHarnessPluginRoute,
  harnessPluginIdSchema,
  harnessModelRefSchema,
  harnessPermissionModeIdSchema,
  harnessThinkingOptionIdSchema,
  type HarnessModelRef,
  type HarnessPermissionModeId,
  type HarnessThinkingOptionId,
  normalizeRouteId,
  ROUTE_PREFIX,
  type JsonRpcRequest,
} from "@claude-in-codex/shared-contracts";

export const CLAUDE_CODE_NATIVE_TRANSPORT_MODEL_ID = `${ROUTE_PREFIX}claude-code-native`;
export const CLAUDE_CODE_NATIVE_TRANSPORT_MODEL_PREFIX = `${CLAUDE_CODE_NATIVE_TRANSPORT_MODEL_ID}@`;
/** Open identity space; the Host Registry, not this legacy list, validates installation. */
export type ExternalHarnessId = string;
export type RoutedHarnessId = "codex" | ExternalHarnessId;

const transportModelByHarness: Readonly<Record<string, string>> = {
  "claude-code": CLAUDE_CODE_NATIVE_TRANSPORT_MODEL_ID,
} as const satisfies Record<ExternalHarnessId, string>;

const harnessByTransportModel = new Map<string, ExternalHarnessId>(
  Object.entries(transportModelByHarness).map(([harnessId, transportModelId]) => [
    transportModelId,
    harnessId as ExternalHarnessId,
  ]),
);

export interface CreateRoute {
  harnessId: RoutedHarnessId;
  routeMode?: "native";
  transportModelId?: string;
  model?: HarnessModelRef;
  thinkingOptionId?: HarnessThinkingOptionId;
  permissionModeId?: HarnessPermissionModeId;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function transportModelIdForHarness(harnessId: ExternalHarnessId): string {
  const legacy = Object.hasOwn(transportModelByHarness, harnessId)
    ? transportModelByHarness[harnessId]
    : undefined;
  return legacy ?? encodeHarnessPluginRoute({ harnessId: harnessPluginIdSchema.parse(harnessId) });
}

export interface ExternalConfigurationSelection {
  model?: HarnessModelRef;
  thinkingOptionId?: HarnessThinkingOptionId;
  permissionModeId?: HarnessPermissionModeId;
}

export function encodeClaudeTransportModel(
  model?: HarnessModelRef,
  permissionModeId?: HarnessPermissionModeId,
  thinkingOptionId?: HarnessThinkingOptionId,
): string {
  if (!model) {
    if (permissionModeId || thinkingOptionId) {
      throw new Error("Claude Code transport configuration requires a Model Ref");
    }
    return CLAUDE_CODE_NATIVE_TRANSPORT_MODEL_ID;
  }
  const parsedModel = harnessModelRefSchema.parse(model);
  const parsedPermissionModeId = permissionModeId
    ? harnessPermissionModeIdSchema.parse(permissionModeId)
    : undefined;
  const parsedThinkingOptionId = thinkingOptionId
    ? harnessThinkingOptionIdSchema.parse(thinkingOptionId)
    : undefined;
  if (parsedThinkingOptionId) {
    return `${CLAUDE_CODE_NATIVE_TRANSPORT_MODEL_PREFIX}${parsedModel.id}@${parsedPermissionModeId ?? ""}@${parsedThinkingOptionId}`;
  }
  return `${CLAUDE_CODE_NATIVE_TRANSPORT_MODEL_PREFIX}${parsedModel.id}${parsedPermissionModeId ? `@${parsedPermissionModeId}` : ""}`;
}

export function decodeClaudeTransportSelection(
  input: unknown,
): ExternalConfigurationSelection | null {
  const value = normalizeRouteId(input);
  if (value === CLAUDE_CODE_NATIVE_TRANSPORT_MODEL_ID) return {};
  if (typeof value !== "string" || !value.startsWith(CLAUDE_CODE_NATIVE_TRANSPORT_MODEL_PREFIX)) {
    return null;
  }
  const components = value.slice(CLAUDE_CODE_NATIVE_TRANSPORT_MODEL_PREFIX.length).split("@");
  if (components.length < 1 || components.length > 3) {
    throw new Error("Claude Code transport configuration has an invalid component count");
  }
  const [modelId, permissionModeId, thinkingOptionId] = components;
  if (components.length === 2 && !permissionModeId) {
    throw new Error("Claude Code transport configuration has an empty Permission Mode");
  }
  if (components.length === 3 && !thinkingOptionId) {
    throw new Error("Claude Code transport configuration has an empty Thinking option");
  }
  const model = harnessModelRefSchema.safeParse({ id: modelId });
  if (!model.success) {
    throw new Error("Claude Code transport Model contains an invalid Model Ref");
  }
  const permissionMode = permissionModeId
    ? harnessPermissionModeIdSchema.safeParse(permissionModeId)
    : null;
  if (permissionMode && !permissionMode.success) {
    throw new Error("Claude Code transport configuration contains an invalid Permission Mode");
  }
  const thinking = thinkingOptionId
    ? harnessThinkingOptionIdSchema.safeParse(thinkingOptionId)
    : null;
  if (thinking && !thinking.success) {
    throw new Error("Claude Code transport configuration contains an invalid Thinking option");
  }
  return {
    model: model.data,
    ...(permissionMode?.success ? { permissionModeId: permissionMode.data } : {}),
    ...(thinking?.success ? { thinkingOptionId: thinking.data } : {}),
  };
}

export function encodeExternalTransportSelection(
  harnessId: ExternalHarnessId,
  selection: ExternalConfigurationSelection,
): string {
  switch (harnessId) {
    case "claude-code":
      return encodeClaudeTransportModel(
        selection.model,
        selection.permissionModeId,
        selection.thinkingOptionId,
      );
    default:
      return encodeHarnessPluginRoute({
        harnessId: harnessPluginIdSchema.parse(harnessId),
        ...selection,
      });
  }
}

export function decodeExternalTransportSelection(
  harnessId: ExternalHarnessId,
  value: unknown,
): ExternalConfigurationSelection | null {
  const route = decodeHarnessPluginRoute(value);
  if (route) {
    if (route.harnessId !== harnessId) return null;
    return {
      ...(route.model ? { model: route.model } : {}),
      ...(route.thinkingOptionId ? { thinkingOptionId: route.thinkingOptionId } : {}),
      ...(route.permissionModeId ? { permissionModeId: route.permissionModeId } : {}),
    };
  }
  switch (harnessId) {
    case "claude-code":
      return decodeClaudeTransportSelection(value);
    default:
      return null;
  }
}

export function decodeExternalTransportModel(
  harnessId: ExternalHarnessId,
  value: unknown,
): HarnessModelRef | null | undefined {
  const selection = decodeExternalTransportSelection(harnessId, value);
  return selection === null ? null : selection.model;
}

export function decodeCreateRoute(request: JsonRpcRequest): CreateRoute | null {
  if (request.method !== "thread/start") return null;
  if (!isJsonObject(request.params)) throw new Error("thread/start params must be an object");
  // Official App Tools omit Model selection or send null to use the configured default.
  if (request.params.model == null) return { harnessId: "codex" };
  if (typeof request.params.model !== "string") {
    throw new Error("thread/start params.model must be text or null");
  }
  // A Desktop that outlived a pre-rename Host may still send its route ids.
  request.params.model = normalizeRouteId(request.params.model);

  const pluginRoute = decodeHarnessPluginRoute(request.params.model);
  if (pluginRoute) {
    return {
      harnessId: pluginRoute.harnessId,
      routeMode: "native",
      transportModelId: request.params.model,
      ...(pluginRoute.model ? { model: pluginRoute.model } : {}),
      ...(pluginRoute.thinkingOptionId ? { thinkingOptionId: pluginRoute.thinkingOptionId } : {}),
      ...(pluginRoute.permissionModeId ? { permissionModeId: pluginRoute.permissionModeId } : {}),
    };
  }

  const claudeSelection = decodeClaudeTransportSelection(request.params.model);
  if (claudeSelection !== null) {
    return {
      harnessId: "claude-code",
      routeMode: "native",
      transportModelId: request.params.model,
      ...claudeSelection,
    };
  }

  const harnessId = harnessByTransportModel.get(request.params.model);
  return harnessId
    ? {
        harnessId,
        routeMode: "native",
        transportModelId: request.params.model,
      }
    : { harnessId: "codex", transportModelId: request.params.model };
}
