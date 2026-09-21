import { appConsentEnabled, consentedApp } from "./desktop-app-consent.js";
import { OfficialDesktopTools } from "./official-desktop-tools.js";
import {
  IDLE_RELEASE_SETTINGS_METHOD,
  LOADED_SESSIONS_METHOD,
  idleReleaseSettingsSchema,
} from "@codexhost/shared-contracts";
import { AccountRateLimits } from "./codex-runtime/account-rate-limits.js";
import { NativeAccountObserver } from "./native-account-observer.js";
import { HarnessAccountInspectionCache, listHarnessAccountSources } from "./harness-accounts.js";
import type { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import os from "node:os";
import { appendFileSync } from "node:fs";
import path from "node:path";
import type { Readable, Writable } from "node:stream";

import type {
  HarnessAdapter,
  HarnessOutput,
  HarnessSession,
  HostApprovalInteraction,
  HostSubagentState,
  HostApprovalResponse,
  HostQuestionInteraction,
} from "@codexhost/harness-adapter";
import { parseHostUsage, type HostUsage } from "@codexhost/harness-adapter";
import type { HarnessPluginContext } from "@codexhost/harness-adapter/plugin";
import type { StoredThreadRecordV1 } from "@codexhost/mapping-store";
import {
  accountCreditsSnapshotSchema,
  harnessAccountInspectParamsSchema,
  harnessAccountInspectResultSchema,
  type HarnessAccountInspectResult,
  harnessAccountListParamsSchema,
  harnessAccountListResultSchema,
  harnessAccountSourceListParamsSchema,
  codexAccountUsageParamsSchema,
  codexAccountUsageResultSchema,
  type HarnessPluginDescriptor,
  threadCommandExecuteResultSchema,
  harnessInspectionSchema,
  HARNESS_LAUNCH_SETTINGS_GET_METHOD,
  HARNESS_LAUNCH_SETTINGS_SET_METHOD,
  harnessLaunchSettingsGetSchema,
  harnessLaunchSettingsSetSchema,
  hostItemIdSchema,
  hostTurnIdSchema,
  jsonValueSchema,
  threadUsageInspectionParamsSchema,
  threadUsageInspectionSchema,
  type AccountCreditsSnapshot,
  harnessPermissionModeIdSchema,
  type HarnessModelRef,
  type HarnessPermissionModeId,
  type HarnessThinkingOptionId,
  type HostInteractionId,
  type HostTurnId,
} from "@codexhost/shared-contracts";
import { executeExternalThreadFork } from "./external-thread-fork.js";
import {
  ExternalHistoryRequestError,
  listExternalItems,
  listExternalTurns,
} from "./external-thread-history.js";
import { executeExternalThreadRollback } from "./external-thread-rollback.js";
import {
  createExternalThreadRecordInput,
  createProductionExternalThreadStore,
  ExternalThreadRepository,
  externalThreadValue,
  type ExternalThreadStore,
} from "./external-thread-repository.js";
import {
  ExternalThreadRuntime,
  type ExternalThread,
  type ExternalThreadLocation,
  type ExternalThreadResolution,
} from "./external-thread-runtime.js";
import { ExternalSteerError, ExternalTurnSteering } from "./external-turn-steering.js";
import { loadHarnessPlugins } from "./harness-plugin-loader.js";
import { HarnessLaunchSettingsStore } from "./harness-launch-settings.js";
import {} from "@codexhost/shared-contracts";
import { DesktopRequestQueue } from "./desktop-request-queue.js";
import {} from "./official-codex-model-ref.js";
import {
  spawnOfficialAppServerConnection,
  type OfficialAppServerConnection,
} from "./official-app-server-connection.js";
import {
  SingleNativeCodexAccount,
  type CodexAccountControl,
} from "./account/codex-account-control.js";

import {
  createOwnedConnectionBackend,
  OfficialRuntimeClient,
  OfficialRuntimeScope,
} from "./codex-runtime/official-runtime-scope.js";
import {
  NativeSelectionStore,
  effortForThinkingOption,
  isNativeRouteModel,
  overlayNativeSelection,
  planConfigEdits,
  projectNativeModels,
  injectedItemsText,
  toolOutputText,
  nativePermissionLevel,
  nativePermissionResponse,
  nativePlanMode,
  permissionModeForLevel,
  requestedNativePermission,
  requestedNativeSelection,
  thinkingOptionForEffort,
} from "./native-picker.js";

const SUBAGENT_TERMINAL_REFRESH_DELAYS_MS = [0, 50, 100, 150] as const;
// Native Codex account quota is still pulled through its official API; keep
// that reading briefly cached so concurrent Composer inspections coalesce.

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
import {
  classifyThreadPurpose,
  RequestRouteObservationTracker,
  type CreateRequestRouteObservation,
  type RequestRouteObservation,
} from "./route-observation.js";
import {
  aggregateThreadList,
  officialThreadListPageFromResponse,
  OfficialThreadListError,
} from "./thread-list-aggregator.js";
import {
  CodexTurnProjector,
  decodeCreateRoute,
  decodeExternalTransportSelection,
  encodeExternalTransportSelection,
  decodeThreadArchiveRequest,
  decodeThreadForkRequest,
  decodeThreadListRequest,
  decodeThreadMetadataUpdateRequest,
  decodeThreadRevertRequest,
  decodeThreadRollbackRequest,
  mapExternalThreadHarnessError,
  projectCodexRateLimitsToCredits,
  observeCodexRateLimits,
  observeCodexTokenUsage,
  parseJsonFrame,
  projectCodexThreadUsage,
  readLfFrames,
  writeFrame,
  writeJsonFrame,
  jsonRpcRequestSchema,
  threadForkResult,
  threadRevertResult,
  threadRollbackResult,
  transportModelIdForHarness,
  type CodexApprovalProjection,
  type CodexQuestionProjection,
  type DecodedThreadForkRequest,
  type DecodedThreadListRequest,
  type DecodedThreadRevertRequest,
  type DecodedThreadRollbackRequest,
  type ExternalThreadRpcError,
  type CodexApprovalRequestProjection,
  type CodexQuestionRequestProjection,
  type ExternalHarnessId,
  type JsonObject,
  type JsonRpcId,
  type JsonRpcRequest,
  type JsonValue,
  type ProjectableHostEvent,
} from "@codexhost/protocol-core";

export interface AppServerHostOptions {
  stockCodexPath: string;
  arguments: string[];
  defaultAgent: "codex";
  environment?: NodeJS.ProcessEnv;
  desktopInput?: Readable;
  desktopOutput?: Writable;
  diagnosticOutput?: Writable;
  externalAdapters?: ReadonlyMap<ExternalHarnessId, HarnessAdapter>;
  pluginRoots?: readonly string[];
  pluginContext?: HarnessPluginContext;
  mappingStore?: ExternalThreadStore;
  /** Defaults to true. A listener that shares one store across sessions owns closing it. */
  closeMappingStoreOnExit?: boolean;
  spawnOfficial?: typeof spawn;
  createOfficialConnection?: () =>
    OfficialAppServerConnection | Promise<OfficialAppServerConnection>;
  accountControl?: CodexAccountControl;
  /** Shared by all Desktop/Remote Control sessions belonging to one Host. */
  officialRuntimeScope?: OfficialRuntimeScope;
  onCreateRequestRoute?: (observation: CreateRequestRouteObservation) => void;
  onRequestRoute?: (observation: RequestRouteObservation) => void;
}

interface TurnProjectionGate {
  promise: Promise<void>;
  resolve(): void;
}

interface ProjectedTurn {
  projector: CodexTurnProjector;
}

type HostApprovalRequestId = number;
type HostQuestionRequestId = number;

interface PendingDesktopApproval {
  thread: ExternalThread;
  interaction: HostApprovalInteraction;
  projection: CodexApprovalRequestProjection;
}

interface PendingDesktopQuestion {
  thread: ExternalThread;
  interaction: HostQuestionInteraction;
  projection: CodexQuestionRequestProjection;
  timeout: NodeJS.Timeout | null;
}

type ExternalThreadStatus = { type: "active"; activeFlags: [] } | { type: "idle" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCreditsAdapter(adapter: HarnessAdapter): adapter is HarnessAdapter & {
  credits(): unknown;
  refreshCredits?: () => Promise<unknown>;
} {
  return typeof (adapter as { credits?: unknown }).credits === "function";
}

function projectAccountCredits(value: unknown): AccountCreditsSnapshot | null {
  if (!isRecord(value)) return null;
  const rest = { ...value };
  delete rest.fetchedAt;
  const parsed = accountCreditsSnapshotSchema.safeParse(rest);
  return parsed.success ? parsed.data : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function codexAccountRpcError(error: unknown): { code: number; message: string } {
  const message = error instanceof Error ? error.message : "";
  return message === "Unknown Codex Account"
    ? { code: -32086, message }
    : { code: -32086, message: "Codex Account operation failed" };
}

export function officialEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const internal = new Set([
    "CODEX_CLI_PATH",
    "CODEXHOST_HOST_NODE_PATH",
    "CODEXHOST_DATA_DIR",
    "CODEXHOST_DEFAULT_AGENT",
    "CODEXHOST_HOST_RUNTIME_PATH",
    "CODEXHOST_NATIVE_APP_TOOLS",
    "CODEXHOST_DESKTOP_PARENT_SOCKET",
    "CODEXHOST_DESKTOP_PARENT_PID",
    "CODEXHOST_DESKTOP_PARENT_LAUNCH",
    "CODEXHOST_ENABLE_CLAUDE_CODE",
    "CODEXHOST_CLAUDE_COMMAND",
    "CODEXHOST_OPENCODE_COMMAND",
    "CODEXHOST_STOCK_CODEX_PATH",
    "CODEXHOST_LAUNCHER_PID",
    "CODEXHOST_LAUNCHER_EXECUTABLE",
    "CODEXHOST_RUNTIME_DESCRIPTOR_PATH",
    "CODEXHOST_CONTROL_PORT",
    "CODEXHOST_CONTROL_NONCE",
  ]);
  return Object.fromEntries(Object.entries(source).filter(([key]) => !internal.has(key)));
}

function rpcEnvelope(request: JsonRpcRequest, value: JsonObject): JsonObject {
  return {
    ...(request.jsonrpc === "2.0" ? { jsonrpc: "2.0" } : {}),
    id: request.id,
    ...value,
  };
}

function rpcError(request: JsonRpcRequest, code: number, message: string): JsonObject {
  return rpcEnvelope(request, { error: { code, message } });
}

function unixSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function approvalServerName(harnessId: ExternalHarnessId): string {
  return harnessId === "claude-code" ? "Claude Code" : harnessId;
}

const HOST_APPROVAL_REQUEST_ID_MIN = -2_000_000;
const HOST_APPROVAL_REQUEST_ID_MAX = -1_000_001;
const HOST_QUESTION_REQUEST_ID_MIN = -1_000_000;
const HOST_QUESTION_REQUEST_ID_MAX = -1;
const CROSS_HARNESS_MESSAGE =
  "This task belongs to a different Agent. Start a new task to use the selected Model.";
const EXPLICIT_EXTERNAL_THREAD_METHODS = new Set([
  "thread/archive",
  "thread/delete",
  "thread/fork",
  "thread/items/list",
  "thread/metadata/update",
  "thread/name/set",
  "thread/read",
  "thread/resume",
  "thread/revert",
  "thread/rollback",
  "thread/turns/list",
  "thread/unarchive",
  "thread/unsubscribe",
]);

function isHostApprovalRequestId(value: unknown): value is HostApprovalRequestId {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= HOST_APPROVAL_REQUEST_ID_MIN &&
    value <= HOST_APPROVAL_REQUEST_ID_MAX
  );
}

function isHostQuestionRequestId(value: unknown): value is HostQuestionRequestId {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= HOST_QUESTION_REQUEST_ID_MIN &&
    value <= HOST_QUESTION_REQUEST_ID_MAX
  );
}

export function classifyCreateRequestRoute(
  request: JsonRpcRequest,
): CreateRequestRouteObservation | null {
  const route = decodeCreateRoute(request);
  if (!route) return null;
  if (route.harnessId !== "codex") {
    return {
      requestMethod: "thread/start",
      modelCarrier: `${route.harnessId}-transport`,
      selectedHarness: route.harnessId,
      selectionSource: "transport-model",
    };
  }
  return {
    requestMethod: "thread/start",
    modelCarrier: "official-model",
    selectedHarness: "codex",
    selectionSource: "official-model",
  };
}

function requestObject(request: JsonRpcRequest): JsonObject {
  if (!isRecord(request.params)) throw new Error(`${request.method} params must be an object`);
  return request.params as JsonObject;
}

function requestText(params: JsonObject): string {
  if (!Array.isArray(params.input)) throw new Error("turn/start input must be an array");
  const text = params.input
    .filter((item): item is JsonObject => isRecord(item) && item.type === "text")
    .map((item) => item.text)
    .filter((value): value is string => typeof value === "string")
    .join("\n");
  const resolved = text || toolOutputText(params);
  if (!resolved) throw new Error("turn/start must contain text input");
  return resolved;
}

function sandboxResult(params: JsonObject): JsonObject {
  const sandbox = params.sandbox;
  if (sandbox === "read-only") return { type: "readOnly", networkAccess: false };
  if (sandbox === "danger-full-access") return { type: "dangerFullAccess" };
  return {
    type: "workspaceWrite",
    networkAccess: false,
    writableRoots: [],
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  };
}

function turnProjectionGate(): TurnProjectionGate {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

class OrderedWriter {
  #tail = Promise.resolve();

  constructor(private readonly stream: Writable) {}

  frame(frame: Buffer<ArrayBufferLike>): Promise<void> {
    return this.#enqueue(() => writeFrame(this.stream, frame));
  }

  json(value: JsonValue): Promise<void> {
    return this.#enqueue(() => writeJsonFrame(this.stream, value));
  }

  #enqueue(operation: () => Promise<void>): Promise<void> {
    const next = this.#tail.then(operation, operation);
    this.#tail = next.catch(() => undefined);
    return next;
  }
}

export class AppServerHost {
  readonly #options: Required<
    Pick<AppServerHostOptions, "desktopInput" | "desktopOutput" | "diagnosticOutput">
  > &
    AppServerHostOptions;
  #officialRuntime: OfficialRuntimeClient;
  #officialRuntimeScope: OfficialRuntimeScope;
  #ownsOfficialRuntimeScope: boolean;
  #accountControl: CodexAccountControl;
  #nativeAccountObserver: NativeAccountObserver | undefined;
  #externalAdapters: Map<ExternalHarnessId, HarnessAdapter>;
  #pluginDescriptors: HarnessPluginDescriptor[] = [];
  readonly #launchSettings: HarnessLaunchSettingsStore;
  readonly #accountInspections = new HarnessAccountInspectionCache();
  #externalRuntime: ExternalThreadRuntime;
  #desktopTools: OfficialDesktopTools;
  readonly #externalSteering = new ExternalTurnSteering();
  #nativeSelection = new NativeSelectionStore(undefined);
  #repository: ExternalThreadRepository;
  #pendingDesktopApprovals = new Map<HostApprovalRequestId, PendingDesktopApproval>();
  #pendingDesktopQuestions = new Map<HostQuestionRequestId, PendingDesktopQuestion>();
  #nextApprovalRequestId = HOST_APPROVAL_REQUEST_ID_MAX;
  #nextQuestionRequestId = HOST_QUESTION_REQUEST_ID_MAX;
  #activeOfficialTurns = new Map<string, string>();
  #pendingOfficialTurnStarts = new Map<unknown, string>();
  #activeWorkDrainWaiters = new Set<() => void>();
  #officialUsageByThread = new Map<string, HostUsage>();
  readonly #officialRateLimits = new AccountRateLimits();
  #routeObservationTracker = new RequestRouteObservationTracker();
  #officialServerRequests = new Map<JsonRpcId, JsonRpcId>();
  #nextOfficialServerRequestId = 0;
  #writer: OrderedWriter;
  #subagentThreadStatuses = new Map<string, "active" | "idle">();
  #runningSubagentsByParent = new Map<string, Set<string>>();
  #pendingExternalCommandRequests = new Set<string>();
  #closeRequested = false;
  readonly #pluginLoadAbort = new AbortController();
  #pluginLoading: Promise<void> | undefined;
  readonly #desktopRequests = new DesktopRequestQueue();
  readonly #pendingDesktopElicitations = new Map<
    HostApprovalRequestId,
    (result: JsonObject) => void
  >();
  #drainActiveWorkOnInputEnd = false;
  #desktopInputEnded = false;

  constructor(options: AppServerHostOptions) {
    this.#nativeSelection = new NativeSelectionStore(
      (options.environment ?? process.env).CODEXHOST_DATA_DIR,
    );
    this.#options = {
      desktopInput: process.stdin,
      desktopOutput: process.stdout,
      diagnosticOutput: process.stderr,
      ...options,
    };
    this.#writer = new OrderedWriter(this.#options.desktopOutput);
    const environment = this.#options.environment ?? process.env;
    this.#launchSettings = new HarnessLaunchSettingsStore(
      this.#options.pluginContext?.environment ?? environment,
    );
    const permanentHome = path.resolve(environment.CODEX_HOME ?? path.join(os.homedir(), ".codex"));
    this.#ownsOfficialRuntimeScope = options.officialRuntimeScope === undefined;
    this.#officialRuntimeScope =
      options.officialRuntimeScope ??
      new OfficialRuntimeScope({
        diagnosticOutput: this.#options.diagnosticOutput,
        permanentHome,
        createBackend: () =>
          createOwnedConnectionBackend(() =>
            options.createOfficialConnection
              ? options.createOfficialConnection()
              : spawnOfficialAppServerConnection({
                  stockCodexPath: this.#options.stockCodexPath,
                  arguments: this.#options.arguments,
                  environment: {
                    ...officialEnvironment(environment),
                    CODEX_HOME: permanentHome,
                  },
                  ...(this.#options.spawnOfficial
                    ? { spawnOfficial: this.#options.spawnOfficial }
                    : {}),
                }),
          ),
      });
    this.#accountControl =
      options.accountControl ??
      new SingleNativeCodexAccount(() => ({
        version: 2,
        currentAccountId: "00000000-0000-4000-8000-000000000001",
        phase: this.#officialRuntimeScope.gate.phase,
        revision: this.#officialRuntimeScope.gate.revision,
        accounts: [
          {
            accountId: "00000000-0000-4000-8000-000000000001",
            label: "Native Codex Account",
          },
        ],
      }));
    this.#officialRuntime = new OfficialRuntimeClient({
      scope: this.#officialRuntimeScope,
      onBackendStopped: () => {
        this.#pendingOfficialTurnStarts.clear();
        this.#activeOfficialTurns.clear();
        this.#signalActiveWorkChanged();
      },
      output: async (output) =>
        this.#handleOfficialOutput({
          ...output,
          accountId: (await this.#currentCodexAccountId()) ?? "signed-out",
        }),
    });
    this.#nativeAccountObserver = this.#accountControl.refresh
      ? new NativeAccountObserver({
          control: this.#accountControl,
          scope: this.#officialRuntimeScope,
          notify: (method, params) => this.#writer.json({ method, params }),
          diagnose: () =>
            this.#diagnose("Codex Account identity or notification could not be updated"),
        })
      : undefined;
    this.#repository = new ExternalThreadRepository(
      options.mappingStore ??
        createProductionExternalThreadStore(this.#options.environment ?? process.env),
    );
    this.#externalAdapters = new Map(options.externalAdapters);
    for (const [harnessId, adapter] of this.#externalAdapters) {
      if (adapter.harnessId !== harnessId) {
        throw new Error(`External Adapter '${harnessId}' has mismatched Harness ID`);
      }
    }
    this.#desktopTools = new OfficialDesktopTools({
      scope: this.#officialRuntimeScope,
      cwd: this.#officialRuntimeScope.permanentHome,
      activeTurn: (threadId) => this.#externalRuntime.get(threadId)?.activeTurnId ?? null,
      diagnose: (error) => this.#diagnose(error),
      appConsent: (params, contextThreadId) => {
        if (!appConsentEnabled(this.#options.environment ?? process.env)) return false;
        const app = consentedApp(params, contextThreadId);
        if (app) this.#traceNativePicker({ event: "desktop-tools/app-consent", app });
        return app !== null;
      },
      elicit: (threadId, turnId, params) =>
        this.#forwardDesktopElicitation(threadId, turnId, params),
      trace: (event) => this.#traceNativePicker(event),
    });
    this.#externalRuntime = new ExternalThreadRuntime({
      clientTools: (threadId, cwd) => this.#desktopTools.forThread(threadId, cwd),
      adapters: this.#externalAdapters,
      environment: this.#options.environment ?? process.env,
      repository: this.#repository,
      consumeOutputs: (thread) => this.#consumeHarnessOutputs(thread),
      diagnose: (error) => this.#diagnose(error),
      subagentRunning: (threadId) => this.#subagentThreadStatuses.get(threadId) === "active",
      idleRelease: {
        queue: this.#desktopRequests,
        onClosed: async (thread) => {
          for (const pending of [...this.#pendingDesktopApprovals.values()]) {
            if (pending.thread === thread)
              await this.#resolveDesktopApproval(pending.interaction.interactionId);
          }
          for (const pending of [...this.#pendingDesktopQuestions.values()]) {
            if (pending.thread === thread)
              await this.#resolveDesktopQuestion(pending.interaction.interactionId);
          }
        },
        canRelease: (thread) =>
          !this.#hasRunningSubagents(thread.id) &&
          !this.#externalSteering.hasPending(thread.id) &&
          !this.#pendingExternalCommandRequests.has(thread.id) &&
          ![...this.#pendingDesktopApprovals.values()].some(
            (pending) => pending.thread === thread,
          ) &&
          ![...this.#pendingDesktopQuestions.values()].some((pending) => pending.thread === thread),
      },
    });
  }

  close(): void {
    if (this.#closeRequested) return;
    this.#closeRequested = true;
    this.#externalRuntime.idleRelease.disable();
    this.#pluginLoadAbort.abort();
    this.#externalSteering.close();
    this.#signalActiveWorkChanged();
    this.#options.desktopInput.destroy();
    // run() still awaits shutdown and propagates unconfirmed exit. This eager
    // close attempt must not create an independent unhandled rejection.
    void this.#closeOfficialRuntime().catch((error: unknown) => this.#diagnose(error));
  }

  async #closeOfficialRuntime(): Promise<void> {
    this.#desktopTools.close();
    this.#nativeAccountObserver?.close();
    if (this.#ownsOfficialRuntimeScope) await this.#officialRuntimeScope.close();
    await this.#officialRuntime.close();
  }

  disconnect(): void {
    if (this.#closeRequested || this.#desktopInputEnded || this.#drainActiveWorkOnInputEnd) return;
    this.#drainActiveWorkOnInputEnd = true;
    this.#externalSteering.close();
    const desktopInput = this.#options.desktopInput as Readable & { end?: () => void };
    if (typeof desktopInput.end === "function") desktopInput.end();
    else desktopInput.destroy();
  }

  #waitForPlugins(): Promise<void> {
    return (this.#pluginLoading ??= this.#loadInstalledPlugins().catch((error: unknown) => {
      this.#diagnose(`Harness plugin load failed: ${errorMessage(error)}`);
    }));
  }

  async #loadInstalledPlugins(): Promise<void> {
    if (!this.#options.pluginRoots || this.#pluginLoadAbort.signal.aborted) return;
    const plugins = await loadHarnessPlugins({
      roots: this.#options.pluginRoots,
      launchCommandForPlugin: (id) => this.#launchSettings.initialCommand(id),
      context: this.#options.pluginContext ?? {
        environment: this.#options.environment ?? process.env,
        platform: process.platform,
        managedRemoteHost: false,
      },
      reservedIds: new Set(this.#externalAdapters.keys()),
      signal: this.#pluginLoadAbort.signal,
      diagnose: (diagnostic) => this.#diagnose(`Harness plugin: ${JSON.stringify(diagnostic)}`),
    });
    if (this.#pluginLoadAbort.signal.aborted) {
      await plugins.close().catch((error: unknown) => this.#diagnose(error));
      return;
    }
    this.#pluginDescriptors = plugins.list();
    for (const [id, adapter] of plugins.adapters) this.#externalAdapters.set(id, adapter);
  }

  async run(): Promise<number> {
    try {
      await this.#repository.initialize();
    } catch (error) {
      this.#diagnose(`Host initialization failed: ${errorMessage(error)}`);
      this.#pluginLoadAbort.abort();
      await this.#pluginLoading;
      await Promise.allSettled(
        [...new Set(this.#externalAdapters.values())].map((adapter) =>
          Promise.resolve().then(() => adapter.close()),
        ),
      );
      if (this.#options.closeMappingStoreOnExit !== false) {
        await this.#repository.close().catch((closeError) => this.#diagnose(closeError));
      }
      await this.#closeOfficialRuntime();
      return this.#closeRequested ? 0 : 1;
    }
    try {
      await this.#officialRuntime.initialize();
    } catch (error) {
      this.#diagnose(`Official app-server connection failed: ${errorMessage(error)}`);
      // Keep the Desktop client attached for Host initialization and later recovery.
      if (this.#ownsOfficialRuntimeScope) {
        await this.#officialRuntimeScope.owner
          .stop()
          .catch((closeError: unknown) => this.#diagnose(closeError));
      }
    }
    // Keep the existing whole-registry loading policy, but do not hold up Desktop initialization.
    void this.#waitForPlugins();
    if (this.#closeRequested) await this.#closeOfficialRuntime();
    try {
      void this.#officialRuntime
        .failure()
        .then(async () => {
          // A recovered/shared Scope may have outlived this one-shot failure.
          if (this.#officialRuntimeScope.gate.phase !== "unavailable") return;
          // Prove exit without terminally closing the Scope or detaching Desktop.
          // Backend reconnection must be able to reuse this same native client.
          await this.#officialRuntimeScope.owner.stop();
        })
        .catch((error: unknown) => this.#diagnose(error));
      await this.#forwardDesktop();
      return 0;
    } catch (error) {
      if (!this.#closeRequested) this.#diagnose(error);
      this.#options.desktopInput.destroy();
      await this.#closeOfficialRuntime();
      return this.#closeRequested ? 0 : 1;
    } finally {
      this.#pluginLoadAbort.abort();
      // Stop replacement waiters before waiting for their tracked Host operations.
      this.#externalSteering.close();
      await this.#desktopRequests.drain();
      this.#externalRuntime.idleRelease.stop();
      await this.#externalRuntime.idleRelease.drain();
      await this.#pluginLoading;
      const threads = this.#externalRuntime.values();
      await Promise.allSettled(threads.map(({ session }) => session.close()));
      await Promise.allSettled(threads.map(({ outputTask }) => outputTask));
      await Promise.allSettled(
        [...new Set(this.#externalAdapters.values())].map((adapter) =>
          Promise.resolve().then(() => adapter.close()),
        ),
      );
      for (const pending of [...this.#pendingDesktopApprovals.values()]) {
        await this.#resolveDesktopApproval(pending.interaction.interactionId).catch(
          () => undefined,
        );
      }
      for (const pending of [...this.#pendingDesktopQuestions.values()]) {
        await this.#resolveDesktopQuestion(pending.interaction.interactionId).catch(
          () => undefined,
        );
      }
      await this.#closeOfficialRuntime();
      this.#externalRuntime.clear();
      this.#pendingOfficialTurnStarts.clear();
      this.#routeObservationTracker.clear();
      if (this.#options.closeMappingStoreOnExit !== false) {
        await this.#repository.close().catch((error) => this.#diagnose(error));
      }
    }
  }

  #hasActiveWork(): boolean {
    return (
      this.#externalSteering.hasPending() ||
      this.#pendingOfficialTurnStarts.size > 0 ||
      this.#activeOfficialTurns.size > 0 ||
      this.#runningSubagentsByParent.size > 0 ||
      this.#externalRuntime
        .values()
        .some((thread) => thread.running || thread.activeTurnId !== null)
    );
  }

  async #waitForActiveWorkToDrain(): Promise<void> {
    while (!this.#closeRequested && this.#hasActiveWork()) {
      await new Promise<void>((resolve) => this.#activeWorkDrainWaiters.add(resolve));
    }
  }

  #signalActiveWorkChanged(): void {
    if (!this.#closeRequested && this.#hasActiveWork()) return;
    const waiters = [...this.#activeWorkDrainWaiters];
    this.#activeWorkDrainWaiters.clear();
    for (const resolve of waiters) resolve();
  }

  #observeOfficialTurnStartResponse(value: JsonValue): void {
    if (!isRecord(value) || !("id" in value)) return;
    const threadId = this.#pendingOfficialTurnStarts.get(value.id);
    if (!threadId) return;
    this.#pendingOfficialTurnStarts.delete(value.id);
    const result = isRecord(value.result) ? value.result : null;
    const turn = result && isRecord(result.turn) ? result.turn : null;
    if (turn && typeof turn.id === "string") {
      this.#activeOfficialTurns.set(threadId, turn.id);
    }
    this.#signalActiveWorkChanged();
  }

  #forgetPendingOfficialTurnStarts(threadId: string): void {
    for (const [requestId, pendingThreadId] of this.#pendingOfficialTurnStarts) {
      if (pendingThreadId === threadId) this.#pendingOfficialTurnStarts.delete(requestId);
    }
  }

  async #forwardDesktop(): Promise<void> {
    for await (const frame of readLfFrames(this.#options.desktopInput)) {
      const parsed = parseJsonFrame(frame);
      if (isRecord(parsed) && parsed.method === "initialized" && !("id" in parsed)) {
        continue;
      }
      if (this.#handleDesktopElicitationResponse(parsed)) continue;
      if (await this.#handleDesktopApprovalResponse(parsed)) continue;
      if (await this.#handleDesktopQuestionResponse(parsed)) continue;
      const requestResult = jsonRpcRequestSchema.safeParse(parsed);
      if (!requestResult.success) {
        await this.#forwardOfficialNonRequest(parsed, frame).catch(() => {
          this.#diagnose("Official notification or server reply could not be delivered");
        });
        continue;
      }
      const request = requestResult.data;
      if (request.method === "initialize") {
        try {
          const nativeGeneration =
            this.#officialRuntimeScope.gate.phase === "ready"
              ? this.#officialRuntimeScope.owner.generation
              : undefined;
          const response = await this.#officialRuntime.initializeProtocol(requestObject(request));
          await this.#writer.json({ ...response, id: request.id });
          this.#nativeAccountObserver?.initialized(nativeGeneration);
        } catch (error) {
          await this.#writer.json(rpcError(request, -32087, errorMessage(error)));
        }
        continue;
      }
      const threadId =
        isRecord(request.params) && typeof request.params.threadId === "string"
          ? request.params.threadId
          : undefined;
      this.#dispatchDesktopRequest(() =>
        this.#desktopRequests.run(threadId, () =>
          this.#externalRuntime.idleRelease.runOperation(threadId, () =>
            this.#handleDesktopRequest(request, frame),
          ),
        ),
      );
    }
    this.#desktopInputEnded = true;
    this.#externalRuntime.idleRelease.disable();
    // Cancel loading before draining requests that may be waiting for it.
    this.#pluginLoadAbort.abort();
    await this.#desktopRequests.drain();
    this.#externalSteering.close();
    if (this.#drainActiveWorkOnInputEnd) await this.#waitForActiveWorkToDrain();
    await this.#closeOfficialRuntime();
  }

  async #handleDesktopRequest(
    request: JsonRpcRequest,
    frame: Buffer<ArrayBufferLike>,
  ): Promise<void> {
    if (this.#closeRequested) return;
    if (request.method === LOADED_SESSIONS_METHOD) {
      await this.#writer.json(
        rpcEnvelope(request, { result: this.#externalRuntime.idleRelease.list() }),
      );
      return;
    }
    if (request.method === IDLE_RELEASE_SETTINGS_METHOD) {
      const parsed = idleReleaseSettingsSchema.safeParse(request.params);
      if (!parsed.success) {
        await this.#writer.json(rpcError(request, -32602, "Invalid idle release settings"));
      } else {
        const settings = this.#externalRuntime.idleRelease.configure(parsed.data);
        await this.#writer.json(rpcEnvelope(request, { result: settings }));
      }
      return;
    }
    if (request.method === "codexhost/update/status") {
      // Protocol discriminator for the SSH remote Host probe: a managed Host answers
      // -32090 here, stock Codex rejects the method as an unknown variant.
      this.#dispatchDesktopRequest(async () => {
        await this.#writer.json(rpcError(request, -32090, "Application updates are unavailable"));
      });
      return;
    }
    if (request.method === "codexhost/account/usage/inspect") {
      this.#dispatchDesktopRequest(() => this.#handleCodexAccountRequest(request));
      return;
    }
    if (request.method === "codexhost/harness/accounts/sources") {
      this.#dispatchDesktopRequest(async () => {
        if (!harnessAccountSourceListParamsSchema.safeParse(request.params).success) {
          await this.#writer.json(
            rpcError(request, -32602, "Invalid Harness account source list params"),
          );
          return;
        }
        await this.#waitForPlugins();
        const result = listHarnessAccountSources(
          this.#externalAdapters.values(),
          this.#pluginDescriptors,
        );
        await this.#writer.json(rpcEnvelope(request, { result: jsonValueSchema.parse(result) }));
      });
      return;
    }
    if (request.method === "codexhost/harness/accounts/inspect") {
      this.#dispatchDesktopRequest(async () => {
        const params = harnessAccountInspectParamsSchema.safeParse(request.params);
        if (!params.success) {
          await this.#writer.json(
            rpcError(request, -32602, "Invalid Harness account inspection params"),
          );
          return;
        }
        await this.#waitForPlugins();
        const adapter = this.#externalAdapters.get(params.data.harnessId);
        if (!adapter) {
          await this.#writer.json(
            rpcError(request, -32077, `Harness '${params.data.harnessId}' is unavailable`),
          );
          return;
        }
        const result = harnessAccountInspectResultSchema.parse(
          await this.#inspectHarnessAccount(adapter, params.data.refresh === true),
        );
        await this.#writer.json(rpcEnvelope(request, { result: jsonValueSchema.parse(result) }));
      });
      return;
    }
    if (request.method === "codexhost/harness/accounts/list") {
      this.#dispatchDesktopRequest(async () => {
        const params = harnessAccountListParamsSchema.safeParse(request.params);
        if (!params.success) {
          await this.#writer.json(rpcError(request, -32602, "Invalid Harness account list params"));
          return;
        }
        await this.#waitForPlugins();
        const inspections = await Promise.all(
          [...this.#externalAdapters.values()].map((adapter) =>
            this.#inspectHarnessAccount(adapter, params.data.refresh === true),
          ),
        );
        const result = harnessAccountListResultSchema.parse({
          accounts: inspections.flatMap(({ harnessId, harnessName, account }) =>
            account ? [{ ...account, harnessId, harnessName }] : [],
          ),
        });
        await this.#writer.json(rpcEnvelope(request, { result: jsonValueSchema.parse(result) }));
      });
      return;
    }
    if (
      request.method === HARNESS_LAUNCH_SETTINGS_GET_METHOD ||
      request.method === HARNESS_LAUNCH_SETTINGS_SET_METHOD
    ) {
      this.#dispatchDesktopRequest(async () => {
        const schema =
          request.method === HARNESS_LAUNCH_SETTINGS_SET_METHOD
            ? harnessLaunchSettingsSetSchema
            : harnessLaunchSettingsGetSchema;
        const params = schema.safeParse(request.params);
        if (!params.success) {
          await this.#writer.json(rpcError(request, -32602, "Invalid Harness launch settings"));
          return;
        }
        await this.#waitForPlugins();
        if (
          !this.#pluginDescriptors.some(
            (plugin) => plugin.id === params.data.harnessId && plugin.launchCommand,
          )
        ) {
          await this.#writer.json(
            rpcError(request, -32602, "Harness launch settings are unavailable"),
          );
          return;
        }
        try {
          const result =
            request.method === HARNESS_LAUNCH_SETTINGS_SET_METHOD
              ? await this.#launchSettings.set(
                  params.data.harnessId,
                  harnessLaunchSettingsSetSchema.parse(request.params).path,
                )
              : await this.#launchSettings.get(params.data.harnessId);
          await this.#writer.json(rpcEnvelope(request, { result: jsonValueSchema.parse(result) }));
        } catch {
          await this.#writer.json(
            rpcError(
              request,
              -32602,
              "Could not read or save launch settings. Use an existing absolute installation directory on this Host, without arguments, and check configuration permissions.",
            ),
          );
        }
      });
      return;
    }
    if (request.method === "codexhost/thread/usage/inspect") {
      await this.#inspectThreadUsage(request);
      return;
    }
    // Reads wait for the official runtime without holding Desktop request draining open.
    if (request.method === "model/list") {
      void this.#listNativeModels(request).catch((error: unknown) => this.#diagnose(error));
      return;
    }
    if (request.method === "config/read") {
      void this.#readNativeConfig(request).catch((error: unknown) => this.#diagnose(error));
      return;
    }
    if (request.method === "config/batchWrite" || request.method === "config/value/write") {
      if (await this.#writeNativeConfig(request)) return;
    }
    if (request.method === "thread/inject_items") {
      if (await this.#injectExternalThreadItems(request)) return;
    }
    if (request.method === "thread/settings/update") {
      if (await this.#updateNativeThreadSettings(request)) return;
    }
    if (request.method === "thread/list") {
      let listRequest: DecodedThreadListRequest;
      try {
        const decoded = decodeThreadListRequest(request);
        if (!decoded) throw new Error("Expected thread/list request");
        listRequest = decoded;
      } catch (error) {
        await this.#writer.json(rpcError(request, -32602, errorMessage(error)));
        return;
      }
      if (!listRequest.supportsExternal) {
        await this.#forwardOfficialRequest(request, frame);
        return;
      }
      this.#dispatchDesktopRequest(() => this.#listThreads(request, listRequest));
      return;
    }
    if (request.method === "thread/archive" || request.method === "thread/unarchive") {
      let threadId: string;
      try {
        const decoded = decodeThreadArchiveRequest(request);
        if (!decoded) throw new Error(`Expected ${request.method} request`);
        threadId = decoded.threadId;
      } catch (error) {
        await this.#writer.json(rpcError(request, -32602, errorMessage(error)));
        return;
      }
      const location = await this.#locateExternalThread(threadId);
      if (await this.#writeResolutionError(request, location)) return;
      if (location.kind === "official") {
        await this.#forwardOfficialRequest(request, frame);
        return;
      }
      if (location.kind === "external") {
        await this.#setExternalThreadArchived(
          request,
          location,
          request.method === "thread/archive",
        );
      }
      return;
    }
    if (request.method === "thread/metadata/update") {
      let threadId: string;
      try {
        const decoded = decodeThreadMetadataUpdateRequest(request);
        if (!decoded) throw new Error("Expected thread/metadata/update request");
        threadId = decoded.threadId;
      } catch (error) {
        await this.#writer.json(rpcError(request, -32602, errorMessage(error)));
        return;
      }
      const location = await this.#locateExternalThread(threadId);
      if (await this.#writeResolutionError(request, location)) return;
      if (location.kind === "official") {
        await this.#forwardOfficialRequest(request, frame);
        return;
      }
      await this.#writer.json(
        rpcError(request, -32078, "External Thread metadata updates are unsupported"),
      );
      return;
    }
    let createRoute: CreateRequestRouteObservation | null;
    try {
      createRoute = classifyCreateRequestRoute(request);
    } catch (error) {
      await this.#writer.json(rpcError(request, -32602, errorMessage(error)));
      return;
    }
    if (createRoute) {
      this.#options.onCreateRequestRoute?.(createRoute);
      this.#options.onRequestRoute?.(
        this.#routeObservationTracker.registerCreate(
          request.id,
          createRoute,
          classifyThreadPurpose(request),
        ),
      );
    }
    if (createRoute && createRoute.selectedHarness !== "codex") {
      await this.#startExternalThread(request, createRoute.selectedHarness);
      return;
    }
    if (request.method === "thread/fork") {
      const params = isRecord(request.params) ? request.params : {};
      const resolution =
        typeof params.threadId === "string"
          ? await this.#resolveExternalThread(params.threadId)
          : ({ kind: "official" } as const);
      if (resolution.kind === "error") {
        await this.#writer.json(rpcError(request, resolution.error.code, resolution.error.message));
        return;
      }
      if (resolution.kind === "external") {
        let fork: DecodedThreadForkRequest;
        try {
          const decoded = decodeThreadForkRequest(request);
          if (!decoded) throw new Error("Expected thread/fork request");
          fork = decoded;
        } catch (error) {
          await this.#writer.json(rpcError(request, -32602, errorMessage(error)));
          return;
        }
        await this.#forkExternalThread(request, resolution.thread, fork);
        return;
      }
    }
    if (request.method === "thread/revert") {
      const params = isRecord(request.params) ? request.params : {};
      const resolution =
        typeof params.threadId === "string"
          ? await this.#resolveExternalThread(params.threadId)
          : ({ kind: "official" } as const);
      if (resolution.kind === "error") {
        await this.#writer.json(rpcError(request, resolution.error.code, resolution.error.message));
        return;
      }
      if (resolution.kind === "external") {
        let revert: DecodedThreadRevertRequest;
        try {
          const decoded = decodeThreadRevertRequest(request);
          if (!decoded) throw new Error("Expected thread/revert request");
          revert = decoded;
        } catch (error) {
          await this.#writer.json(rpcError(request, -32602, errorMessage(error)));
          return;
        }
        await this.#revertExternalThread(request, resolution.thread, revert);
        return;
      }
    }
    if (request.method === "thread/rollback") {
      const params = isRecord(request.params) ? request.params : {};
      const resolution =
        typeof params.threadId === "string"
          ? await this.#resolveExternalThread(params.threadId)
          : ({ kind: "official" } as const);
      if (resolution.kind === "error") {
        await this.#writer.json(rpcError(request, resolution.error.code, resolution.error.message));
        return;
      }
      if (resolution.kind === "external") {
        let rollback: DecodedThreadRollbackRequest;
        try {
          const decoded = decodeThreadRollbackRequest(request);
          if (!decoded) throw new Error("Expected thread/rollback request");
          rollback = decoded;
        } catch (error) {
          await this.#writer.json(rpcError(request, -32602, errorMessage(error)));
          return;
        }
        await this.#rollbackExternalThread(request, resolution.thread, rollback);
        return;
      }
    }
    if (request.method === "thread/turns/list" || request.method === "thread/items/list") {
      const params = requestObject(request);
      const resolution =
        typeof params.threadId === "string"
          ? await this.#resolveExternalThread(params.threadId)
          : ({ kind: "official" } as const);
      if (await this.#writeResolutionError(request, resolution)) return;
      if (resolution.kind === "external") {
        await this.#listExternalHistory(
          request,
          resolution.thread,
          params,
          resolution.historyFresh,
        );
        return;
      }
    }
    if (request.method === "turn/start") {
      const params = requestObject(request);
      const threadId = params.threadId;
      const resolution =
        typeof threadId === "string"
          ? await this.#resolveExternalThread(threadId)
          : ({ kind: "official" } as const);
      if (typeof threadId === "string") {
        this.#options.onRequestRoute?.(
          this.#routeObservationTracker.observeTurn(
            threadId,
            resolution.kind === "external" ? resolution.thread.harnessId : "codex",
          ),
        );
      }
      if (await this.#writeResolutionError(request, resolution)) return;
      if (resolution.kind === "external") {
        this.#dispatchDesktopRequest(
          () => this.#startExternalTurn(request, resolution.thread),
          resolution.thread.id,
        );
        return;
      }
      if (isNativeRouteModel(requestedNativeSelection(params).model)) {
        await this.#writer.json(rpcError(request, -32076, CROSS_HARNESS_MESSAGE));
        return;
      }
      if (typeof threadId === "string") {
        this.#pendingOfficialTurnStarts.set(request.id, threadId);
      }
    }
    if (request.method === "turn/steer") {
      const params = requestObject(request);
      const resolution =
        typeof params.threadId === "string"
          ? await this.#resolveExternalThread(params.threadId)
          : ({ kind: "official" } as const);
      if (await this.#writeResolutionError(request, resolution)) return;
      if (resolution.kind === "external") {
        this.#dispatchDesktopRequest(
          () => this.#steerExternalTurn(request, resolution.thread),
          resolution.thread.id,
        );
        return;
      }
    }
    if (request.method === "turn/interrupt") {
      const params = requestObject(request);
      const resolution =
        typeof params.threadId === "string"
          ? await this.#resolveExternalThread(params.threadId)
          : ({ kind: "official" } as const);
      if (await this.#writeResolutionError(request, resolution)) return;
      if (resolution.kind === "external") {
        await this.#interruptExternalTurn(request, resolution.thread, params.turnId);
        return;
      }
    }
    if (request.method === "thread/read") {
      const params = requestObject(request);
      const location =
        typeof params.threadId === "string"
          ? await this.#locateExternalThread(params.threadId)
          : ({ kind: "official" } as const);
      if (location.kind === "error") {
        await this.#writer.json(rpcError(request, location.error.code, location.error.message));
        return;
      }
      if (location.kind === "official") {
        await this.#forwardOfficialRequest(request, frame);
        return;
      }
      if (params.includeTurns !== true) {
        await this.#readExternalThreadMetadata(request, location);
        return;
      }
      if (location.record.historyMode === "paginated") {
        await this.#writer.json(
          rpcError(request, -32602, "Paginated External Threads require thread/turns/list"),
        );
        return;
      }
    }
    if (request.method === "thread/read" || request.method === "thread/resume") {
      const params = requestObject(request);
      const resolution =
        typeof params.threadId === "string"
          ? await this.#resolveExternalThread(params.threadId)
          : ({ kind: "official" } as const);
      if (await this.#writeResolutionError(request, resolution)) return;
      if (resolution.kind === "external") {
        if (request.method === "thread/read") {
          await this.#readExternalThread(
            request,
            resolution.thread,
            params.includeTurns === true,
            resolution.historyFresh,
          );
        } else {
          await this.#resumeExternalThread(
            request,
            resolution.thread,
            params,
            resolution.historyFresh,
          );
        }
        return;
      }
    }
    if (request.method === "thread/unsubscribe") {
      const params = requestObject(request);
      if (typeof params.threadId === "string") {
        const location = await this.#locateExternalThread(params.threadId);
        if (await this.#writeResolutionError(request, location)) return;
        if (location.kind === "official") {
          await this.#forwardOfficialRequest(request, frame);
          return;
        }
        if (location.kind === "external") {
          await this.#writer.json(
            rpcEnvelope(request, {
              result: { status: location.thread ? "notSubscribed" : "notLoaded" },
            }),
          );
          return;
        }
      }
    }
    if (request.method === "thread/name/set" || request.method === "thread/delete") {
      const params = requestObject(request);
      const location =
        typeof params.threadId === "string"
          ? await this.#locateExternalThread(params.threadId)
          : ({ kind: "official" } as const);
      if (await this.#writeResolutionError(request, location)) return;
      if (location.kind === "external") {
        if (request.method === "thread/name/set") {
          await this.#setExternalThreadName(request, location, params.name);
        } else {
          await this.#deleteExternalThread(request, location);
        }
        return;
      }
    }
    if (
      request.method.startsWith("thread/") &&
      !EXPLICIT_EXTERNAL_THREAD_METHODS.has(request.method) &&
      isRecord(request.params) &&
      typeof request.params.threadId === "string"
    ) {
      const location = await this.#locateExternalThread(request.params.threadId);
      if (await this.#writeResolutionError(request, location)) return;
      if (location.kind === "external") {
        await this.#writer.json(
          rpcError(request, -32076, `External Thread does not support ${request.method}`),
        );
        return;
      }
    }
    await this.#forwardOfficialRequest(request, frame);
  }

  /** Sanitized acceptance trace of native picker decisions. Never records prompts or replies. */
  #traceNativePicker(event: JsonObject): void {
    const environment = this.#options.environment ?? process.env;
    const enabled =
      environment.CODEXHOST_NATIVE_PICKER_TRACE === "1" ||
      environment.CODEXHOST_STARTUP_TRACE === "1";
    if (!enabled || !environment.CODEXHOST_DATA_DIR) return;
    try {
      appendFileSync(
        path.join(path.resolve(environment.CODEXHOST_DATA_DIR), "native-picker-trace.jsonl"),
        `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`,
        { mode: 0o600 },
      );
    } catch {
      // Tracing is diagnostic only.
    }
  }

  /** Official `model/list` plus one entry per Model of every ready external Harness. */
  async #listNativeModels(request: JsonRpcRequest): Promise<void> {
    const params = isRecord(request.params) ? request.params : {};
    let response: JsonObject;
    try {
      response = await this.#requestOfficial("model/list", params);
    } catch {
      await this.#writer.json(
        rpcError(request, -32001, "Official request failed; retry explicitly"),
      );
      return;
    }
    const result = isRecord(response.result) ? response.result : undefined;
    // Only the last page is extended so paginated reads list each projected Model once.
    if (!result || !Array.isArray(result.data) || result.nextCursor != null) {
      await this.#writer.json({ ...response, id: request.id });
      return;
    }
    const projected: JsonObject[] = [];
    try {
      // Desktop startup must not depend on Harness loading: wait a bounded time, then answer
      // with the Harnesses that are ready. Desktop refetches the list on focus and expiry.
      const configuredWait = Number(this.#options.environment?.CODEXHOST_NATIVE_MODEL_WAIT_MS);
      const waitMs =
        Number.isFinite(configuredWait) && configuredWait >= 0 ? configuredWait : 5_000;
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        this.#waitForPlugins(),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, waitMs);
        }),
      ]);
      clearTimeout(timer);
      for (const [harnessId, adapter] of this.#externalAdapters) {
        const inspection = harnessInspectionSchema.safeParse(await adapter.inspect({}));
        if (!inspection.success || inspection.data.status !== "ready") continue;
        const name =
          this.#pluginDescriptors.find((plugin) => plugin.id === harnessId)?.name ?? harnessId;
        projected.push(
          ...projectNativeModels({
            harnessName: name,
            catalog: inspection.data.catalog,
            routeId: (model) => encodeExternalTransportSelection(harnessId, { model: model.ref }),
          }),
        );
      }
    } catch (error) {
      this.#diagnose(error);
    }
    await this.#writer.json({
      ...response,
      id: request.id,
      result: { ...result, data: [...result.data, ...projected] },
    });
  }

  async #readNativeConfig(request: JsonRpcRequest): Promise<void> {
    let response: JsonObject;
    try {
      response = await this.#requestOfficial(
        "config/read",
        isRecord(request.params) ? request.params : {},
      );
    } catch {
      await this.#writer.json(
        rpcError(request, -32001, "Official request failed; retry explicitly"),
      );
      return;
    }
    const selection = await this.#nativeSelection.get();
    await this.#writer.json({
      ...response,
      id: request.id,
      ...(isRecord(response.result)
        ? { result: overlayNativeSelection(response.result, selection) }
        : {}),
    });
  }

  /**
   * Keep native route ids out of the official config file. Returns false when the request is
   * untouched and must be forwarded as the original frame.
   */
  async #writeNativeConfig(request: JsonRpcRequest): Promise<boolean> {
    const params = isRecord(request.params) ? request.params : {};
    const batch = request.method === "config/batchWrite";
    const edits: JsonValue[] = batch
      ? Array.isArray(params.edits)
        ? params.edits
        : []
      : [{ keyPath: params.keyPath ?? null, value: params.value ?? null }];
    const current = await this.#nativeSelection.get();
    const plan = planConfigEdits(edits, current);
    if (plan.selection === undefined) return false;
    if (plan.selection === null) {
      await this.#nativeSelection.set(null);
      return false;
    }
    await this.#nativeSelection.set(plan.selection);
    let response: JsonObject | undefined;
    if (batch && plan.official.length > 0) {
      try {
        response = await this.#requestOfficial("config/batchWrite", {
          ...params,
          edits: plan.official,
        });
      } catch {
        await this.#writer.json(
          rpcError(request, -32001, "Official request failed; retry explicitly"),
        );
        return true;
      }
    }
    if (response) {
      await this.#writer.json({ ...response, id: request.id });
      return true;
    }
    // Nothing was written officially: report the unchanged official file and its real version.
    const layers = await this.#requestOfficial("config/read", { includeLayers: true }).catch(
      () => undefined,
    );
    const userLayer =
      isRecord(layers?.result) && Array.isArray(layers.result.layers)
        ? layers.result.layers.find(
            (layer) => isRecord(layer) && isRecord(layer.name) && layer.name.type === "user",
          )
        : undefined;
    const layerName = isRecord(userLayer) && isRecord(userLayer.name) ? userLayer.name : undefined;
    await this.#writer.json(
      rpcEnvelope(request, {
        result: {
          status: "ok",
          version:
            isRecord(userLayer) && typeof userLayer.version === "string" ? userLayer.version : "",
          filePath:
            typeof params.filePath === "string"
              ? params.filePath
              : typeof layerName?.file === "string"
                ? layerName.file
                : "",
          overriddenMetadata: null,
        },
      }),
    );
    return true;
  }

  /**
   * A Thread never changes Harness. Same-Harness Model and effort changes are applied to the
   * external Session; cross-Harness changes are rejected in both directions.
   */
  async #updateNativeThreadSettings(request: JsonRpcRequest): Promise<boolean> {
    const params = requestObject(request);
    if (typeof params.threadId !== "string") return false;
    const selection = requestedNativeSelection(params);
    const resolution = await this.#resolveExternalThread(params.threadId);
    if (await this.#writeResolutionError(request, resolution)) return true;
    if (resolution.kind !== "external") {
      if (!isNativeRouteModel(selection.model)) return false;
      this.#traceNativePicker({
        event: "cross-harness-rejected",
        threadHarnessId: "codex",
        requestedModelIsRoute: true,
        method: request.method,
      });
      await this.#writer.json(rpcError(request, -32076, CROSS_HARNESS_MESSAGE));
      return true;
    }
    const failure =
      (await this.#applyNativeSelection(resolution.thread, selection)) ??
      (await this.#applyNativePermission(resolution.thread, params, "level-and-plan"));
    this.#traceNativePicker({
      event: "thread/settings/update",
      harnessId: resolution.thread.harnessId,
      model: selection.model ?? null,
      nativeEffort: selection.effort ?? null,
      keys: Object.keys(params).sort(),
      permission: requestedNativePermission(params),
      outcome: failure ? `${failure.code}: ${failure.message}` : "ok",
    });
    await this.#writer.json(
      failure
        ? rpcError(request, failure.code, failure.message)
        : rpcEnvelope(request, { result: {} }),
    );
    return true;
  }

  /** Apply a native Model/effort selection to an external Session. Returns an error to report. */
  async #applyNativeSelection(
    thread: ExternalThread,
    selection: { model?: string; effort?: string },
    officialModel: "reject" | "ignore" = "reject",
  ): Promise<{ code: number; message: string } | undefined> {
    // A Turn that still carries an official Model (restored drafts, official App Tools) keeps
    // running on the Thread's Harness. Explicit settings updates are rejected instead.
    const ignoreModel =
      officialModel === "ignore" &&
      selection.model !== undefined &&
      !isNativeRouteModel(selection.model);
    if (selection.model !== undefined && !ignoreModel) {
      let route: ReturnType<typeof decodeCreateRoute>;
      try {
        route = decodeCreateRoute({
          id: 0,
          method: "thread/start",
          params: { model: selection.model },
        });
      } catch (error) {
        return { code: -32602, message: errorMessage(error) };
      }
      if (!route || route.harnessId !== thread.harnessId) {
        this.#traceNativePicker({
          event: "cross-harness-rejected",
          threadHarnessId: thread.harnessId,
          requestedHarnessId: route?.harnessId ?? null,
        });
        return { code: -32076, message: CROSS_HARNESS_MESSAGE };
      }
      const current =
        thread.requestedModel ??
        decodeExternalTransportSelection(thread.harnessId, thread.transportModelId)?.model;
      if (
        route.model &&
        route.model.id !== current?.id &&
        thread.session.capabilities.configuration.selectModel
      ) {
        const result = await thread.session.execute({ type: "model.select", model: route.model });
        if (!result.ok) return { code: -32078, message: result.error.message };
        this.#traceNativePicker({
          event: "model.select",
          harnessId: thread.harnessId,
          model: route.model.id,
        });
        thread.requestedModel = route.model;
        await this.#persistNativeSelection(thread);
      }
    }
    if (
      selection.effort !== undefined &&
      thread.session.capabilities.configuration.selectThinkingOption
    ) {
      const adapter = this.#externalAdapters.get(thread.harnessId);
      const inspection = adapter
        ? harnessInspectionSchema.safeParse(await adapter.inspect({}).catch(() => undefined))
        : undefined;
      const thinkingOptionId =
        inspection?.success && inspection.data.status === "ready"
          ? thinkingOptionForEffort(selection.effort, inspection.data.catalog)
          : undefined;
      if (thinkingOptionId && thinkingOptionId !== thread.requestedThinkingOptionId) {
        const beforeRevision = thread.stateObserver.revision;
        const result = await thread.session.execute({ type: "thinking.select", thinkingOptionId });
        if (!result.ok) return { code: -32078, message: result.error.message };
        const confirmed = await Promise.race([
          thread.stateObserver.waitForChange(beforeRevision).catch(() => undefined),
          new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 3_000)),
        ]);
        this.#traceNativePicker({
          event: "thinking.select",
          harnessId: thread.harnessId,
          nativeEffort: selection.effort,
          thinkingOptionId,
          sessionThinkingOptionId: confirmed?.effectiveThinkingOptionId ?? null,
        });
        thread.requestedThinkingOptionId = thinkingOptionId;
        await this.#persistNativeSelection(thread);
      }
    }
    return undefined;
  }

  /** Permission fields for a Thread response; empty until the Thread's level is known. */
  #nativePermissionFields(thread: ExternalThread): {
    approvalPolicy?: JsonValue;
    approvalsReviewer?: string;
    activePermissionProfile?: JsonObject;
    sandbox?: JsonObject;
  } {
    return thread.nativePermissionLevel
      ? nativePermissionResponse(thread.nativePermissionLevel, thread.nativeApprovalPolicy)
      : {};
  }

  /**
   * The Desktop sends side chat context with `thread/inject_items`. An external Thread has no
   * official rollout to inject into, so the text waits for the Thread's next Turn.
   */
  async #injectExternalThreadItems(request: JsonRpcRequest): Promise<boolean> {
    const params = requestObject(request);
    if (typeof params.threadId !== "string") return false;
    const resolution = await this.#resolveExternalThread(params.threadId);
    if (resolution.kind !== "external") return false;
    const text = injectedItemsText(params);
    (resolution.thread.pendingInjectedContext ??= []).push(...text);
    this.#traceNativePicker({
      event: "thread/inject_items",
      harnessId: resolution.thread.harnessId,
      items: text.length,
    });
    await this.#writer.json(rpcEnvelope(request, { result: {} }));
    return true;
  }

  /**
   * A fork opens a fresh Harness Session with default settings. Carry over the source Thread's
   * Model, Thinking option and Permission Mode; the fork request may override the level.
   */
  async #inheritNativeSettings(
    source: ExternalThread,
    derived: ExternalThread,
    params: JsonObject,
  ): Promise<void> {
    const selection = decodeExternalTransportSelection(source.harnessId, source.transportModelId);
    const capabilities = derived.session.capabilities.configuration;
    const applied: JsonObject = {};
    try {
      const model = source.requestedModel ?? selection?.model;
      if (model && capabilities.selectModel) {
        const result = await derived.session.execute({ type: "model.select", model });
        if (result.ok) derived.requestedModel = model;
        applied.model = result.ok ? model.id : "failed";
      }
      const thinkingOptionId = source.requestedThinkingOptionId ?? selection?.thinkingOptionId;
      if (thinkingOptionId && capabilities.selectThinkingOption) {
        const result = await derived.session.execute({ type: "thinking.select", thinkingOptionId });
        if (result.ok) derived.requestedThinkingOptionId = thinkingOptionId;
        applied.thinkingOptionId = result.ok ? thinkingOptionId : "failed";
      }
      const level = nativePermissionLevel(params) ?? source.nativePermissionLevel;
      if (level) derived.nativePermissionLevel = level;
      const approvalPolicy = params.approvalPolicy ?? source.nativeApprovalPolicy;
      if (approvalPolicy !== undefined) derived.nativeApprovalPolicy = approvalPolicy;
      const offered = await this.#offeredPermissionModes(derived.harnessId);
      const wanted =
        nativePermissionLevel(params) !== undefined && level
          ? permissionModeForLevel(level, offered)
          : (source.requestedPermissionModeId ??
            (level ? permissionModeForLevel(level, offered) : undefined));
      const permissionModeId = harnessPermissionModeIdSchema.safeParse(wanted);
      if (permissionModeId.success && capabilities.selectPermissionMode) {
        const result = await derived.session.execute({
          type: "permissionMode.select",
          permissionModeId: permissionModeId.data,
        });
        if (result.ok) derived.requestedPermissionModeId = permissionModeId.data;
        applied.permissionModeId = result.ok ? permissionModeId.data : "failed";
      }
      await this.#persistNativeSelection(derived);
    } catch (error) {
      this.#diagnose(error);
    }
    this.#traceNativePicker({
      event: "thread/fork",
      harnessId: derived.harnessId,
      nativeLevel: derived.nativePermissionLevel ?? null,
      permission: requestedNativePermission(params),
      applied,
    });
  }

  async #offeredPermissionModes(harnessId: ExternalHarnessId): Promise<string[]> {
    const adapter = this.#externalAdapters.get(harnessId);
    const inspection = adapter
      ? harnessInspectionSchema.safeParse(await adapter.inspect({}).catch(() => undefined))
      : undefined;
    return inspection?.success && inspection.data.status === "ready"
      ? (inspection.data.permissionModes?.modes.map(({ id }) => id as string) ?? [])
      : [];
  }

  /**
   * Follow the official permission selector and Plan toggle with the Harness Permission Mode.
   * Plan wins while it is on; turning it off restores the Thread's selected level.
   */
  async #applyNativePermission(
    thread: ExternalThread,
    params: JsonObject,
    scope: "level-and-plan" | "plan-only",
  ): Promise<{ code: number; message: string } | undefined> {
    if (!thread.session.capabilities.configuration.selectPermissionMode) return undefined;
    const level = scope === "level-and-plan" ? nativePermissionLevel(params) : undefined;
    const plan = nativePlanMode(params);
    if (level) {
      thread.nativePermissionLevel = level;
      if (params.approvalPolicy !== undefined) thread.nativeApprovalPolicy = params.approvalPolicy;
    }
    const inPlan = thread.requestedPermissionModeId === "plan";
    if (level === undefined && (plan === undefined || plan === inPlan)) return undefined;
    const offered = await this.#offeredPermissionModes(thread.harnessId);
    const wanted =
      (plan ?? inPlan) && offered.includes("plan")
        ? "plan"
        : permissionModeForLevel(thread.nativePermissionLevel ?? "ask", offered);
    const parsed = harnessPermissionModeIdSchema.safeParse(wanted);
    if (!parsed.success || parsed.data === thread.requestedPermissionModeId) return undefined;
    const result = await thread.session.execute({
      type: "permissionMode.select",
      permissionModeId: parsed.data,
    });
    this.#traceNativePicker({
      event: "permissionMode.select",
      harnessId: thread.harnessId,
      nativeLevel: thread.nativePermissionLevel ?? null,
      plan: plan ?? null,
      permissionModeId: parsed.data,
      outcome: result.ok ? "ok" : result.error.message,
    });
    if (!result.ok) return { code: -32078, message: result.error.message };
    thread.requestedPermissionModeId = parsed.data;
    await this.#persistNativeSelection(thread);
    return undefined;
  }

  /**
   * Model and effort reported for an external Thread. The Model must equal a `model/list` entry
   * id, otherwise the official picker labels a reopened Thread as a custom Model.
   */
  #nativeThreadSelection(input: {
    harnessId: ExternalHarnessId;
    transportModelId: string;
    requestedModel?: HarnessModelRef | undefined;
    requestedThinkingOptionId?: HarnessThinkingOptionId | undefined;
  }): { model: string; reasoningEffort: string } {
    const decoded = decodeExternalTransportSelection(input.harnessId, input.transportModelId);
    const model = input.requestedModel ?? decoded?.model;
    return {
      model: model
        ? encodeExternalTransportSelection(input.harnessId, { model })
        : input.transportModelId,
      reasoningEffort: effortForThinkingOption(
        input.requestedThinkingOptionId ?? decoded?.thinkingOptionId,
      ),
    };
  }

  async #persistNativeSelection(thread: ExternalThread): Promise<void> {
    const previous = decodeExternalTransportSelection(thread.harnessId, thread.transportModelId);
    const model = thread.requestedModel ?? previous?.model;
    if (!model) return;
    const transportModelId = encodeExternalTransportSelection(thread.harnessId, {
      ...(previous ?? {}),
      model,
      ...(thread.requestedThinkingOptionId
        ? { thinkingOptionId: thread.requestedThinkingOptionId }
        : {}),
      ...(thread.requestedPermissionModeId
        ? { permissionModeId: thread.requestedPermissionModeId }
        : {}),
    });
    thread.transportModelId = transportModelId;
    try {
      thread.record = await this.#repository.setTransportModelId(
        thread.record.hostThreadId,
        transportModelId,
      );
    } catch (error) {
      this.#diagnose(error);
    }
  }

  async #forwardOfficialNonRequest(
    value: JsonValue,
    frame: Buffer<ArrayBufferLike>,
  ): Promise<void> {
    const response = isRecord(value) ? value : null;
    const request =
      response && (typeof response.id === "string" || typeof response.id === "number")
        ? this.#officialServerRequests.get(response.id)
        : null;
    if (request !== undefined && response) {
      this.#officialServerRequests.delete(response.id as JsonRpcId);
      await this.#officialRuntime.send({
        ...response,
        id: request,
      });
      return;
    }
    await this.#officialRuntime.sendFrame(frame);
  }

  async #forwardOfficialRequest(
    request: JsonRpcRequest,
    frame: Buffer<ArrayBufferLike>,
  ): Promise<void> {
    try {
      await this.#officialRuntime.sendFrame(frame);
    } catch {
      if (request.method === "turn/start") {
        this.#pendingOfficialTurnStarts.delete(request.id);
        this.#signalActiveWorkChanged();
      }
      await this.#writer.json(
        rpcError(request, -32001, "Official request failed; retry explicitly"),
      );
    }
  }

  async #handleOfficialOutput(input: {
    accountId: string;
    frame: Buffer<ArrayBufferLike>;
    value: JsonValue;
  }): Promise<void> {
    const parsed = input.value;
    this.#observeOfficialTurnStartResponse(parsed);
    let forwarded: JsonValue = parsed;
    if (isRecord(parsed) && typeof parsed.method === "string" && "id" in parsed) {
      const originalId = parsed.id;
      if (typeof originalId === "string" || typeof originalId === "number") {
        const forwardedId = `codexhost:official:${++this.#nextOfficialServerRequestId}`;
        this.#officialServerRequests.set(forwardedId, originalId);
        forwarded = { ...parsed, id: forwardedId };
      }
    }
    const accountScopedNotification =
      isRecord(parsed) &&
      typeof parsed.method === "string" &&
      (parsed.method === "account/updated" || parsed.method.startsWith("account/rateLimits/"));
    if (accountScopedNotification) {
      if (parsed.method === "account/updated") this.#officialRateLimits.reset(input.accountId);
    }
    const tokenUsage = observeCodexTokenUsage(parsed);
    if (tokenUsage) {
      const previous = this.#officialUsageByThread.get(tokenUsage.threadId);
      try {
        this.#officialUsageByThread.set(
          tokenUsage.threadId,
          parseHostUsage({ ...(previous ?? {}), ...tokenUsage.usage }),
        );
      } catch {
        // Ignore an invalid native observation while preserving the official frame.
      }
    }
    const rateLimits = observeCodexRateLimits(parsed);
    if (rateLimits) this.#officialRateLimits.observe(input.accountId, rateLimits);
    // Owner already rejects retired generations.
    try {
      await this.#observeOfficialTurnLifecycle(parsed);
    } catch (error) {
      this.#diagnose(error);
    }
    this.#routeObservationTracker.bindOfficialResponse(parsed);
    if (forwarded === parsed) await this.#writer.frame(input.frame);
    else await this.#writer.json(forwarded);
    this.#nativeAccountObserver?.observe(parsed);
  }

  async #requestOfficial(method: string, params: JsonObject): Promise<JsonObject> {
    return this.#officialRuntime.request(method, params);
  }

  #inspectHarnessAccount(
    adapter: HarnessAdapter,
    refresh = false,
  ): Promise<HarnessAccountInspectResult> {
    return this.#accountInspections.inspect(adapter, this.#pluginDescriptors, refresh);
  }

  async #currentCodexAccountId(): Promise<string | null> {
    return this.#accountControl.currentAccountId();
  }

  async #handleCodexAccountRequest(request: JsonRpcRequest): Promise<void> {
    try {
      const { accountId, refresh } = codexAccountUsageParamsSchema.parse(requestObject(request));
      if (accountId !== (await this.#currentCodexAccountId()))
        throw new Error("Unknown Codex Account");
      const observation = await this.#refreshOfficialRateLimits(accountId, refresh === true);
      const usage = this.#officialRateLimits.get(accountId);
      const accountCredits = this.#officialAccountCredits(accountId);
      const result = codexAccountUsageResultSchema.parse({
        accountId,
        usage,
        ...(accountCredits ? { accountCredits } : {}),
        freshness: observation.status === "live" ? ("live" as const) : ("cached" as const),
        observedAt: observation.observedAt,
      });
      await this.#writer.json(rpcEnvelope(request, { result: jsonValueSchema.parse(result) }));
    } catch (error) {
      const failure = codexAccountRpcError(error);
      await this.#writer.json(rpcError(request, failure.code, failure.message));
    }
  }

  async #observeOfficialTurnLifecycle(value: JsonValue): Promise<void> {
    if (!isRecord(value) || !isRecord(value.params)) return;
    const params = value.params;
    if (value.method === "turn/started" && typeof params.threadId === "string") {
      const turn = isRecord(params.turn) ? params.turn : null;
      if (turn && typeof turn.id === "string") {
        this.#forgetPendingOfficialTurnStarts(params.threadId);
        this.#activeOfficialTurns.set(params.threadId, turn.id);
      }
    }
    if (value.method === "turn/completed" && typeof params.threadId === "string") {
      this.#forgetPendingOfficialTurnStarts(params.threadId);
      this.#activeOfficialTurns.delete(params.threadId);
      this.#signalActiveWorkChanged();
    }
  }

  async #listThreads(
    request: JsonRpcRequest,
    listRequest: DecodedThreadListRequest,
  ): Promise<void> {
    try {
      const records = await this.#repository.list();
      const result = await aggregateThreadList({
        query: listRequest,
        records,
        runtimeFor: (threadId) => {
          const thread = this.#externalRuntime.get(threadId);
          const subagentStatus = this.#subagentThreadStatuses.get(threadId);
          if (subagentStatus) return { running: subagentStatus === "active" };
          return thread ? { running: thread.running } : null;
        },
        requestOfficialPage: async (params) =>
          officialThreadListPageFromResponse(
            await this.#officialRuntime.request("thread/list", params),
          ),
      });
      await this.#writer.json(rpcEnvelope(request, { result }));
    } catch (error) {
      if (error instanceof OfficialThreadListError) {
        await this.#writer.json(rpcEnvelope(request, { error: error.rpcError }));
        return;
      }
      await this.#writer.json(rpcError(request, -32082, "Thread list aggregation failed"));
      this.#diagnose(error);
    }
  }

  async #setExternalThreadArchived(
    request: JsonRpcRequest,
    location: Extract<ExternalThreadLocation, { kind: "external" }>,
    archived: boolean,
  ): Promise<void> {
    if (location.record.state !== "ready" || !location.record.nativeSessionRef) {
      await this.#writer.json(rpcError(request, -32079, "External Native Session is unavailable"));
      return;
    }
    const sessionId =
      location.thread?.sessionId ??
      (await this.#repository.sessionTreeId(location.record).catch(() => null));
    if (!sessionId) {
      await this.#writer.json(
        rpcError(request, -32081, "External Thread metadata could not be projected"),
      );
      return;
    }
    let record: StoredThreadRecordV1;
    try {
      record = await this.#repository.setArchived(location.record.hostThreadId, archived);
    } catch {
      await this.#writer.json(
        rpcError(request, -32081, "External Thread archive state could not be persisted"),
      );
      return;
    }
    const projected = externalThreadValue({
      record,
      turns: [],
      sessionId,
      ...(location.thread ? { running: location.thread.running } : { loaded: false }),
    });
    if (location.thread) {
      location.thread.record = record;
      location.thread.thread = {
        ...location.thread.thread,
        ...projected,
        turns: location.thread.thread.turns ?? [],
      };
    }
    await this.#writer.json(
      rpcEnvelope(request, { result: archived ? {} : { thread: projected } }),
    );
    await this.#writer.json({
      method: archived ? "thread/archived" : "thread/unarchived",
      params: { threadId: record.hostThreadId },
    });
  }

  async #inspectThreadUsage(request: JsonRpcRequest): Promise<void> {
    const params = threadUsageInspectionParamsSchema.safeParse(request.params);
    if (!params.success) {
      await this.#writer.json(rpcError(request, -32602, "Invalid Thread Usage inspection params"));
      return;
    }
    const resolution = await this.#resolveExternalThread(params.data.threadId);
    if (resolution.kind === "error") {
      await this.#writer.json(rpcError(request, resolution.error.code, resolution.error.message));
      return;
    }
    if (resolution.kind === "official") {
      if (params.data.refresh !== undefined) {
        await this.#writer.json(
          rpcError(request, -32602, "Exact Usage refresh is only available for External Threads"),
        );
        return;
      }
      const accountId = await this.#currentCodexAccountId();
      if (accountId) await this.#refreshOfficialRateLimits(accountId);
      const accountCredits = this.#officialAccountCredits(accountId ?? undefined);
      const result = threadUsageInspectionSchema.parse({
        threadId: params.data.threadId,
        usage: this.#officialUsageByThread.get(params.data.threadId) ?? null,
        ...(accountCredits ? { accountCredits } : {}),
      });
      await this.#writer.json(rpcEnvelope(request, { result: jsonValueSchema.parse(result) }));
      return;
    }
    if (params.data.refresh === "exact") void resolution.thread.session.refreshUsage?.();
    const adapter = this.#externalAdapters.get(resolution.thread.harnessId);
    if (adapter && isCreditsAdapter(adapter)) void adapter.refreshCredits?.();
    const credits =
      adapter && isCreditsAdapter(adapter) ? projectAccountCredits(adapter.credits()) : null;
    const result = threadUsageInspectionSchema.parse({
      threadId: params.data.threadId,
      usage: resolution.thread.latestUsage,
      ...(credits ? { accountCredits: credits } : {}),
    });
    await this.#writer.json(rpcEnvelope(request, { result: jsonValueSchema.parse(result) }));
  }

  #refreshOfficialRateLimits(accountId: string, force = false) {
    return this.#officialRateLimits.refresh(
      accountId,
      async () => this.#officialRuntime.request("account/rateLimits/read", {}),
      force,
    );
  }

  #officialAccountCredits(accountId: string | undefined): AccountCreditsSnapshot | null {
    if (!accountId) return null;
    return projectCodexRateLimitsToCredits(
      this.#officialRateLimits.get(accountId),
      this.#officialRateLimits.getResetCredits(accountId),
    );
  }

  async #startExternalCommand(
    request: JsonRpcRequest,
    thread: ExternalThread,
    commandId: string,
    arguments_: JsonObject | undefined,
    requestedTurnId: HostTurnId | undefined,
    responseKind: "command" | "turn",
  ): Promise<void> {
    const commands = thread.session.commands;
    if (!commands) {
      await this.#writer.json(
        rpcError(request, -32078, "External Harness does not expose commands"),
      );
      return;
    }
    if (thread.running || this.#externalSteering.hasPending(thread.id)) {
      await this.#writer.json(
        rpcError(request, -32072, "External Thread already has an active operation"),
      );
      return;
    }
    const turnId = requestedTurnId ?? hostTurnIdSchema.parse(randomUUID());
    const projection: ProjectedTurn = {
      projector: new CodexTurnProjector({
        threadId: thread.id,
        turnId,
        cwd: thread.cwd,
        startedAtMs: Date.now(),
      }),
    };
    const gate = turnProjectionGate();
    thread.running = true;
    thread.activeTurnId = turnId;
    thread.projectedTurns.set(turnId, projection);
    thread.responseGates.set(turnId, gate);
    thread.ephemeralTurnIds.add(turnId);

    let result: Awaited<ReturnType<NonNullable<HarnessSession["commands"]>["execute"]>>;
    try {
      result = await commands.execute({
        turnId,
        commandId,
        ...(arguments_ ? { arguments: arguments_ } : {}),
      });
    } catch (error) {
      thread.running = false;
      thread.activeTurnId = null;
      thread.projectedTurns.delete(turnId);
      thread.responseGates.delete(turnId);
      thread.ephemeralTurnIds.delete(turnId);
      gate.resolve();
      this.#signalActiveWorkChanged();
      throw error;
    }
    if (!result.ok) {
      thread.running = false;
      thread.activeTurnId = null;
      thread.projectedTurns.delete(turnId);
      thread.responseGates.delete(turnId);
      thread.ephemeralTurnIds.delete(turnId);
      gate.resolve();
      this.#signalActiveWorkChanged();
      await this.#writer.json(rpcError(request, -32073, result.error.message));
      return;
    }
    try {
      const response =
        responseKind === "command"
          ? jsonValueSchema.parse(
              threadCommandExecuteResultSchema.parse({
                accepted: true,
                turnId: result.value.turnId,
              }),
            )
          : { turn: projection.projector.pendingTurn() };
      await this.#writer.json(rpcEnvelope(request, { result: response as JsonObject }));
    } finally {
      gate.resolve();
    }
  }

  async #startExternalThread(request: JsonRpcRequest, harnessId: ExternalHarnessId): Promise<void> {
    await this.#waitForPlugins();
    const adapter = this.#externalAdapters.get(harnessId);
    if (!adapter) {
      this.#routeObservationTracker.rejectCreate(request.id);
      await this.#writer.json(
        rpcError(request, -32070, `External Harness '${harnessId}' is unavailable`),
      );
      return;
    }
    const params = requestObject(request);
    const route = decodeCreateRoute(request);
    const requestedModel = route && route.harnessId !== "codex" ? route.model : undefined;
    let requestedThinkingOptionId =
      route && route.harnessId !== "codex" ? route.thinkingOptionId : undefined;
    const nativeEffort = requestedNativeSelection(params).effort;
    if (!requestedThinkingOptionId && nativeEffort) {
      // The native picker carries effort separately from the Model route id.
      const inspection = harnessInspectionSchema.safeParse(
        await adapter.inspect({}).catch(() => undefined),
      );
      if (inspection.success && inspection.data.status === "ready") {
        requestedThinkingOptionId = thinkingOptionForEffort(nativeEffort, inspection.data.catalog);
      }
    }
    let requestedPermissionModeId =
      route && route.harnessId !== "codex" ? route.permissionModeId : undefined;
    const startLevel = nativePermissionLevel(params);
    if (!requestedPermissionModeId) {
      // The official permission selector and Plan toggle choose the Harness Permission Mode.
      const offered = await this.#offeredPermissionModes(harnessId);
      const wanted =
        nativePlanMode(params) === true && offered.includes("plan")
          ? "plan"
          : startLevel
            ? permissionModeForLevel(startLevel, offered)
            : undefined;
      const parsed = harnessPermissionModeIdSchema.safeParse(wanted);
      if (parsed.success) requestedPermissionModeId = parsed.data;
    }
    const transportModelId =
      route && route.harnessId === harnessId && route.transportModelId
        ? route.transportModelId
        : transportModelIdForHarness(harnessId);
    const cwd = params.cwd;
    if (typeof cwd !== "string" || cwd.length === 0) {
      this.#routeObservationTracker.rejectCreate(request.id);
      await this.#writer.json(
        rpcError(request, -32602, `External Harness '${harnessId}' thread/start requires cwd`),
      );
      return;
    }

    const recordInput = createExternalThreadRecordInput({
      harnessId: adapter.harnessId,
      cwd,
      transportModelId,
      ephemeral: params.ephemeral === true,
      historyMode: params.historyMode === "paginated" ? "paginated" : "legacy",
    });
    let record: StoredThreadRecordV1;
    try {
      record = await this.#repository.createProvisional(recordInput);
    } catch {
      this.#routeObservationTracker.rejectCreate(request.id);
      await this.#writer.json(rpcError(request, -32081, "External Thread could not be persisted"));
      return;
    }

    const sessionResult = await adapter.open({
      clientTools: this.#externalRuntime.clientTools(record.hostThreadId, record.cwd),
      kind: "create",
      cwd,
      environment: this.#options.environment ?? process.env,
      ...(requestedModel ? { model: requestedModel } : {}),
      ...(requestedThinkingOptionId ? { thinkingOptionId: requestedThinkingOptionId } : {}),
      ...(requestedPermissionModeId ? { permissionModeId: requestedPermissionModeId } : {}),
    });
    if (!sessionResult.ok) {
      this.#routeObservationTracker.rejectCreate(request.id);
      await this.#repository.removeProvisional(record.hostThreadId).catch(() => undefined);
      const mapped = mapExternalThreadHarnessError(sessionResult.error, "create");
      await this.#writer.json(rpcError(request, mapped.code, mapped.message));
      return;
    }
    const session = sessionResult.value;
    this.#traceNativePicker({
      event: "thread/start",
      harnessId,
      model: requestedModel?.id ?? null,
      nativeEffort: nativeEffort ?? null,
      requestedThinkingOptionId: requestedThinkingOptionId ?? null,
      sessionThinkingOptionId: session.initialState.effectiveThinkingOptionId ?? null,
      sessionPermissionModeId: session.initialState.effectivePermissionModeId ?? null,
      permission: requestedNativePermission(params),
    });
    await this.#externalRuntime.idleRelease.runOperation(record.hostThreadId, async () => {
      try {
        if (session.initialState.nativeRef) {
          record = await this.#repository.commitNative(
            record.hostThreadId,
            session.initialState.nativeRef,
          );
        }
        const thread = externalThreadValue({
          record,
          turns: [],
          sessionId: record.hostThreadId,
        });
        const externalThread = this.#registerExternalThread({
          record,
          session,
          sessionId: record.hostThreadId,
          thread,
          turns: [],
          ...(requestedModel ? { requestedModel } : {}),
          ...(requestedThinkingOptionId ? { requestedThinkingOptionId } : {}),
          ...(requestedPermissionModeId ? { requestedPermissionModeId } : {}),
        });
        if (startLevel) {
          externalThread.nativePermissionLevel = startLevel;
          if (params.approvalPolicy !== undefined)
            externalThread.nativeApprovalPolicy = params.approvalPolicy;
        }
        this.#routeObservationTracker.bindCreatedThread(request.id, externalThread.id);
        await this.#writer.json(
          rpcEnvelope(request, {
            result: {
              thread,
              model: this.#nativeThreadSelection(externalThread).model,
              modelProvider: "codexhost",
              cwd,
              // Echo the requested policy. Rewriting a granular policy to "never" made later
              // Turns claim an approval-free Thread the user never selected.
              approvalPolicy:
                typeof params.approvalPolicy === "string" || isRecord(params.approvalPolicy)
                  ? params.approvalPolicy
                  : "never",
              approvalsReviewer:
                typeof params.approvalsReviewer === "string" ? params.approvalsReviewer : "user",
              sandbox: sandboxResult(params),
              reasoningEffort: this.#nativeThreadSelection(externalThread).reasoningEffort,
              serviceTier: "flex",
              multiAgentMode: "explicitRequestOnly",
              activePermissionProfile: null,
              runtimeWorkspaceRoots: Array.isArray(params.runtimeWorkspaceRoots)
                ? params.runtimeWorkspaceRoots
                : [],
              instructionSources: [],
            },
          }),
        );
        await this.#writer.json({
          method: "thread/started",
          emittedAtMs: Date.now(),
          params: { thread },
        });
      } catch {
        this.#externalRuntime.remove(record.hostThreadId);
        this.#routeObservationTracker.forgetThread(record.hostThreadId);
        await session.close().catch(() => undefined);
        await this.#repository.removeProvisional(record.hostThreadId).catch(() => undefined);
        await this.#writer.json(
          rpcError(request, -32081, "External Thread could not be persisted"),
        );
      }
    });
  }

  #registerExternalThread(input: {
    record: StoredThreadRecordV1;
    session: HarnessSession;
    sessionId: string;
    thread: JsonObject;
    turns: JsonObject[];
    requestedModel?: HarnessModelRef;
    requestedThinkingOptionId?: HarnessThinkingOptionId;
    requestedPermissionModeId?: HarnessPermissionModeId;
  }): ExternalThread {
    return this.#externalRuntime.register(input);
  }

  #locateExternalThread(threadId: string): Promise<ExternalThreadLocation> {
    return this.#externalRuntime.locate(threadId);
  }

  async #resolveExternalThread(threadId: string): Promise<ExternalThreadResolution> {
    const location = await this.#locateExternalThread(threadId);
    if (location.kind !== "external") return location;
    await this.#waitForPlugins();
    return this.#externalRuntime.resolve(threadId);
  }

  async #writeResolutionError(
    request: JsonRpcRequest,
    resolution: ExternalThreadLocation | ExternalThreadResolution,
  ): Promise<boolean> {
    if (resolution.kind !== "error") return false;
    await this.#writer.json(rpcError(request, resolution.error.code, resolution.error.message));
    return true;
  }

  #refreshExternalThread(thread: ExternalThread): Promise<ExternalThreadRpcError | null> {
    return this.#externalRuntime.refresh(thread);
  }

  #persistTerminalIdentity(
    thread: ExternalThread,
    event: Parameters<ExternalThreadRuntime["persistTerminalIdentity"]>[1],
  ): Promise<Error | null> {
    return this.#externalRuntime.persistTerminalIdentity(thread, event);
  }

  async #forkExternalThread(
    request: JsonRpcRequest,
    source: ExternalThread,
    fork: DecodedThreadForkRequest,
  ): Promise<void> {
    const result = await executeExternalThreadFork({
      source,
      fork,
      adapters: this.#externalAdapters,
      repository: this.#repository,
      runtime: this.#externalRuntime,
      environment: this.#options.environment ?? process.env,
    });
    if (!result.ok) {
      await this.#writer.json(rpcError(request, result.error.code, result.error.message));
      return;
    }
    await this.#inheritNativeSettings(source, result.derived, requestObject(request));
    const params: JsonObject = {
      ...(fork.sandbox ? { sandbox: fork.sandbox } : {}),
    };
    await this.#writer.json(
      rpcEnvelope(request, {
        result: threadForkResult(result.responseThread, {
          ...this.#nativeThreadSelection(result.derived),
          cwd: result.derived.cwd,
          ...(fork.runtimeWorkspaceRoots
            ? { runtimeWorkspaceRoots: fork.runtimeWorkspaceRoots }
            : {}),
          ...(fork.approvalPolicy ? { approvalPolicy: fork.approvalPolicy } : {}),
          sandbox: sandboxResult(params),
          ...this.#nativePermissionFields(result.derived),
          ...(fork.serviceTier ? { serviceTier: fork.serviceTier } : {}),
        }),
      }),
    );
    await this.#notifyExternalThreadStarted(result.thread);
  }

  async #notifyExternalThreadStarted(thread: JsonObject): Promise<void> {
    await this.#writer.json({
      method: "thread/started",
      emittedAtMs: Date.now(),
      params: { thread: { ...thread, turns: [] } },
    });
  }

  async #revertExternalThread(
    request: JsonRpcRequest,
    thread: ExternalThread,
    revert: DecodedThreadRevertRequest,
  ): Promise<void> {
    if (thread.record.historyMode !== "paginated") {
      await this.#writer.json(
        rpcError(request, -32602, "External thread/revert requires paginated history"),
      );
      return;
    }
    const result = await executeExternalThreadRollback({
      derived: thread,
      rollback: { threadId: revert.threadId, numTurns: 1 },
      expectedLastTurnId: revert.beforeTurnId,
      adapters: this.#externalAdapters,
      repository: this.#repository,
      runtime: this.#externalRuntime,
      environment: this.#options.environment ?? process.env,
    });
    if (!result.ok) {
      await this.#writer.json(rpcError(request, result.error.code, result.error.message));
      return;
    }
    await this.#writer.json(rpcEnvelope(request, { result: threadRevertResult(result.thread) }));
    await this.#writer.json({ method: "thread/reverted", params: { threadId: thread.id } });
  }

  async #rollbackExternalThread(
    request: JsonRpcRequest,
    derived: ExternalThread,
    rollback: DecodedThreadRollbackRequest,
  ): Promise<void> {
    const result = await executeExternalThreadRollback({
      derived,
      rollback,
      adapters: this.#externalAdapters,
      repository: this.#repository,
      runtime: this.#externalRuntime,
      environment: this.#options.environment ?? process.env,
    });
    if (!result.ok) {
      await this.#writer.json(rpcError(request, result.error.code, result.error.message));
      return;
    }
    await this.#writer.json(rpcEnvelope(request, { result: threadRollbackResult(result.thread) }));
  }

  async #setExternalThreadName(
    request: JsonRpcRequest,
    location: Extract<ExternalThreadLocation, { kind: "external" }>,
    name: JsonValue | undefined,
  ): Promise<void> {
    if (typeof name !== "string" || name.length === 0) {
      await this.#writer.json(
        rpcError(request, -32602, "External Thread name must be a non-empty string"),
      );
      return;
    }
    let record: StoredThreadRecordV1;
    try {
      record = await this.#repository.setTitle(location.record.hostThreadId, name);
    } catch {
      await this.#writer.json(
        rpcError(request, -32081, "External Thread title could not be persisted"),
      );
      return;
    }
    if (location.thread) {
      location.thread.record = record;
      location.thread.thread.name = name;
      location.thread.thread.updatedAt = unixSeconds();
    }
    await this.#writer.json(rpcEnvelope(request, { result: {} }));
    await this.#writer.json({
      method: "thread/name/updated",
      params: { threadId: location.record.hostThreadId, threadName: name },
    });
  }

  async #deleteExternalThread(
    request: JsonRpcRequest,
    location: Extract<ExternalThreadLocation, { kind: "external" }>,
  ): Promise<void> {
    const thread = location.thread;
    try {
      await this.#repository.removeThread(location.record.hostThreadId);
    } catch {
      await this.#writer.json(rpcError(request, -32081, "External Thread could not be removed"));
      return;
    }
    this.#externalRuntime.remove(location.record.hostThreadId);
    this.#routeObservationTracker.forgetThread(location.record.hostThreadId);
    if (!thread) {
      await this.#writer.json(rpcEnvelope(request, { result: {} }));
      return;
    }
    thread.stateObserver.fault(new Error("External Thread was deleted"));
    try {
      await thread.session.close();
      await thread.outputTask;
      await this.#writer.json(rpcEnvelope(request, { result: {} }));
    } catch (error) {
      await this.#writer.json(
        rpcError(request, -32075, `External Thread could not close: ${errorMessage(error)}`),
      );
    }
  }

  async #readExternalThreadMetadata(
    request: JsonRpcRequest,
    location: Extract<ExternalThreadLocation, { kind: "external" }>,
  ): Promise<void> {
    try {
      const thread = location.thread
        ? { ...location.thread.thread, turns: [] }
        : externalThreadValue({
            record: location.record,
            turns: [],
            sessionId: await this.#repository.sessionTreeId(location.record),
          });
      await this.#writer.json(rpcEnvelope(request, { result: { thread } }));
      if (location.thread) await this.#replayExternalUsage(location.thread);
    } catch {
      await this.#writer.json(
        rpcError(request, -32081, "External Thread metadata could not be read"),
      );
    }
  }

  async #readExternalThread(
    request: JsonRpcRequest,
    thread: ExternalThread,
    includeTurns: boolean,
    historyFresh: boolean,
  ): Promise<void> {
    if (includeTurns && thread.record.historyMode === "paginated") {
      await this.#writer.json(
        rpcError(request, -32602, "Paginated External Threads require thread/turns/list"),
      );
      return;
    }
    if (includeTurns && !thread.running && !historyFresh) {
      const refreshed = await this.#refreshExternalThread(thread);
      if (refreshed) {
        await this.#writer.json(rpcError(request, refreshed.code, refreshed.message));
        return;
      }
    }
    await this.#writer.json(
      rpcEnvelope(request, {
        result: {
          thread: {
            ...thread.thread,
            turns: includeTurns ? this.#externalHistoryTurns(thread) : [],
          },
        },
      }),
    );
    await this.#replayExternalUsage(thread);
  }

  async #listExternalHistory(
    request: JsonRpcRequest,
    thread: ExternalThread,
    params: JsonObject,
    historyFresh: boolean,
  ): Promise<void> {
    const headPage = params.cursor === null || params.cursor === undefined;
    const requiresRefresh =
      request.method === "thread/turns/list" ||
      (request.method === "thread/items/list" && !thread.historyHydrated);
    if (!thread.running && !historyFresh && headPage && requiresRefresh) {
      const refreshed = await this.#refreshExternalThread(thread);
      if (refreshed) {
        await this.#writer.json(rpcError(request, refreshed.code, refreshed.message));
        return;
      }
    }
    try {
      const turns = this.#externalHistoryTurns(thread);
      const result =
        request.method === "thread/turns/list"
          ? listExternalTurns(turns, params)
          : listExternalItems(turns, params);
      await this.#writer.json(rpcEnvelope(request, { result }));
    } catch (error) {
      await this.#writer.json(
        rpcError(
          request,
          error instanceof ExternalHistoryRequestError ? -32602 : -32076,
          error instanceof ExternalHistoryRequestError
            ? error.message
            : "External Thread history projection failed",
        ),
      );
    }
  }

  async #resumeExternalThread(
    request: JsonRpcRequest,
    thread: ExternalThread,
    params: JsonObject,
    historyFresh: boolean,
  ): Promise<void> {
    if (!thread.running && !historyFresh) {
      const refreshed = await this.#refreshExternalThread(thread);
      if (refreshed) {
        await this.#writer.json(rpcError(request, refreshed.code, refreshed.message));
        return;
      }
    }
    const turns = this.#externalHistoryTurns(thread);
    const responseThread = {
      ...thread.thread,
      turns: params.excludeTurns === true ? [] : turns,
    };
    const result = threadForkResult(responseThread, {
      ...this.#nativeThreadSelection(thread),
      cwd: thread.cwd,
      runtimeWorkspaceRoots: Array.isArray(params.runtimeWorkspaceRoots)
        ? params.runtimeWorkspaceRoots.filter((value): value is string => typeof value === "string")
        : [],
      approvalPolicy: typeof params.approvalPolicy === "string" ? params.approvalPolicy : "never",
      sandbox: sandboxResult(params),
      ...this.#nativePermissionFields(thread),
      ...(typeof params.serviceTier === "string" ? { serviceTier: params.serviceTier } : {}),
    });
    try {
      if (
        params.initialTurnsPage !== undefined &&
        params.initialTurnsPage !== null &&
        !isRecord(params.initialTurnsPage)
      ) {
        throw new ExternalHistoryRequestError("initialTurnsPage must be an object");
      }
      const initialPageParams = isRecord(params.initialTurnsPage)
        ? (params.initialTurnsPage as JsonObject)
        : null;
      const initialTurnsPage = initialPageParams
        ? listExternalTurns(turns, initialPageParams)
        : null;
      const paginated = thread.record.historyMode === "paginated";
      const turnsBackwardsCursor = paginated
        ? listExternalTurns(turns, { limit: 1, itemsView: "notLoaded" }).backwardsCursor
        : null;
      const itemsBackwardsCursor = paginated
        ? listExternalItems(turns, { limit: 1, sortDirection: "desc" }).backwardsCursor
        : null;
      await this.#writer.json(
        rpcEnvelope(request, {
          result: {
            ...result,
            initialTurnsPage,
            turnsBackwardsCursor,
            itemsBackwardsCursor,
          },
        }),
      );
    } catch (error) {
      await this.#writer.json(
        rpcError(
          request,
          error instanceof ExternalHistoryRequestError ? -32602 : -32076,
          error instanceof ExternalHistoryRequestError
            ? error.message
            : "External Thread history projection failed",
        ),
      );
    }
  }

  #externalHistoryTurns(thread: ExternalThread): JsonObject[] {
    if (!thread.activeTurnId) return thread.turns;
    const active = thread.projectedTurns.get(thread.activeTurnId);
    return active ? [...thread.turns, active.projector.pendingTurn()] : thread.turns;
  }

  async #startExternalTurn(request: JsonRpcRequest, thread: ExternalThread): Promise<void> {
    if (
      thread.running ||
      this.#externalSteering.hasPending(thread.id) ||
      this.#pendingExternalCommandRequests.has(thread.id)
    ) {
      await this.#writer.json(
        rpcError(request, -32072, "External Thread already has an active Turn"),
      );
      return;
    }
    const params = requestObject(request);
    if (typeof params.model === "string") {
      let route: ReturnType<typeof decodeCreateRoute>;
      try {
        route = decodeCreateRoute({ id: request.id, method: "thread/start", params });
      } catch (error) {
        await this.#writer.json(rpcError(request, -32602, errorMessage(error)));
        return;
      }
      if (route?.harnessId !== "codex" && route?.harnessId !== thread.harnessId) {
        await this.#writer.json(
          rpcError(request, -32602, "Turn Model carrier does not belong to the Thread Harness"),
        );
        return;
      }
    }
    this.#traceNativePicker({
      event: "turn/start",
      harnessId: thread.harnessId,
      permission: requestedNativePermission(params),
    });
    const nativeSelectionFailure = await this.#applyNativeSelection(
      thread,
      requestedNativeSelection(params),
      "ignore",
    );
    // A Turn echoes approval fields from Host responses, so only its Plan toggle is trusted.
    const selectionFailure =
      nativeSelectionFailure ?? (await this.#applyNativePermission(thread, params, "plan-only"));
    if (selectionFailure) {
      await this.#writer.json(rpcError(request, selectionFailure.code, selectionFailure.message));
      return;
    }
    let text: string;
    try {
      text = requestText(params);
    } catch (error) {
      // Shape only (types, lengths, key names): enough to see why a Turn carried no text.
      this.#traceNativePicker({
        event: "turn/start-rejected",
        reason: errorMessage(error),
        keys: Object.keys(params).sort(),
        input: Array.isArray(params.input)
          ? params.input.map((item) =>
              isRecord(item)
                ? {
                    type: typeof item.type === "string" ? item.type : null,
                    keys: Object.keys(item).sort(),
                    textLength: typeof item.text === "string" ? item.text.length : null,
                  }
                : typeof item,
            )
          : typeof params.input,
        toolOutput: isRecord(params.toolOutput)
          ? {
              keys: Object.keys(params.toolOutput).sort(),
              namespace:
                typeof params.toolOutput.namespace === "string"
                  ? params.toolOutput.namespace
                  : null,
              outputType: typeof params.toolOutput.output,
            }
          : typeof params.toolOutput,
      });
      await this.#writer.json(rpcError(request, -32602, errorMessage(error)));
      return;
    }
    const commandCandidate = text.trimStart();
    if (thread.session.commands && /^\/[^\s/]+(?:\s|$)/u.test(commandCandidate)) {
      const commandText = commandCandidate.trimEnd();
      this.#pendingExternalCommandRequests.add(thread.id);
      try {
        const catalog = await thread.session.commands.list();
        if (!catalog.ok) {
          await this.#writer.json(rpcError(request, -32073, catalog.error.message));
          return;
        }
        const matched = catalog.value.commands
          .toSorted((left, right) => right.invocation.length - left.invocation.length)
          .find((command) => {
            if (commandText === command.invocation) return true;
            return (
              command.argumentMode === "text" && commandText.startsWith(`${command.invocation} `)
            );
          });
        if (matched) {
          const argumentText = commandText.slice(matched.invocation.length).trimStart();
          try {
            await this.#startExternalCommand(
              request,
              thread,
              matched.id,
              argumentText.length > 0 ? { text: argumentText } : undefined,
              undefined,
              "turn",
            );
          } catch (error) {
            this.#diagnose(error);
            await this.#writer.json(
              rpcError(request, -32073, `External Harness command failed: ${errorMessage(error)}`),
            );
          }
          return;
        }
        await this.#writer.json(
          rpcError(request, -32078, "External Harness does not expose the requested command"),
        );
        return;
      } finally {
        this.#pendingExternalCommandRequests.delete(thread.id);
      }
    }
    if (this.#externalSteering.hasPending(thread.id)) {
      await this.#writer.json(rpcError(request, -32072, "External Thread is changing direction"));
      return;
    }
    try {
      const started = await this.#beginExternalTurn(thread, text);
      try {
        await this.#writer.json(rpcEnvelope(request, { result: { turn: started.turn } }));
      } finally {
        started.gate.resolve();
      }
    } catch (error) {
      await this.#writer.json(
        rpcError(
          request,
          error instanceof ExternalSteerError ? error.code : -32073,
          errorMessage(error),
        ),
      );
    }
  }

  async #steerExternalTurn(request: JsonRpcRequest, thread: ExternalThread): Promise<void> {
    try {
      const started = await this.#externalSteering.run(thread, requestObject(request), (text) =>
        this.#beginExternalTurn(thread, text),
      );
      try {
        await this.#writer.json(rpcEnvelope(request, { result: { turnId: started.turnId } }));
      } finally {
        started.gate.resolve();
      }
    } catch (error) {
      await this.#writer.json(
        rpcError(
          request,
          error instanceof ExternalSteerError ? error.code : -32074,
          errorMessage(error),
        ),
      );
    } finally {
      this.#signalActiveWorkChanged();
    }
  }

  async #beginExternalTurn(
    thread: ExternalThread,
    text: string,
  ): Promise<{
    turnId: HostTurnId;
    turn: JsonObject;
    gate: TurnProjectionGate;
  }> {
    if (this.#closeRequested || this.#externalRuntime.get(thread.id) !== thread) {
      throw new ExternalSteerError(-32073, "External Thread is no longer available");
    }
    if (
      thread.running ||
      thread.activeTurnId ||
      this.#pendingExternalCommandRequests.has(thread.id)
    ) {
      throw new ExternalSteerError(-32072, "External Thread already has an active Turn");
    }
    const turnId = hostTurnIdSchema.parse(randomUUID());
    const startedAtMs = Date.now();
    const projection: ProjectedTurn = {
      projector: new CodexTurnProjector({
        threadId: thread.id,
        turnId,
        cwd: thread.cwd,
        startedAtMs,
      }),
    };
    const gate = turnProjectionGate();
    thread.running = true;
    thread.activeTurnId = turnId;
    thread.projectedTurns.set(turnId, projection);
    thread.responseGates.set(turnId, gate);

    try {
      const injected = thread.pendingInjectedContext?.splice(0) ?? [];
      const result = await thread.session.execute({
        type: "turn.start",
        turnId,
        input: [
          {
            type: "text",
            text:
              injected.length > 0
                ? `<injected_context>\n${injected.join("\n\n")}\n</injected_context>\n\n${text}`
                : text,
          },
        ],
      });
      if (!result.ok) throw new ExternalSteerError(-32073, result.error.message);
      return { turnId, turn: projection.projector.pendingTurn(), gate };
    } catch (error) {
      thread.running = false;
      thread.activeTurnId = null;
      thread.projectedTurns.delete(turnId);
      thread.responseGates.delete(turnId);
      gate.resolve();
      this.#signalActiveWorkChanged();
      throw error;
    }
  }

  async #interruptExternalTurn(
    request: JsonRpcRequest,
    thread: ExternalThread,
    requestedTurnId: JsonValue | undefined,
  ): Promise<void> {
    if (typeof requestedTurnId === "string")
      this.#externalSteering.interrupt(thread.id, requestedTurnId);
    if (
      typeof requestedTurnId !== "string" ||
      !thread.running ||
      thread.activeTurnId !== requestedTurnId
    ) {
      await this.#writer.json(
        rpcError(request, -32074, "External turn/interrupt must reference the active Turn"),
      );
      return;
    }
    const turnId = thread.activeTurnId;
    const cancellationGate = turnProjectionGate();
    const gate: TurnProjectionGate = {
      promise: Promise.all([
        thread.responseGates.get(turnId)?.promise ?? Promise.resolve(),
        cancellationGate.promise,
      ]).then(() => undefined),
      resolve: cancellationGate.resolve,
    };
    thread.responseGates.set(turnId, gate);
    const result = await thread.session.execute({ type: "turn.cancel", turnId });
    if (!result.ok) {
      try {
        await this.#writer.json(rpcError(request, -32074, result.error.message));
      } finally {
        gate.resolve();
      }
      return;
    }
    try {
      await this.#writer.json(rpcEnvelope(request, { result: {} }));
    } finally {
      gate.resolve();
    }
  }

  async #consumeHarnessOutputs(thread: ExternalThread): Promise<void> {
    try {
      for await (const output of thread.session.outputs) {
        await this.#externalRuntime.idleRelease.consumeOutput(thread, () =>
          this.#projectHarnessOutput(thread, output),
        );
      }
    } catch (error) {
      this.#externalRuntime.idleRelease.outputFailed(thread);
      this.#diagnose(error);
    } finally {
      this.#externalSteering.fault(
        thread.id,
        new Error("External Harness output ended before replacement"),
      );
    }
  }

  async #projectHarnessOutput(thread: ExternalThread, output: HarnessOutput): Promise<void> {
    if (output.kind === "interaction") {
      if (output.interaction.type === "approval") {
        await this.#projectApproval(thread, output.interaction);
      } else {
        await this.#projectQuestion(thread, output.interaction);
      }
      return;
    }
    let event = output.event;
    if (event.type === "item.started" && event.item.type === "subagentDelegation") {
      event = {
        ...event,
        item: {
          ...event.item,
          subagents: await Promise.all(
            event.item.subagents.map((subagent) =>
              this.#materializeSubagent(thread, subagent).catch(() => subagent),
            ),
          ),
        },
      };
    }
    if (event.type === "item.updated" && event.update.type === "subagents.replace") {
      event = {
        ...event,
        update: {
          ...event.update,
          subagents: await Promise.all(
            event.update.subagents.map((subagent) =>
              this.#materializeSubagent(thread, subagent).catch(() => subagent),
            ),
          ),
        },
      };
    }
    if (event.type === "item.completed" && event.snapshot.item.type === "subagentDelegation") {
      event = {
        ...event,
        snapshot: {
          ...event.snapshot,
          item: {
            ...event.snapshot.item,
            subagents: await Promise.all(
              event.snapshot.item.subagents.map((subagent) =>
                this.#materializeSubagent(thread, subagent).catch(() => subagent),
              ),
            ),
          },
        },
      };
    }
    if (event.type === "session.state.changed") {
      try {
        if (event.state.nativeRef) {
          if (!thread.record.nativeSessionRef) {
            thread.record = await this.#repository.commitNative(thread.id, event.state.nativeRef);
          } else if (
            thread.record.nativeSessionRef.harnessId !== event.state.nativeRef.harnessId ||
            thread.record.nativeSessionRef.nativeSessionId !== event.state.nativeRef.nativeSessionId
          ) {
            throw new Error("External Session changed Native identity");
          }
        }
        thread.stateObserver.update(event.state);
      } catch (error) {
        thread.persistenceError = error instanceof Error ? error : new Error(errorMessage(error));
        thread.stateObserver.fault(thread.persistenceError);
        this.#diagnose("External Session state could not be persisted");
      }
      return;
    }
    if (event.type === "session.usage.changed") {
      if (this.#externalRuntime.get(thread.id) !== thread) return;
      thread.latestUsage = event.usage;
      if (event.usage === null) {
        thread.usageTurnId = null;
        return;
      }
      const turnId = event.observedForTurnId
        ? this.#isKnownExternalTurn(thread, event.observedForTurnId)
          ? event.observedForTurnId
          : null
        : (thread.activeTurnId ?? this.#latestCompletedTurnId(thread));
      thread.usageTurnId = turnId;
      if (turnId) {
        await this.#waitForTurnResponse(thread, turnId);
        await this.#writeExternalUsage(thread, turnId);
      }
      return;
    }
    if (event.type === "subagent.transcript.changed") {
      const nativeSubagentId = event.nativeSubagentId;
      const record = (await this.#repository.list()).find(
        (candidate) =>
          candidate.subagent?.parentHostThreadId === thread.id &&
          candidate.subagent.nativeSubagentId === nativeSubagentId &&
          candidate.nativeSessionRef?.nativeSessionId ===
            thread.record.nativeSessionRef?.nativeSessionId,
      );
      if (record) await this.#refreshOpenSubagentThread(record.hostThreadId, false);
      return;
    }
    if (event.type === "subagent.state.changed") {
      const nativeSubagentId = event.nativeSubagentId;
      const record = (await this.#repository.list()).find(
        (candidate) =>
          candidate.subagent?.parentHostThreadId === thread.id &&
          candidate.subagent.nativeSubagentId === nativeSubagentId &&
          candidate.nativeSessionRef?.nativeSessionId ===
            thread.record.nativeSessionRef?.nativeSessionId,
      );
      if (!record) return;
      const status = event.status === "pending" || event.status === "running" ? "active" : "idle";
      this.#trackRunningSubagent(thread.id, record.hostThreadId, status);
      await this.#setSubagentThreadStatus(record.hostThreadId, status);
      if (!thread.running && !thread.activeTurnId && !this.#hasRunningSubagents(thread.id)) {
        await this.#setThreadStatus(thread, { type: "idle" });
      }
      return;
    }
    if (event.type === "session.faulted") {
      this.#externalSteering.fault(thread.id, new Error(event.error.message));
      thread.stateObserver.fault(new Error(event.error.message));
      this.#diagnose(`${thread.harnessId} Harness Session faulted: ${event.error.message}`);
      return;
    }

    if (event.type === "turn.autonomous.started") {
      if (thread.running || thread.activeTurnId) {
        throw new Error("External autonomous Turn started while another Turn is active");
      }
      const projection: ProjectedTurn = {
        projector: new CodexTurnProjector({
          threadId: thread.id,
          turnId: event.turnId,
          cwd: thread.cwd,
          startedAtMs: Date.now(),
          initialInput: event.input,
        }),
      };
      thread.running = true;
      thread.activeTurnId = event.turnId;
      thread.projectedTurns.set(event.turnId, projection);
      thread.responseGates.set(event.turnId, {
        promise: Promise.resolve(),
        resolve: () => undefined,
      });
      return;
    }

    const projection = this.#projectedTurn(thread, event.turnId);
    await this.#waitForTurnResponse(thread, event.turnId);
    if (
      event.type === "interaction.closed" &&
      thread.ignoredInteractionIds.delete(event.interactionId)
    ) {
      return;
    }
    if (event.type === "interaction.closed") {
      await this.#resolveDesktopApproval(event.interactionId);
      await this.#resolveDesktopQuestion(event.interactionId);
    }
    const ephemeralTurn =
      event.type === "turn.completed" && thread.ephemeralTurnIds.has(event.turnId);
    if (event.type === "turn.completed" && !ephemeralTurn) {
      const persistenceError = await this.#persistTerminalIdentity(thread, event);
      if (persistenceError) {
        this.#externalRuntime.idleRelease.outputFailed(thread);
        event = {
          type: "turn.completed",
          turnId: event.turnId,
          outcome: {
            status: "failed",
            error: {
              code: "internalError",
              message: "External Turn identity could not be persisted",
              retryable: false,
            },
          },
        };
      }
    }
    const result = projection.projector.project(event as ProjectableHostEvent);
    if (event.type === "turn.started") {
      await this.#setThreadStatus(thread, { type: "active", activeFlags: [] });
      this.#refreshExternalUsage(thread, "turn.started");
    }
    if (event.type === "turn.completed") {
      if (!result.completedTurn) throw new Error("Turn projector returned no completed Turn");
      const completedAt = Math.floor(Date.now() / 1000);
      if (ephemeralTurn) {
        thread.ephemeralTurnIds.delete(event.turnId);
      } else {
        thread.turns.push(result.completedTurn);
        thread.thread.updatedAt = completedAt;
        thread.thread.recencyAt = completedAt;
      }
      thread.historyHydrated = false;
      thread.running = false;
      thread.activeTurnId = null;
      this.#desktopTools.turnEnded(
        thread.id,
        event.turnId,
        result.completedTurn.status === "completed" ? "Stop" : "Interrupt",
      );
      thread.projectedTurns.delete(event.turnId);
      thread.responseGates.delete(event.turnId);
      this.#refreshExternalUsage(thread, "turn.completed");
      this.#signalActiveWorkChanged();
    }
    for (const message of result.messages) await this.#writer.json(message);
    if (event.type === "turn.completed") {
      await this.#setThreadStatus(
        thread,
        this.#hasRunningSubagents(thread.id)
          ? { type: "active", activeFlags: [] }
          : { type: "idle" },
      );
      this.#externalSteering.terminal(thread.id, event.turnId, event.outcome);
    }
  }

  async #materializeSubagent(
    parent: ExternalThread,
    subagent: HostSubagentState,
  ): Promise<HostSubagentState> {
    if (!subagent.nativeSubagentId || !parent.record.nativeSessionRef) return subagent;
    const status =
      subagent.status === "pending" || subagent.status === "running" ? "active" : "idle";
    const record = await this.#repository.materializeSubagent(parent.record, subagent);
    if (!record) return subagent;
    if (this.#subagentThreadStatuses.has(record.hostThreadId)) {
      this.#trackRunningSubagent(parent.id, record.hostThreadId, status);
      await this.#setSubagentThreadStatus(record.hostThreadId, status);
      return { ...subagent, subagentId: record.hostThreadId };
    }
    const thread = externalThreadValue({
      record,
      turns: [],
      sessionId: parent.sessionId,
      running: status === "active",
    });
    this.#subagentThreadStatuses.set(record.hostThreadId, status);
    this.#trackRunningSubagent(parent.id, record.hostThreadId, status);
    await this.#writer.json({
      method: "thread/started",
      emittedAtMs: Date.now(),
      params: { thread },
    });
    return { ...subagent, subagentId: record.hostThreadId };
  }

  async #refreshOpenSubagentThread(threadId: string, terminal = true): Promise<void> {
    const child = this.#externalRuntime.get(threadId);
    if (!child) return;
    const previousItems = new Map(
      child.turns.flatMap((turn) =>
        Array.isArray(turn.items)
          ? turn.items.flatMap((item) =>
              isRecord(item) && typeof item.id === "string"
                ? ([[item.id, JSON.stringify(item)]] as const)
                : [],
            )
          : [],
      ),
    );
    const refreshed = await this.#refreshExternalThread(child);
    if (refreshed) {
      this.#diagnose(refreshed.message);
      return;
    }
    const emittedAtMs = Date.now();
    for (const turn of child.turns) {
      if (typeof turn.id !== "string" || !Array.isArray(turn.items)) continue;
      const changedItems = turn.items.filter(
        (item): item is JsonObject =>
          isRecord(item) &&
          typeof item.id === "string" &&
          previousItems.get(item.id) !== JSON.stringify(item),
      );
      if (changedItems.length > 0) {
        await this.#writer.json({
          method: "turn/started",
          emittedAtMs,
          params: {
            threadId,
            turn: {
              ...turn,
              status: "inProgress",
              completedAt: null,
              durationMs: null,
            },
          },
        });
      }
      for (const item of changedItems) {
        await this.#writer.json({
          method: "item/started",
          emittedAtMs,
          params: {
            threadId,
            turnId: turn.id,
            startedAtMs: emittedAtMs,
            item,
          },
        });
        await this.#writer.json({
          method: "item/completed",
          emittedAtMs,
          params: {
            threadId,
            turnId: turn.id,
            completedAtMs: emittedAtMs,
            item,
          },
        });
      }
      if (terminal) {
        await this.#writer.json({
          method: "turn/completed",
          emittedAtMs,
          params: { threadId, turn },
        });
      }
    }
  }

  #trackRunningSubagent(
    parentThreadId: string,
    childThreadId: string,
    status: "active" | "idle",
  ): void {
    let running = this.#runningSubagentsByParent.get(parentThreadId);
    if (status === "active") {
      if (!running) {
        running = new Set();
        this.#runningSubagentsByParent.set(parentThreadId, running);
      }
      running.add(childThreadId);
      return;
    }
    if (!running) return;
    running.delete(childThreadId);
    if (running.size === 0) this.#runningSubagentsByParent.delete(parentThreadId);
    this.#signalActiveWorkChanged();
  }

  #hasRunningSubagents(parentThreadId: string): boolean {
    return (this.#runningSubagentsByParent.get(parentThreadId)?.size ?? 0) > 0;
  }

  async #setSubagentThreadStatus(threadId: string, status: "active" | "idle"): Promise<void> {
    const previousStatus = this.#subagentThreadStatuses.get(threadId);
    const child = this.#externalRuntime.get(threadId);
    if (child) {
      child.running = status === "active";
      if (status === "idle") child.historyHydrated = false;
      child.thread = externalThreadValue({
        record: child.record,
        turns: child.turns,
        sessionId: child.sessionId,
        running: child.running,
      });
    }
    if (status === "idle" && previousStatus === "active") {
      for (const [index, waitMs] of SUBAGENT_TERMINAL_REFRESH_DELAYS_MS.entries()) {
        if (waitMs > 0) await delay(waitMs);
        await this.#refreshOpenSubagentThread(
          threadId,
          index === SUBAGENT_TERMINAL_REFRESH_DELAYS_MS.length - 1,
        );
      }
    }
    if (previousStatus === status) return;
    this.#subagentThreadStatuses.set(threadId, status);
    await this.#writer.json({
      method: "thread/status/changed",
      emittedAtMs: Date.now(),
      params: {
        threadId,
        status: status === "active" ? { type: "active", activeFlags: [] } : { type: "idle" },
      },
    });
  }

  async #projectApproval(
    thread: ExternalThread,
    interaction: HostApprovalInteraction,
  ): Promise<void> {
    const projection = this.#projectedTurn(thread, interaction.turnId);
    await this.#waitForTurnResponse(thread, interaction.turnId);
    let result: CodexApprovalProjection;
    try {
      result = projection.projector.projectApproval(
        interaction,
        this.#pluginDescriptors.find(({ id }) => id === thread.harnessId)?.name ??
          approvalServerName(thread.harnessId),
      );
    } catch (error) {
      this.#diagnose(error);
      thread.ignoredInteractionIds.add(interaction.interactionId);
      const denied = await this.#denyApproval(thread, interaction);
      if (!denied) thread.ignoredInteractionIds.delete(interaction.interactionId);
      return;
    }
    for (const message of result.messages) await this.#writer.json(message);

    const requestId = this.#allocateApprovalRequestId();
    const pending: PendingDesktopApproval = {
      thread,
      interaction,
      projection: result.approvalRequest,
    };
    this.#pendingDesktopApprovals.set(requestId, pending);
    try {
      await this.#writer.json({ id: requestId, ...result.approvalRequest.request });
    } catch (error) {
      this.#pendingDesktopApprovals.delete(requestId);
      await this.#denyApproval(thread, interaction);
      throw error;
    }
  }

  /**
   * Show an official MCP elicitation (for example Computer Use app access) on the external
   * Thread that owns the tool call. The official context's ids are replaced by the Host's.
   */
  async #forwardDesktopElicitation(
    threadId: string,
    turnId: string,
    params: JsonObject,
  ): Promise<JsonObject> {
    const requestId = this.#allocateApprovalRequestId();
    const answer = new Promise<JsonObject>((resolve) =>
      this.#pendingDesktopElicitations.set(requestId, resolve),
    );
    this.#traceNativePicker({
      event: "desktop-tools/elicitation-forwarded",
      mode: typeof params.mode === "string" ? params.mode : null,
    });
    try {
      await this.#writer.json({
        id: requestId,
        method: "mcpServer/elicitation/request",
        params: { ...params, threadId, turnId },
      });
    } catch (error) {
      this.#pendingDesktopElicitations.delete(requestId);
      throw error;
    }
    return answer;
  }

  #handleDesktopElicitationResponse(value: JsonValue): boolean {
    if (!isRecord(value) || !isHostApprovalRequestId(value.id)) return false;
    const resolve = this.#pendingDesktopElicitations.get(value.id);
    if (!resolve) return false;
    this.#pendingDesktopElicitations.delete(value.id);
    // A transport error is a cancellation; only an explicit answer may decline.
    resolve(isRecord(value.result) ? value.result : { action: "cancel" });
    return true;
  }

  async #handleDesktopApprovalResponse(value: JsonValue): Promise<boolean> {
    if (!isRecord(value) || !isHostApprovalRequestId(value.id)) return false;
    const requestId = value.id;
    const pending = this.#pendingDesktopApprovals.get(requestId);
    if (!pending) return true;
    return this.#externalRuntime.idleRelease.runOperation(pending.thread.id, async () => {
      if (
        this.#externalRuntime.get(pending.thread.id) !== pending.thread ||
        this.#externalRuntime.idleRelease.failure(pending.thread)
      )
        return true;
      this.#pendingDesktopApprovals.delete(requestId);

      let response: HostApprovalResponse;
      try {
        response =
          "error" in value
            ? pending.projection.denyResponse
            : pending.projection.parseResponse(value.result);
      } catch (error) {
        this.#diagnose(error);
        response = pending.projection.denyResponse;
      }
      const result = await pending.thread.session.execute({
        type: "interaction.respond",
        interactionId: pending.interaction.interactionId,
        response,
      });
      if (!result.ok && result.error.code !== "invalidState") {
        this.#diagnose(`Approval response failed: ${result.error.message}`);
        const cancelled = await pending.thread.session.execute({
          type: "turn.cancel",
          turnId: pending.interaction.turnId,
        });
        if (!cancelled.ok && cancelled.error.code !== "invalidState") {
          this.#diagnose(`Approval fail-closed cancellation failed: ${cancelled.error.message}`);
        }
      }
      return true;
    });
  }

  async #denyApproval(
    thread: ExternalThread,
    interaction: HostApprovalInteraction,
  ): Promise<boolean> {
    const denyActions = interaction.actions.filter(({ effect }) => effect === "deny");
    if (denyActions.length !== 1) {
      const cancelled = await thread.session.execute({
        type: "turn.cancel",
        turnId: interaction.turnId,
      });
      if (!cancelled.ok) {
        this.#diagnose(`Unsupported Approval cancellation failed: ${cancelled.error.message}`);
      }
      return cancelled.ok;
    }
    const action = denyActions[0];
    if (!action) return false;
    const denied = await thread.session.execute({
      type: "interaction.respond",
      interactionId: interaction.interactionId,
      response: { type: "approval", actionId: action.id },
    });
    if (!denied.ok) {
      this.#diagnose(`Unsupported Approval denial failed: ${denied.error.message}`);
    }
    return denied.ok;
  }

  async #resolveDesktopApproval(interactionId: HostInteractionId): Promise<void> {
    for (const [requestId, pending] of this.#pendingDesktopApprovals) {
      if (pending.interaction.interactionId !== interactionId) continue;
      this.#pendingDesktopApprovals.delete(requestId);
      await this.#writer.json({
        method: "serverRequest/resolved",
        params: { threadId: pending.thread.id, requestId },
      });
    }
  }

  #allocateApprovalRequestId(): HostApprovalRequestId {
    if (this.#nextApprovalRequestId < HOST_APPROVAL_REQUEST_ID_MIN) {
      throw new Error("Host Approval Request ID namespace is exhausted");
    }
    const requestId = this.#nextApprovalRequestId;
    this.#nextApprovalRequestId -= 1;
    return requestId;
  }

  async #projectQuestion(
    thread: ExternalThread,
    interaction: HostQuestionInteraction,
  ): Promise<void> {
    const projection = this.#projectedTurn(thread, interaction.turnId);
    await this.#waitForTurnResponse(thread, interaction.turnId);
    let result: CodexQuestionProjection;
    try {
      result = projection.projector.projectQuestion(
        interaction,
        hostItemIdSchema.parse(randomUUID()),
      );
    } catch (error) {
      this.#diagnose(error);
      thread.ignoredInteractionIds.add(interaction.interactionId);
      const cancelled = await thread.session.execute({
        type: "interaction.respond",
        interactionId: interaction.interactionId,
        response: { type: "question", answers: {}, cancelled: true },
      });
      if (!cancelled.ok) {
        thread.ignoredInteractionIds.delete(interaction.interactionId);
        this.#diagnose(`Unsupported Question cancellation failed: ${cancelled.error.message}`);
      }
      return;
    }
    for (const message of result.messages) await this.#writer.json(message);

    const requestId = this.#allocateQuestionRequestId();
    const expiresAtMs = interaction.expiresAt ? Date.parse(interaction.expiresAt) : Number.NaN;
    const timeoutMs = Number.isFinite(expiresAtMs) ? Math.max(0, expiresAtMs - Date.now()) : null;
    const pending: PendingDesktopQuestion = {
      thread,
      interaction,
      projection: result.questionRequest,
      timeout: null,
    };
    if (timeoutMs !== null) {
      pending.timeout = setTimeout(() => {
        void this.#cancelExpiredQuestion(requestId).catch((error) => this.#diagnose(error));
      }, timeoutMs);
    }
    this.#pendingDesktopQuestions.set(requestId, pending);
    try {
      await this.#writer.json({ id: requestId, ...result.questionRequest.request });
    } catch (error) {
      this.#retireDesktopQuestion(interaction.interactionId);
      await thread.session
        .execute({
          type: "interaction.respond",
          interactionId: interaction.interactionId,
          response: { type: "question", answers: {}, cancelled: true },
        })
        .catch(() => undefined);
      throw error;
    }
  }

  async #handleDesktopQuestionResponse(value: JsonValue): Promise<boolean> {
    if (!isRecord(value) || !isHostQuestionRequestId(value.id)) return false;
    const requestId = value.id;
    const pending = this.#pendingDesktopQuestions.get(requestId);
    if (!pending) return true;
    return this.#externalRuntime.idleRelease.runOperation(pending.thread.id, async () => {
      if (
        this.#externalRuntime.get(pending.thread.id) !== pending.thread ||
        this.#externalRuntime.idleRelease.failure(pending.thread)
      )
        return true;
      this.#pendingDesktopQuestions.delete(requestId);
      if (pending.timeout) clearTimeout(pending.timeout);

      let response;
      try {
        response =
          "error" in value
            ? { type: "question" as const, answers: {}, cancelled: true as const }
            : pending.projection.parseResponse(value.result);
      } catch (error) {
        this.#diagnose(error);
        response = { type: "question" as const, answers: {}, cancelled: true as const };
      }
      const result = await pending.thread.session.execute({
        type: "interaction.respond",
        interactionId: pending.interaction.interactionId,
        response,
      });
      if (!result.ok && result.error.code !== "invalidState") {
        this.#diagnose(`Question response failed: ${result.error.message}`);
      }
      return true;
    });
  }

  async #cancelExpiredQuestion(requestId: HostQuestionRequestId): Promise<void> {
    const pending = this.#pendingDesktopQuestions.get(requestId);
    if (!pending) return;
    await this.#externalRuntime.idleRelease.runOperation(pending.thread.id, async () => {
      if (
        this.#externalRuntime.get(pending.thread.id) !== pending.thread ||
        this.#externalRuntime.idleRelease.failure(pending.thread)
      )
        return;
      await this.#resolveDesktopQuestion(pending.interaction.interactionId);
      const result = await pending.thread.session.execute({
        type: "interaction.respond",
        interactionId: pending.interaction.interactionId,
        response: { type: "question", answers: {}, cancelled: true },
      });
      if (!result.ok && result.error.code !== "invalidState") {
        this.#diagnose(`Question expiry failed: ${result.error.message}`);
      }
    });
  }

  #retireDesktopQuestion(interactionId: HostInteractionId): void {
    for (const [requestId, pending] of this.#pendingDesktopQuestions) {
      if (pending.interaction.interactionId !== interactionId) continue;
      if (pending.timeout) clearTimeout(pending.timeout);
      this.#pendingDesktopQuestions.delete(requestId);
    }
  }

  async #resolveDesktopQuestion(interactionId: HostInteractionId): Promise<void> {
    for (const [requestId, pending] of this.#pendingDesktopQuestions) {
      if (pending.interaction.interactionId !== interactionId) continue;
      if (pending.timeout) clearTimeout(pending.timeout);
      this.#pendingDesktopQuestions.delete(requestId);
      await this.#writer.json({
        method: "serverRequest/resolved",
        params: { threadId: pending.thread.id, requestId },
      });
    }
  }

  #allocateQuestionRequestId(): HostQuestionRequestId {
    if (this.#nextQuestionRequestId < HOST_QUESTION_REQUEST_ID_MIN) {
      throw new Error("Host Question Request ID namespace is exhausted");
    }
    const requestId = this.#nextQuestionRequestId;
    this.#nextQuestionRequestId -= 1;
    return requestId;
  }

  async #setThreadStatus(thread: ExternalThread, status: ExternalThreadStatus): Promise<void> {
    thread.thread.status = status;
    await this.#writer.json({
      method: "thread/status/changed",
      emittedAtMs: Date.now(),
      params: { threadId: thread.id, status },
    });
  }

  #projectedTurn(thread: ExternalThread, turnId: HostTurnId): ProjectedTurn {
    const projection = thread.projectedTurns.get(turnId);
    if (!projection) throw new Error("Harness output references an unknown Host Turn");
    return projection;
  }

  async #waitForTurnResponse(thread: ExternalThread, turnId: HostTurnId): Promise<void> {
    await thread.responseGates.get(turnId)?.promise;
  }

  #latestCompletedTurnId(thread: ExternalThread): HostTurnId | null {
    const parsed = hostTurnIdSchema.safeParse(thread.turns.at(-1)?.id);
    return parsed.success ? parsed.data : null;
  }

  #isKnownExternalTurn(thread: ExternalThread, turnId: HostTurnId): boolean {
    return thread.projectedTurns.has(turnId) || thread.turns.some((turn) => turn.id === turnId);
  }

  /**
   * The Desktop's native context ring reads `thread/tokenUsage/updated`, which needs the context
   * window. A Harness learns it only from an explicit refresh, so the Host asks at the points
   * where the value changes. Best effort: a Session without `refreshUsage` shows no ring.
   */
  #refreshExternalUsage(thread: ExternalThread, reason: string): void {
    const refresh = thread.session.refreshUsage;
    if (!refresh) return;
    void refresh.call(thread.session).then(
      () =>
        this.#traceNativePicker({
          event: "usage/refresh",
          reason,
          harnessId: thread.harnessId,
          contextKnown:
            thread.latestUsage?.contextUsedTokens !== undefined &&
            thread.latestUsage.contextWindowTokens !== undefined,
        }),
      (error: unknown) => this.#diagnose(error),
    );
  }

  async #replayExternalUsage(thread: ExternalThread): Promise<void> {
    this.#refreshExternalUsage(thread, "thread.opened");
    const latestTurnId = this.#latestCompletedTurnId(thread);
    if (!latestTurnId || !thread.latestUsage) return;
    thread.usageTurnId = latestTurnId;
    await this.#writeExternalUsage(thread, latestTurnId);
  }

  async #writeExternalUsage(thread: ExternalThread, turnId: HostTurnId): Promise<void> {
    const usage = thread.latestUsage;
    if (!usage || this.#externalRuntime.get(thread.id) !== thread) return;
    const projection = projectCodexThreadUsage({ threadId: thread.id, turnId, usage });
    if (!projection) return;
    await this.#waitForTurnResponse(thread, turnId);
    if (
      this.#externalRuntime.get(thread.id) !== thread ||
      thread.latestUsage !== usage ||
      thread.usageTurnId !== turnId
    ) {
      return;
    }
    await this.#writer.json(projection);
    this.#traceNativePicker({
      event: "thread/tokenUsage/updated",
      harnessId: thread.harnessId,
      contextUsedTokens: usage.contextUsedTokens ?? null,
      contextWindowTokens: usage.contextWindowTokens ?? null,
    });
  }

  #dispatchDesktopRequest(run: () => Promise<void>, threadId?: string): void {
    const task = threadId ? this.#externalRuntime.idleRelease.runOperation(threadId, run) : run();
    void task.catch((error) => this.#diagnose(error));
  }

  #diagnose(error: unknown): void {
    this.#options.diagnosticOutput.write(`codexhost Host Runtime: ${errorMessage(error)}\n`);
  }
}
