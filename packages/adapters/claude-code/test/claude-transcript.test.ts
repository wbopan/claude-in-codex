import { appendFile, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { nativeSessionRefSchema } from "@codexhost/shared-contracts";
import { afterEach, describe, expect, it } from "vitest";

import { ClaudeCodeAdapter } from "../src/claude-code-adapter.js";
import { mapClaudeSnapshot } from "../src/claude-history.js";
import { readClaudeTranscript } from "../src/claude-transcript.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

function projectDirectoryName(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/gu, "-");
}

function message(type: "user" | "assistant", uuid: string, content: unknown) {
  return {
    type,
    uuid,
    sessionId: "session-1",
    message: { role: type, content },
  };
}

describe("Claude transcript reader", () => {
  it.each([
    { project: "/work/project", subdirectory: "" },
    { project: "/work/original-project", subdirectory: "nested/worker" },
  ])(
    "restores every Subagent tool call across attachment records ($subdirectory)",
    async ({ project, subdirectory }) => {
      const configDirectory = await mkdtemp(path.join(os.tmpdir(), "codexhost-claude-"));
      directories.push(configDirectory);
      const cwd = "/work/project";
      const sessionId = "session-1";
      const nativeSubagentId = "native-agent-1";
      const transcriptDirectory = path.join(
        configDirectory,
        "projects",
        projectDirectoryName(project),
        sessionId,
        "subagents",
        subdirectory,
      );
      await mkdir(transcriptDirectory, { recursive: true });
      const file = path.join(transcriptDirectory, `agent-${nativeSubagentId}.jsonl`);
      const entries = [
        { ...message("user", "prompt", "inspect files"), parentUuid: null },
        {
          ...message("assistant", "tool-1", [
            { type: "tool_use", id: "bash-1", name: "Bash", input: { command: "pwd" } },
          ]),
          parentUuid: "prompt",
        },
        {
          ...message("user", "result-1", [
            { type: "tool_result", tool_use_id: "bash-1", content: cwd },
          ]),
          parentUuid: "tool-1",
        },
        { type: "attachment", uuid: "attachment-1", parentUuid: "result-1" },
        {
          ...message("assistant", "thinking", [{ type: "thinking", thinking: "Read the file." }]),
          parentUuid: "attachment-1",
        },
        {
          ...message("assistant", "tool-2", [
            { type: "tool_use", id: "read-1", name: "Read", input: { file_path: "README.md" } },
          ]),
          parentUuid: "thinking",
        },
        {
          ...message("user", "result-2", [
            { type: "tool_result", tool_use_id: "read-1", content: "Project documentation" },
          ]),
          parentUuid: "tool-2",
        },
        { type: "attachment", uuid: "attachment-2", parentUuid: "result-2" },
        {
          ...message("assistant", "answer", [{ type: "text", text: "Inspection complete." }]),
          parentUuid: "attachment-2",
        },
      ];
      await writeFile(file, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");

      const environment = { CLAUDE_CONFIG_DIR: configDirectory };
      const transcript = await readClaudeTranscript({
        cwd,
        environment,
        sessionId,
        nativeSubagentId,
      });
      expect(transcript).toEqual(
        entries
          .filter((entry) => entry.type !== "attachment")
          .map((entry) => ({ ...entry, session_id: sessionId })),
      );

      // Exercise the production dependency wiring as well as the reader and history projection.
      const adapter = new ClaudeCodeAdapter({ environment });
      const input = {
        cwd,
        nativeSubagentId,
        parent: nativeSessionRefSchema.parse({
          harnessId: "claude-code",
          nativeSessionId: sessionId,
          formatVersion: 1,
        }),
      };
      try {
        const snapshot = await adapter.subagents.readSnapshot(input);
        expect(snapshot).toMatchObject({
          ok: true,
          value: {
            turns: [
              {
                input: [{ type: "text", text: "inspect files" }],
                items: [
                  { item: { type: "commandExecution", command: "pwd", output: cwd } },
                  { item: { type: "reasoning", text: "Read the file." } },
                  {
                    item: {
                      type: "toolExecution",
                      toolName: "Read",
                      output: { content: [{ type: "text", text: "Project documentation" }] },
                    },
                  },
                  { item: { type: "agentMessage", text: "Inspection complete." } },
                ],
              },
            ],
          },
        });

        // A live append must retain the earlier items and their identities.
        await appendFile(
          file,
          JSON.stringify({
            ...message("assistant", "later", [{ type: "text", text: "Additional finding." }]),
            parentUuid: "answer",
          }) +
            "\n" +
            '{"type":"assistant"',
        );
        const refreshed = await adapter.subagents.readSnapshot(input);
        expect(refreshed.ok).toBe(true);
        if (!snapshot.ok || !refreshed.ok) throw new Error("Subagent history failed to load");
        expect(refreshed.value.turns[0]?.items.slice(0, 4)).toEqual(snapshot.value.turns[0]?.items);
        expect(refreshed.value.turns[0]?.items[4]?.item).toMatchObject({
          type: "agentMessage",
          text: "Additional finding.",
        });
      } finally {
        await adapter.close();
      }
    },
  );

  it("does not substitute a parent transcript when the Subagent transcript is absent", async () => {
    const configDirectory = await mkdtemp(path.join(os.tmpdir(), "codexhost-claude-"));
    directories.push(configDirectory);
    const cwd = "/work/project";
    const directory = path.join(configDirectory, "projects", projectDirectoryName(cwd));
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, "session-1.jsonl"),
      JSON.stringify(message("user", "parent", "parent prompt")),
    );
    expect(
      await readClaudeTranscript({
        cwd,
        environment: { CLAUDE_CONFIG_DIR: configDirectory },
        sessionId: "session-1",
        nativeSubagentId: "missing",
      }),
    ).toBeNull();
  });

  it("reads all main-session messages in append order instead of following one parent branch", async () => {
    const configDirectory = await mkdtemp(path.join(os.tmpdir(), "codexhost-claude-"));
    directories.push(configDirectory);
    const cwd = "/work/project";
    const transcriptDirectory = path.join(configDirectory, "projects", projectDirectoryName(cwd));
    await mkdir(transcriptDirectory, { recursive: true });
    await writeFile(
      path.join(transcriptDirectory, "session-1.jsonl"),
      [
        message("user", "user-1", "first prompt"),
        message("assistant", "assistant-1", [{ type: "text", text: "first response" }]),
        {
          type: "system",
          uuid: "system-1",
          parentUuid: "user-1",
        },
        message("user", "user-2", "second prompt"),
        message("assistant", "assistant-2", [{ type: "text", text: "second response" }]),
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n"),
      "utf8",
    );

    const transcript = await readClaudeTranscript({
      cwd,
      environment: { CLAUDE_CONFIG_DIR: configDirectory },
      sessionId: "session-1",
    });

    expect(transcript).toEqual([
      {
        ...message("user", "user-1", "first prompt"),
        session_id: "session-1",
      },
      {
        ...message("assistant", "assistant-1", [{ type: "text", text: "first response" }]),
        session_id: "session-1",
      },
      {
        ...message("user", "user-2", "second prompt"),
        session_id: "session-1",
      },
      {
        ...message("assistant", "assistant-2", [{ type: "text", text: "second response" }]),
        session_id: "session-1",
      },
    ]);
    expect(transcript && mapClaudeSnapshot(transcript, "session-1").turns).toMatchObject([
      {
        nativeTurnRef: { nativeTurnKey: "user-1" },
        input: [{ type: "text", text: "first prompt" }],
        items: [{ item: { type: "agentMessage", text: "first response" } }],
      },
      {
        nativeTurnRef: { nativeTurnKey: "user-2" },
        input: [{ type: "text", text: "second prompt" }],
        items: [{ item: { type: "agentMessage", text: "second response" } }],
      },
    ]);
  });
});
