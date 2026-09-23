import { describe, expect, it } from "vitest";

import { CodexTurnProjector } from "../src/codex-ui-projector.js";
import {
  hostInteractionIdSchema,
  hostItemIdSchema,
  hostTurnIdSchema,
} from "@claude-in-codex/shared-contracts";

const turnId = hostTurnIdSchema.parse("turn-1");
const itemId = hostItemIdSchema.parse("item-1");

describe("CodexTurnProjector pending Turn", () => {
  it("includes explicitly projected input for an externally started Turn", () => {
    const projector = new CodexTurnProjector({
      threadId: "thread-1",
      turnId,
      cwd: "/synthetic",
      startedAtMs: 1_000,
      initialInput: [{ type: "text", text: "Review auth" }],
    });

    const started = projector.project({ type: "turn.started", turnId });

    expect(started.messages).toMatchObject([
      {
        method: "turn/started",
        params: {
          turn: {
            items: [
              {
                id: `${turnId}-user`,
                type: "userMessage",
                content: [{ type: "text", text: "Review auth", text_elements: [] }],
              },
            ],
          },
        },
      },
    ]);
    expect(projector.pendingTurn()).toMatchObject({
      items: [
        {
          id: `${turnId}-user`,
          type: "userMessage",
          content: [{ type: "text", text: "Review auth", text_elements: [] }],
        },
      ],
    });
  });

  it("includes the current visible Agent message but excludes reasoning activity", () => {
    const projector = new CodexTurnProjector({
      threadId: "thread-1",
      turnId,
      cwd: "/synthetic",
      startedAtMs: 1_000,
    });
    projector.project({ type: "turn.started", turnId });
    projector.project({
      type: "item.started",
      turnId,
      item: { type: "agentMessage", itemId, text: "" },
    });
    projector.project({
      type: "item.updated",
      turnId,
      itemId,
      update: { type: "text.append", text: "Checking auth." },
    });
    const reasoningId = hostItemIdSchema.parse("reasoning-1");
    projector.project({
      type: "item.started",
      turnId,
      item: { type: "reasoning", itemId: reasoningId, text: "hidden" },
    });

    expect(projector.pendingTurn()).toMatchObject({
      status: "inProgress",
      items: [
        {
          id: itemId,
          type: "agentMessage",
          text: "Checking auth.",
        },
      ],
    });
    expect(JSON.stringify(projector.pendingTurn())).not.toContain("hidden");
  });

  it("reports the current activity without any Item content", () => {
    const projector = new CodexTurnProjector({
      threadId: "thread-1",
      turnId,
      cwd: "/synthetic",
      startedAtMs: 1_000,
    });
    expect(projector.activity()).toEqual({ startedAtMs: 1_000, kind: "starting" });
    projector.project({ type: "turn.started", turnId });
    expect(projector.activity().kind).toBe("thinking");
    projector.project({
      type: "item.started",
      turnId,
      item: { type: "commandExecution", itemId, command: "rm -rf secret" },
    });
    expect(projector.activity()).toEqual({ startedAtMs: 1_000, kind: "command" });
    const toolId = hostItemIdSchema.parse("tool-1");
    projector.project({
      type: "item.started",
      turnId,
      item: { type: "toolExecution", itemId: toolId, toolName: "WebSearch", arguments: { q: "x" } },
    });
    expect(projector.activity()).toEqual({
      startedAtMs: 1_000,
      kind: "tool",
      toolName: "WebSearch",
    });
    projector.projectApproval(
      {
        type: "approval",
        interactionId: hostInteractionIdSchema.parse("approval-1"),
        turnId,
        title: "Allow?",
        description: "One-shot",
        subject: { type: "nativeAction" },
        actions: [
          { id: "allow", label: "Allow once", effect: "allowOnce" },
          { id: "reject", label: "Deny", effect: "deny" },
        ],
      },
      "Claude Code",
    );
    expect(projector.activity().kind).toBe("approval");
    projector.project({
      type: "interaction.closed",
      interactionId: hostInteractionIdSchema.parse("approval-1"),
      turnId,
      reason: "responded",
    });
    projector.project({
      type: "item.completed",
      turnId,
      snapshot: {
        item: {
          type: "toolExecution",
          itemId: toolId,
          toolName: "WebSearch",
          arguments: { q: "x" },
        },
        outcome: { status: "succeeded" },
      },
    });
    expect(projector.activity().kind).toBe("command");
    expect(JSON.stringify(projector.activity())).not.toContain("secret");
  });
});
