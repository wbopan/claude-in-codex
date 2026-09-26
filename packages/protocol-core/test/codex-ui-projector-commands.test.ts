import { describe, expect, it } from "vitest";
import type { HostThreadSnapshot } from "@claude-in-codex/harness-adapter";
import {
  hostItemIdSchema,
  hostTurnIdSchema,
  nativeTurnRefSchema,
} from "@claude-in-codex/shared-contracts";

import { projectHistoricalTurn } from "../src/index.js";

const turnId = hostTurnIdSchema.parse("turn-1");
const itemId = (value: string) => hostItemIdSchema.parse(value);

function projectItems(items: HostThreadSnapshot["turns"][number]["items"]): unknown[] {
  const turn = projectHistoricalTurn({
    turnId,
    cwd: "/workspace",
    snapshot: {
      nativeTurnRef: nativeTurnRefSchema.parse({
        harnessId: "claude-code",
        nativeSessionId: "native",
        nativeTurnKey: "user",
        formatVersion: 1,
      }),
      input: [{ type: "text", text: "go" }],
      items,
      outcome: { status: "cancelled" },
    },
  });
  return (turn.items as unknown[]).slice(1);
}

describe("Codex command projection", () => {
  it("reports success for a finished command without a native exit code", () => {
    expect(
      projectItems([
        {
          item: { type: "commandExecution", itemId: itemId("bash"), command: "ls" },
          outcome: { status: "succeeded" },
        },
      ]),
    ).toMatchObject([{ status: "completed", exitCode: 0 }]);
  });

  it("leaves a stopped command in progress so Desktop shows it as Stopped", () => {
    expect(
      projectItems([
        {
          item: { type: "commandExecution", itemId: itemId("bash"), command: "sleep 9" },
          outcome: { status: "cancelled" },
        },
        {
          item: {
            type: "toolExecution",
            itemId: itemId("read"),
            toolName: "Read",
            arguments: { file_path: "/workspace/a.ts" },
          },
          outcome: { status: "cancelled" },
        },
      ]),
    ).toMatchObject([
      { status: "inProgress", exitCode: null },
      { status: "inProgress", exitCode: null },
    ]);
  });

  it("describes Read and Grep so Desktop groups them as exploration", () => {
    expect(
      projectItems([
        {
          item: {
            type: "toolExecution",
            itemId: itemId("read"),
            toolName: "Read",
            arguments: { file_path: "/workspace/src/a.ts" },
          },
          outcome: { status: "succeeded" },
        },
        {
          item: {
            type: "toolExecution",
            itemId: itemId("grep"),
            toolName: "Grep",
            arguments: { pattern: "TODO", path: "/workspace/src" },
          },
          outcome: { status: "succeeded" },
        },
      ]),
    ).toMatchObject([
      {
        type: "commandExecution",
        exitCode: 0,
        commandActions: [
          {
            type: "read",
            command: "read /workspace/src/a.ts",
            name: "a.ts",
            path: "/workspace/src/a.ts",
          },
        ],
      },
      {
        type: "commandExecution",
        commandActions: [
          {
            type: "search",
            command: "grep TODO /workspace/src",
            query: "TODO",
            path: "/workspace/src",
          },
        ],
      },
    ]);
  });
});
