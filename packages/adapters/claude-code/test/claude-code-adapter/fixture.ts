import { vi } from "vitest";
import { hostTurnIdSchema } from "@claude-in-codex/shared-contracts";

import type { HarnessOutput, HarnessSession } from "@claude-in-codex/harness-adapter";
import { ClaudeCodeAdapter, type ClaudeCodeAdapterOptions } from "../../src/index.js";
import type { ClaudePermissionMode } from "../../src/permission-modes.js";
import type {
  ClaudeAdapterDependencies,
  ClaudeApprovalRequest,
  ClaudeAutonomousTurnHandler,
  ClaudeIdleTurnHandler,
  ClaudeInteractionResponse,
  ClaudePlanLimitEvent,
  ClaudeQuestionRequest,
  ClaudeTransportContextUsage,
  ClaudeTransportTurnResult,
  ClaudeTurnEvent,
  ClaudeTurnTransport,
} from "../../src/transport.js";

export class FakeClaudeTransport implements ClaudeTurnTransport {
  readonly sessionId: string;
  autonomousTurnHandler: ClaudeAutonomousTurnHandler | null = null;
  idleHandler: ClaudeIdleTurnHandler | null = null;
  threadHandler: ((event: ClaudeTurnEvent) => void) | null = null;
  idleLive = false;
  setAutonomousTurnHandler(handler: ClaudeAutonomousTurnHandler | null): void {
    this.autonomousTurnHandler = handler;
  }
  /** Streams a Segment Claude started on its own: start, its events, then its Terminal. */
  autonomous(turn: {
    nativeTurnKey: string;
    events: ClaudeTurnEvent[];
    result: ClaudeTransportTurnResult;
  }): void {
    const handler = this.autonomousTurnHandler;
    if (!handler) return;
    handler.onStart(turn.nativeTurnKey);
    for (const event of turn.events) handler.onEvent(event);
    handler.onTerminal(turn.result);
  }
  setIdleTurnHandler(handler: ClaudeIdleTurnHandler | null): void {
    this.idleHandler = handler;
  }
  setThreadEventHandler(handler: ((event: ClaudeTurnEvent) => void) | null): void {
    this.threadHandler = handler;
  }
  setIdleLive(live: boolean): void {
    this.idleLive = live;
  }
  readonly abort = vi.fn(async () => undefined);
  readonly stopTask = vi.fn<(id: string) => Promise<void>>(async () => undefined);
  readonly close = vi.fn(async () => undefined);
  contextUsage: ClaudeTransportContextUsage | null = null;
  permissionMode: ClaudePermissionMode;
  readonly #onPermissionModeChanged: (permissionMode: ClaudePermissionMode) => void;
  readonly getContextUsage = vi.fn(
    async (): Promise<ClaudeTransportContextUsage | null> => this.contextUsage,
  );
  readonly setModel = vi.fn(async () => undefined);
  readonly setThinkingOption = vi.fn(async () => undefined);
  readonly getPermissionMode = vi.fn(() => this.permissionMode);
  readonly setPermissionMode = vi.fn(async (permissionMode: ClaudePermissionMode) => {
    this.permissionMode = permissionMode;
  });
  readonly respondToInteraction = vi.fn(async (response: ClaudeInteractionResponse) => {
    this.event({
      type: "interaction.closed",
      requestId: response.requestId,
      reason: "cancelled" in response ? "cancelled" : "responded",
    });
  });
  readonly start = vi.fn(async () => undefined);
  readonly compactCalls: Array<{ userMessageId: string; customInstructions: string | undefined }> =
    [];
  readonly initCalls: string[] = [];
  readonly recapCalls: string[] = [];
  readonly turns: Array<{ text: string; userMessageId: string }> = [];
  #assistantMessageId: string | null = null;
  #active:
    | {
        onEvent(event: ClaudeTurnEvent): void;
        resolve(result: ClaudeTransportTurnResult): void;
        reject(error: unknown): void;
      }
    | undefined;

  readonly #onPlanLimit: (planLimit: ClaudePlanLimitEvent) => void;

  constructor(
    sessionId: string,
    permissionMode: ClaudePermissionMode,
    onPermissionModeChanged: (permissionMode: ClaudePermissionMode) => void,
    onPlanLimit: (planLimit: ClaudePlanLimitEvent) => void,
  ) {
    this.sessionId = sessionId;
    this.permissionMode = permissionMode;
    this.#onPermissionModeChanged = onPermissionModeChanged;
    this.#onPlanLimit = onPlanLimit;
  }

  changePermissionMode(permissionMode: ClaudePermissionMode): void {
    this.permissionMode = permissionMode;
    this.#onPermissionModeChanged(permissionMode);
  }

  planLimit(planLimit: ClaudePlanLimitEvent): void {
    this.#onPlanLimit(planLimit);
  }

  compact(
    userMessageId: string,
    customInstructions: string | undefined,
    onEvent: (event: ClaudeTurnEvent) => void,
  ): Promise<ClaudeTransportTurnResult> {
    this.compactCalls.push({ userMessageId, customInstructions });
    return this.#beginCommandTurn(onEvent);
  }

  init(
    userMessageId: string,
    onEvent: (event: ClaudeTurnEvent) => void,
  ): Promise<ClaudeTransportTurnResult> {
    this.initCalls.push(userMessageId);
    return this.#beginCommandTurn(onEvent);
  }

  recap(
    userMessageId: string,
    onEvent: (event: ClaudeTurnEvent) => void,
  ): Promise<ClaudeTransportTurnResult> {
    this.recapCalls.push(userMessageId);
    return this.#beginCommandTurn(onEvent);
  }

  #beginCommandTurn(onEvent: (event: ClaudeTurnEvent) => void): Promise<ClaudeTransportTurnResult> {
    this.#assistantMessageId = null;
    return new Promise((resolve, reject) => {
      this.#active = { onEvent, resolve, reject };
    });
  }

  runTurn(
    text: string,
    userMessageId: string,
    onEvent: (event: ClaudeTurnEvent) => void,
  ): Promise<ClaudeTransportTurnResult> {
    this.turns.push({ text, userMessageId });
    this.#assistantMessageId = null;
    return new Promise((resolve, reject) => {
      this.#active = { onEvent, resolve, reject };
    });
  }

  event(event: ClaudeTurnEvent): void {
    if (this.#active) {
      this.#active.onEvent(event);
      return;
    }
    if (this.idleLive && this.idleHandler) {
      this.idleHandler.onEvent(event);
      return;
    }
    throw new Error("No active fake Claude Turn");
  }

  threadEvent(event: ClaudeTurnEvent): void {
    this.threadHandler?.(event);
  }

  approval(request: ClaudeApprovalRequest): void {
    this.event({ type: "interaction.requested", request });
  }

  question(request: ClaudeQuestionRequest): void {
    this.event({ type: "interaction.requested", request });
  }

  delta(text: string, messageId = this.#assistantMessageId ?? "synthetic-assistant"): void {
    this.#assistantMessageId = messageId;
    this.event({ type: "text.delta", messageId, delta: text });
  }

  reasoning(messageId: string, delta: string): void {
    this.#assistantMessageId = messageId;
    this.event({ type: "reasoning.delta", messageId, delta });
  }

  completeReasoning(messageId: string): void {
    this.event({ type: "reasoning.completed", messageId });
  }

  finish(result: ClaudeTransportTurnResult): void {
    if (this.#active) {
      this.#active.resolve(result);
      this.#active = undefined;
      this.#assistantMessageId = null;
      return;
    }
    if (this.idleLive && this.idleHandler) {
      this.idleHandler.onTerminal(result);
      this.#assistantMessageId = null;
      return;
    }
    throw new Error("No active fake Claude Turn");
  }

  fault(error: unknown): void {
    this.#active?.reject(error);
    this.#active = undefined;
    this.#assistantMessageId = null;
  }
}

export function fixture(options: ClaudeCodeAdapterOptions = {}) {
  const history: unknown[] = [];
  const transports: FakeClaudeTransport[] = [];
  const inspectors: Array<{
    close: ReturnType<typeof vi.fn>;
    inspect: ReturnType<typeof vi.fn>;
  }> = [];
  const inspectInstallation = vi.fn();
  let uuid = 0;
  const dependencies: ClaudeAdapterDependencies = {
    randomUUID: () => `claude-id-${++uuid}`,
    inspectInstallation,
    createInspector: vi.fn(() => {
      const inspector = {
        close: vi.fn(async () => undefined),
        inspect: vi.fn(async () => ({
          models: [
            {
              value: "default",
              displayName: "Default",
              description: "ignored",
              resolvedModel: "runtime-default",
              supportsAutoMode: true,
            },
            {
              value: "sonnet",
              displayName: "Family alias",
              description: "ignored",
              resolvedModel: "runtime-custom",
              supportedEffortLevels: ["low", "adaptive-v2", "high"],
            },
          ],
          canSelectModel: true,
          canSelectPermissionMode: true,
        })),
      };
      inspectors.push(inspector);
      return inspector;
    }),
    deleteSession: vi.fn(async () => undefined),
    forkSession: vi.fn(async () => ({ sessionId: "derived-session" })),
    getSessionInfo: vi.fn(async () => ({ cwd: "/synthetic" })),
    readSessionMessages: vi.fn(async () => structuredClone(history)),
    readSubagentMessages: vi.fn(async () => []),
    createTransport: vi.fn((input) => {
      const transport = new FakeClaudeTransport(
        input.sessionId,
        input.permissionMode,
        input.onPermissionModeChanged,
        input.onPlanLimit,
      );
      transports.push(transport);
      return transport;
    }),
  };
  const adapter = new ClaudeCodeAdapter(
    { closeTimeoutMs: 50, continuationQuiescenceMs: 50, cancelTimeoutMs: 5_000, ...options },
    dependencies,
  );
  return { adapter, dependencies, history, inspectors, inspectInstallation, transports };
}

export async function openSession(
  adapter: ClaudeCodeAdapter,
  environment?: NodeJS.ProcessEnv,
): Promise<HarnessSession> {
  const opened = await adapter.open({
    kind: "create",
    cwd: "/synthetic",
    ...(environment ? { environment } : {}),
  });
  if (!opened.ok) throw new Error(opened.error.message);
  return opened.value;
}

export function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

export function textTurn(id: string) {
  return {
    type: "turn.start" as const,
    turnId: hostTurnIdSchema.parse(id),
    input: [{ type: "text" as const, text: id }],
  };
}

export async function nextEvent(iterator: AsyncIterator<HarnessOutput>) {
  const output = await iterator.next();
  if (output.done) throw new Error("Harness output ended unexpectedly");
  if (output.value.kind !== "event") throw new Error("Expected a Harness event output");
  return output.value.event;
}

export async function nextInteraction(iterator: AsyncIterator<HarnessOutput>) {
  const output = await iterator.next();
  if (output.done) throw new Error("Harness output ended unexpectedly");
  if (output.value.kind !== "interaction") throw new Error("Expected a Harness Interaction");
  return output.value.interaction;
}
