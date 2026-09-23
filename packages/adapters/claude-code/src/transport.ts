import type { HarnessClientTools } from "@codexhost/harness-adapter";
import type {
  HarnessAccountSnapshot,
  HarnessThinkingOptionId,
  JsonValue,
} from "@codexhost/shared-contracts";

import type { ClaudeNativeFileChange } from "./file-change.js";
import type { ClaudeModelInspectionSnapshot } from "./model-catalog.js";
import type { ClaudePermissionMode } from "./permission-modes.js";

export type ClaudeTransportFailureKind =
  "authentication" | "cancellationUnproven" | "native" | "protocol" | "textConflict";

export type ClaudeTransportTurnResult =
  | { status: "succeeded" }
  | { status: "cancelled"; reason: string }
  | { status: "failed"; kind: ClaudeTransportFailureKind };

export interface ClaudeQuestionOption {
  label: string;
  description: string;
}

export interface ClaudeQuestion {
  question: string;
  header: string;
  options: ClaudeQuestionOption[];
  multiSelect: boolean;
}

export type ClaudeApprovalSuggestionScope = "session" | "always";

export interface ClaudeApprovalRequest {
  type: "approval";
  requestId: string;
  title: string;
  description?: string;
  suggestedScope?: ClaudeApprovalSuggestionScope;
}

export interface ClaudeQuestionRequest {
  type: "question";
  requestId: string;
  questions: ClaudeQuestion[];
}

export interface ClaudePlanApprovalRequest {
  type: "planApproval";
  requestId: string;
  /** Full SDK-provided plan text; null means no reviewable plan was provided. */
  plan: string | null;
}

export type ClaudeInteractionRequest =
  ClaudeApprovalRequest | ClaudeQuestionRequest | ClaudePlanApprovalRequest;

export type ClaudeInteractionResponse =
  | {
      type: "approval";
      requestId: string;
      decision: "allowOnce" | "allowForSession" | "allowAlways" | "deny";
    }
  | { type: "question"; requestId: string; answers: Record<string, string> }
  | { type: "question"; requestId: string; cancelled: true };

export interface ClaudeLastRequestUsage {
  requestId?: string;
  model?: string;
  provider?: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

export type ClaudeTurnEvent =
  | { type: "segment.started" }
  | { type: "subagents.live"; nativeSubagentIds: string[] }
  | { type: "compaction.started" }
  | { type: "compaction.completed"; outcome: "succeeded" | "failed" }
  | { type: "text.delta"; messageId: string; delta: string }
  | { type: "reasoning.delta"; messageId: string; delta: string }
  | { type: "reasoning.completed"; messageId: string }
  | {
      type: "message.completed";
      messageId: string;
      checkpointId?: string;
      lastRequestUsage?: ClaudeLastRequestUsage;
    }
  | { type: "tool.started"; callId: string; toolName: string; arguments: JsonValue }
  | { type: "tool.progress"; callId: string; elapsedMs: number }
  | {
      type: "tool.completed";
      callId: string;
      toolName: string;
      outputText?: string;
      structuredResult?: JsonValue;
      isError: boolean;
      fileChange?: ClaudeNativeFileChange;
    }
  | {
      type: "subagent.started";
      callId: string;
      operation: "spawn" | "send";
      description: string;
      prompt?: string;
      role?: string;
      background: boolean;
      nativeSubagentId?: string;
    }
  | {
      type: "subagent.updated";
      callId: string;
      status: "pending" | "running" | "completed" | "failed" | "interrupted";
      description?: string;
      role?: string;
      nativeSubagentId?: string;
      resultSummary?: string;
    }
  | {
      type: "subagent.completed";
      callId: string;
      isError: boolean;
      continuesInBackground?: boolean;
      nativeSubagentId?: string;
      resultSummary?: string;
    }
  | {
      type: "subagent.settled";
      nativeSubagentId: string;
      callId?: string;
      status: "completed" | "failed" | "interrupted";
      resultSummary?: string;
    }
  | { type: "subagent.transcript.changed"; callId: string }
  | { type: "interaction.requested"; request: ClaudeInteractionRequest }
  | {
      type: "interaction.closed";
      requestId: string;
      reason: "responded" | "cancelled" | "superseded";
    }
  | {
      type: "usage.result";
      totalCostUsd?: number;
      modelUsage?: Array<{ inputTokens: number; outputTokens: number }>;
      lastRequestUsage?: ClaudeLastRequestUsage;
    };

export interface ClaudeTransportContextUsage {
  usedTokens: number;
  maxTokens: number;
  model: string;
}

export interface ClaudePlanLimitWindow {
  utilizationPercent: number;
  resetsAtUnix?: number;
}

/**
 * Claude.ai subscription plan-window utilization from stable `rate_limit_event`
 * pushes. Both windows are optional because one event may report either or both.
 */
export interface ClaudePlanLimitEvent {
  fiveHour?: ClaudePlanLimitWindow;
  sevenDay?: ClaudePlanLimitWindow;
}

export interface ClaudeIdleTurnHandler {
  onEvent(event: ClaudeTurnEvent): void;
  onTerminal(result: ClaudeTransportTurnResult): void;
}

/**
 * Receives a Segment that Claude started on its own, such as the Root
 * continuation after a background task notification, while it is streaming.
 * `onStart` fires on the first Root output of the Segment, before that output
 * is delivered through `onEvent`, so the Session is known to be busy while
 * Claude still works. A Segment that never produces Root output never starts.
 * Every `onTerminal` is preceded by `onStart`.
 */
export interface ClaudeAutonomousTurnHandler extends ClaudeIdleTurnHandler {
  onStart(nativeTurnKey: string): void;
}

export interface ClaudeTurnTransport {
  readonly sessionId: string;
  setAutonomousTurnHandler(handler: ClaudeAutonomousTurnHandler | null): void;
  setIdleTurnHandler(handler: ClaudeIdleTurnHandler | null): void;
  /**
   * Receives Thread-level events (Subagent settlements and transcript changes)
   * that arrive while no Turn is open and no autonomous Segment has started.
   * A task-notification Segment may never produce Root output or a Terminal,
   * so these must not wait for one. Once a Segment has started, every event
   * flows through the autonomous handler in native order instead.
   * Without a Thread handler, such events open the autonomous Segment.
   */
  setThreadEventHandler(handler: ((event: ClaudeTurnEvent) => void) | null): void;
  setIdleLive(live: boolean): void;
  start(): Promise<void>;
  getContextUsage(): Promise<ClaudeTransportContextUsage | null>;
  getPermissionMode(): ClaudePermissionMode;
  setModel(model?: string): Promise<void>;
  setThinkingOption(thinkingOptionId: HarnessThinkingOptionId): Promise<void>;
  setPermissionMode(permissionMode: ClaudePermissionMode): Promise<void>;
  compact(
    userMessageId: string,
    customInstructions: string | undefined,
    onEvent: (event: ClaudeTurnEvent) => void,
  ): Promise<ClaudeTransportTurnResult>;
  init(
    userMessageId: string,
    onEvent: (event: ClaudeTurnEvent) => void,
  ): Promise<ClaudeTransportTurnResult>;
  recap(
    userMessageId: string,
    onEvent: (event: ClaudeTurnEvent) => void,
  ): Promise<ClaudeTransportTurnResult>;
  runTurn(
    text: string,
    userMessageId: string,
    onEvent: (event: ClaudeTurnEvent) => void,
  ): Promise<ClaudeTransportTurnResult>;
  respondToInteraction(response: ClaudeInteractionResponse): Promise<void>;
  abort(): Promise<void>;
  stopTask?(nativeSubagentId: string): Promise<void>;
  close(): Promise<void>;
}

export interface ClaudeTransportFactoryInput {
  clientTools?: HarnessClientTools;
  cwd: string;
  environment?: NodeJS.ProcessEnv;
  sessionId: string;
  openMode: "create" | "resume";
  model?: string;
  thinkingOptionId: HarnessThinkingOptionId;
  permissionMode: ClaudePermissionMode;
  onPermissionModeChanged(permissionMode: ClaudePermissionMode): void;
  onFault(error: unknown): void;
  onPlanLimit(planLimit: ClaudePlanLimitEvent): void;
}

export interface ClaudeModelInspector {
  readonly stderrTail?: string;
  inspect(): Promise<ClaudeModelInspectionSnapshot>;
  inspectAccount?(): Promise<HarnessAccountSnapshot | null>;
  close(): Promise<void>;
}

export interface ClaudeModelInspectorFactoryInput {
  cwd: string;
}

export interface ClaudeAdapterDependencies {
  createInspector(input: ClaudeModelInspectorFactoryInput): ClaudeModelInspector;
  createTransport(input: ClaudeTransportFactoryInput): ClaudeTurnTransport;
  deleteSession(input: { cwd: string; sessionId: string }): Promise<void>;
  forkSession(input: {
    checkpointId: string;
    cwd: string;
    sourceSessionId: string;
  }): Promise<{ sessionId: string }>;
  getSessionInfo(input: { sessionId: string }): Promise<{ cwd?: string } | undefined>;
  inspectInstallation(): void;
  readSessionMessages(input: { cwd: string; sessionId: string }): Promise<unknown[]>;
  readSubagentMessages(input: {
    cwd: string;
    sessionId: string;
    nativeSubagentId: string;
  }): Promise<unknown[]>;
  randomUUID(): string;
  /** Mirrors the Session's Claude memory directory into Codex's memory extension; optional. */
  exportMemory?(input: { cwd: string; environment: NodeJS.ProcessEnv }): Promise<unknown>;
}
