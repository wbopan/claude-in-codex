import { z } from "zod";
import { WORKSPACE_CONTRACT_VERSION } from "./version.js";
export {
  IDLE_RELEASE_SETTINGS_METHOD,
  IDLE_RELEASE_TIMEOUT_MINUTES_MAX,
  IDLE_RELEASE_TIMEOUT_MINUTES_MIN,
  DEFAULT_IDLE_RELEASE_SETTINGS,
  idleReleaseSettingsSchema,
  type IdleReleaseSettings,
} from "./idle-release.js";
export {
  DEFAULT_FEATURE_SETTINGS,
  FEATURE_IDS,
  FEATURES_FILE,
  MEMORY_SYNC_RESULT_FILE,
  featureIdSchema,
  featureSettingsSchema,
  idleReleaseMinutesSchema,
  idleReleaseSettings,
  memorySyncResultSchema,
  resolveFeatures,
  type FeatureId,
  type FeatureSettings,
  type FeatureState,
  type MemorySyncResult,
} from "./features.js";
export {
  LOADED_SESSIONS_METHOD,
  loadedSessionsSchema,
  type LoadedSession,
} from "./loaded-sessions.js";

export {
  harnessAccountSnapshotSchema,
  harnessAccountSourceSchema,
  harnessAccountSourceListParamsSchema,
  harnessAccountSourceListResultSchema,
  harnessAccountInspectParamsSchema,
  harnessAccountInspectResultSchema,
  harnessAccountListParamsSchema,
  harnessAccountListResultSchema,
} from "./harness-accounts.js";
export type {
  HarnessAccountSnapshot,
  HarnessAccountSource,
  HarnessAccountSourceListResult,
  HarnessAccountInspectParams,
  HarnessAccountInspectResult,
  HarnessAccountListParams,
  HarnessAccountListResult,
} from "./harness-accounts.js";

export {
  HARNESS_PLUGIN_ROUTE_PREFIX,
  LEGACY_ROUTE_PREFIX,
  ROUTE_PREFIX,
  normalizeRouteId,
  decodeHarnessPluginRoute,
  encodeHarnessPluginRoute,
  harnessPluginRouteSchema,
} from "./harness-route.js";
export type { HarnessPluginRoute } from "./harness-route.js";
export {
  HARNESS_PLUGIN_API_VERSION,
  HARNESS_PLUGIN_ICON_MAX_BYTES,
  HARNESS_PLUGIN_LIMIT,
  HARNESS_PLUGIN_MANIFEST_MAX_BYTES,
  harnessPluginConfigurationSchema,
  harnessPluginDescriptorSchema,
  harnessPluginIconSchema,
  harnessPluginIdSchema,
  harnessPluginManifestSchema,
} from "./harness-plugins.js";
export type {
  HarnessPluginConfiguration,
  HarnessPluginDescriptor,
  HarnessPluginManifest,
} from "./harness-plugins.js";
export * from "./harness-launch-settings.js";
export { claudeInCodexErrorSchema } from "./errors.js";
export {
  codexAccountUsageParamsSchema,
  codexAccountUsageResultSchema,
  codexAccountPhaseSchema,
  codexAccountListResultSchema,
  codexAccountPlanTypeSchema,
  codexAccountSchema,
} from "./codex-accounts.js";
export type {
  CodexAccountUsageParams,
  CodexAccountUsageResult,
  CodexAccountPhase,
  CodexAccountListResult,
  CodexAccountPlanType,
  CodexAccountSummary,
} from "./codex-accounts.js";
export type { ClaudeInCodexError } from "./errors.js";
export {
  HARNESS_PERMISSION_MODE_CATALOG_MAX_LENGTH,
  HARNESS_PERMISSION_MODE_DESCRIPTION_MAX_LENGTH,
  HARNESS_PERMISSION_MODE_ID_MAX_LENGTH,
  HARNESS_PERMISSION_MODE_LABEL_MAX_LENGTH,
  harnessPermissionModeCatalogSchema,
  harnessPermissionModeIdSchema,
  harnessPermissionModeSchema,
} from "./harness-permission-modes.js";
export type {
  HarnessPermissionMode,
  HarnessPermissionModeCatalog,
  HarnessPermissionModeId,
} from "./harness-permission-modes.js";
export {
  HARNESS_MODEL_LABEL_MAX_LENGTH,
  HARNESS_MODEL_REF_MAX_LENGTH,
  HARNESS_THINKING_OPTION_ID_MAX_LENGTH,
  harnessConfigurationStateSchema,
  harnessInspectionSchema,
  harnessModelCatalogSchema,
  harnessModelRefIdSchema,
  harnessModelRefSchema,
  harnessModelSchema,
  harnessModelSelectionStateSchema,
  harnessPermissionModeScopeSchema,
  harnessResolvedModelLabelSchema,
  harnessSessionCapabilitiesSchema,
  harnessThinkingOptionIdSchema,
  harnessThinkingOptionSchema,
  permissionModeFixedAtCreate,
} from "./harness-models.js";
export type {
  HarnessConfigurationState,
  HarnessInspection,
  HarnessModel,
  HarnessModelCatalog,
  HarnessModelRef,
  HarnessModelSelectionState,
  HarnessPermissionModeScope,
  HarnessSessionCapabilities,
  HarnessThinkingOption,
  HarnessThinkingOptionId,
} from "./harness-models.js";
export {
  harnessCommandCatalogSchema,
  harnessCommandDescriptorSchema,
  threadCommandExecuteResultSchema,
} from "./harness-commands.js";
export type {
  HarnessCommandCatalog,
  HarnessCommandDescriptor,
  ThreadCommandExecuteResult,
} from "./harness-commands.js";
export {
  accountCreditsProductUsageSchema,
  accountResetCreditsSchema,
  accountCreditsSnapshotSchema,
  threadUsageInspectionParamsSchema,
  threadUsageInspectionSchema,
  threadUsageSnapshotSchema,
} from "./thread-usage.js";
export type {
  AccountCreditsSnapshot,
  AccountResetCredits,
  ThreadUsageInspection,
  ThreadUsageInspectionParams,
  ThreadUsageSnapshot,
} from "./thread-usage.js";
export {
  harnessIdSchema,
  hostInteractionIdSchema,
  hostItemIdSchema,
  hostThreadIdSchema,
  hostTurnIdSchema,
} from "./ids.js";
export type { HarnessId, HostInteractionId, HostItemId, HostThreadId, HostTurnId } from "./ids.js";
export {
  jsonRpcEnvelopeSchema,
  jsonRpcErrorResponseSchema,
  jsonRpcErrorSchema,
  jsonRpcIdSchema,
  jsonRpcNotificationSchema,
  jsonRpcRequestSchema,
  jsonRpcSuccessResponseSchema,
} from "./json-rpc.js";
export type {
  JsonRpcEnvelope,
  JsonRpcError,
  JsonRpcErrorResponse,
  JsonRpcId,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcSuccessResponse,
} from "./json-rpc.js";
export {
  jsonArraySchema,
  jsonObjectSchema,
  jsonPrimitiveSchema,
  jsonValueSchema,
} from "./json-value.js";
export type { JsonArray, JsonObject, JsonPrimitive, JsonValue } from "./json-value.js";
export {
  nativeCheckpointRefSchema,
  nativeCheckpointRefV1Schema,
  nativeSessionRefSchema,
  nativeSessionRefV1Schema,
  nativeTurnRefSchema,
  nativeTurnRefV1Schema,
} from "./native-refs.js";
export type {
  NativeCheckpointRef,
  NativeCheckpointRefV1,
  NativeSessionRef,
  NativeSessionRefV1,
  NativeTurnRef,
  NativeTurnRefV1,
} from "./native-refs.js";
export { WORKSPACE_CONTRACT_VERSION } from "./version.js";

export const workspaceContractVersionSchema = z.literal(WORKSPACE_CONTRACT_VERSION);

export const packageMetadata = {
  name: "@claude-in-codex/shared-contracts",
  contractVersion: WORKSPACE_CONTRACT_VERSION,
} as const;
export {
  APP_NAME,
  APP_SLUG,
  DATA_DIRECTORY_ENV,
  ENVIRONMENT_PREFIX,
  LEGACY_ENVIRONMENT_PREFIX,
  LEGACY_MODEL_PROVIDER,
  MODEL_PROVIDER,
  adoptLegacyEnvironment,
  isAppEnvironmentVariable,
} from "./app-identity.js";
