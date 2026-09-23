import { describe, expect, it, vi } from "vitest";
import type { HostThreadSnapshot } from "@claude-in-codex/harness-adapter";
import { FakeHarnessAdapter } from "@claude-in-codex/harness-adapter/testing";
import type { ExternalHarnessId, JsonObject } from "@claude-in-codex/protocol-core";
import { harnessIdSchema, hostItemIdSchema } from "@claude-in-codex/shared-contracts";

import { createFixture, startPiThread, startPiTurn, stopFixture } from "./fixture.js";
import {
  method,
  requestId,
  requiredMessageId,
  messageParams,
  threadStatus,
  turnEvent,
  writeRequest,
  readJsonLine,
} from "./json-rpc.js";

describe("AppServerHost HarnessAdapter projection", () => {
  it("hydrates the native summary list and preserves Subagent identity through parent history", async () => {
    const fixture = createFixture();
    try {
      const parentId = await startPiThread(fixture);
      const turnId = await startPiTurn(fixture, parentId);
      await fixture.collector.waitFor((message) => turnEvent(message, "turn/started", turnId));
      const session = fixture.adapter.sessions[0];
      if (!session) throw new Error("Missing fixture Session");
      const child = {
        subagentId: "call-child",
        nativeSubagentId: "native-child",
        description: "Summary child",
        role: "explorer",
        background: false,
        status: "running" as const,
      };
      const itemId = session.startSubagentDelegation(child);
      const started = await fixture.collector.waitFor(
        (message) =>
          method(message, "thread/started") &&
          (messageParams(message).thread as JsonObject | undefined)?.parentThreadId === parentId,
      );
      const childId = (messageParams(started).thread as JsonObject).id;
      const list = async (id: number, sourceParams: JsonObject) => {
        writeRequest(fixture.desktopInput, {
          id,
          method: "thread/list",
          params: {
            limit: 200,
            sourceKinds: ["subAgentThreadSpawn"],
            useStateDbOnly: true,
            ...sourceParams,
          },
        });
        const official = await readJsonLine(fixture.official.stdin);
        expect(official.method).toBe("thread/list");
        writeRequest(fixture.official.stdout, {
          id: requiredMessageId(official),
          result: { data: [], nextCursor: null },
        });
        return fixture.collector.waitFor((message) => requestId(message, id));
      };
      expect(await list(90, { ancestorThreadId: parentId })).toMatchObject({
        result: {
          data: [
            {
              id: childId,
              parentThreadId: parentId,
              name: "Summary child",
              agentRole: "explorer",
              status: { type: "active" },
              canAcceptDirectInput: false,
            },
          ],
        },
      });
      session.replaceSubagents(itemId, [{ ...child, status: "completed" }]);
      session.completeItem(itemId, { status: "succeeded" });
      session.succeedTurn();
      await fixture.collector.waitFor((message) => turnEvent(message, "turn/completed", turnId));
      expect(await list(91, { parentThreadId: parentId })).toMatchObject({
        result: {
          data: [
            {
              id: childId,
              status: { type: "idle" },
            },
          ],
        },
      });
      writeRequest(fixture.desktopInput, {
        id: 92,
        method: "thread/turns/list",
        params: {
          threadId: parentId,
          limit: 20,
          itemsView: "full",
        },
      });
      const history = await fixture.collector.waitFor((message) => requestId(message, 92));
      expect(history).toMatchObject({
        result: {
          data: [
            {
              items: expect.arrayContaining([
                expect.objectContaining({
                  type: "collabAgentToolCall",
                  senderThreadId: parentId,
                  receiverThreadIds: [childId],
                }),
              ]),
            },
          ],
        },
      });
      expect(
        (await fixture.mappingStore.listThreads()).filter((record) => record.subagent),
      ).toHaveLength(1);
    } finally {
      await stopFixture(fixture);
    }
  });

  it("materializes a Subagent receiver as a readable Child Host Thread", async () => {
    const base = new FakeHarnessAdapter(harnessIdSchema.parse("pi"));
    let subagentPhase: "started" | "temporarily-empty" | "working" | "completed" = "started";
    const adapter = Object.assign(base, {
      subagents: {
        readSnapshot: vi.fn(async (input: { parent: { nativeSessionId: string } }) => {
          const subagentSnapshot: HostThreadSnapshot = {
            turns:
              subagentPhase === "temporarily-empty"
                ? []
                : [
                    {
                      nativeTurnRef: {
                        harnessId: harnessIdSchema.parse("pi"),
                        nativeSessionId: input.parent.nativeSessionId,
                        nativeTurnKey: "native-subagent-turn",
                        formatVersion: 1,
                      },
                      input:
                        subagentPhase === "started"
                          ? [{ type: "text", text: "Analyze files" }]
                          : [],
                      items:
                        subagentPhase === "started"
                          ? []
                          : [
                              {
                                item: {
                                  type: "commandExecution",
                                  itemId: hostItemIdSchema.parse("subagent-command"),
                                  command: "pwd",
                                  output: "/synthetic",
                                  exitCode: 0,
                                },
                                outcome: { status: "succeeded" },
                              },
                              ...(subagentPhase === "completed"
                                ? [
                                    {
                                      item: {
                                        type: "agentMessage" as const,
                                        itemId: hostItemIdSchema.parse("subagent-answer"),
                                        text: "Analysis complete",
                                      },
                                      outcome: { status: "succeeded" as const },
                                    },
                                  ]
                                : []),
                            ],
                      outcome: { status: "unknown", reason: "Synthetic history" },
                    },
                  ],
          };
          return { ok: true as const, value: subagentSnapshot };
        }),
      },
    });
    const fixture = createFixture({
      externalAdapters: new Map([["pi", adapter]]) as ReadonlyMap<
        ExternalHarnessId,
        FakeHarnessAdapter
      >,
    });
    const threadId = await startPiThread(fixture);
    const turnId = await startPiTurn(fixture, threadId);
    const session = adapter.sessions[0];
    if (!session) throw new Error("Fake Session was not opened");
    await fixture.collector.waitFor((message) => turnEvent(message, "turn/started", turnId));
    const childStartedPromise = fixture.collector.waitFor(
      (message) =>
        method(message, "thread/started") &&
        (messageParams(message).thread as JsonObject | undefined)?.parentThreadId === threadId,
    );
    const itemId = session.startSubagentDelegation({
      subagentId: "agent-call",
      nativeSubagentId: "native-agent-1",
      description: "Analyze files",
      background: false,
      status: "running",
    });
    const childStarted = await childStartedPromise;
    expect(messageParams(childStarted).thread).toMatchObject({
      status: { type: "active" },
      canAcceptDirectInput: false,
    });
    const childThreadId = (messageParams(childStarted).thread as JsonObject).id as string;
    writeRequest(fixture.desktopInput, {
      id: 98,
      method: "thread/turns/list",
      params: { threadId: childThreadId, limit: 20, itemsView: "full" },
    });
    const initialHistory = await fixture.collector.waitFor((message) => requestId(message, 98));
    expect(initialHistory).toMatchObject({
      result: { data: [{ items: [expect.objectContaining({ type: "userMessage" })] }] },
    });

    subagentPhase = "temporarily-empty";
    session.emitSubagentTranscriptChanged("native-agent-1");
    writeRequest(fixture.desktopInput, {
      id: 97,
      method: "thread/turns/list",
      params: { threadId: childThreadId, limit: 20, itemsView: "full" },
    });
    const retainedHistory = await fixture.collector.waitFor((message) => requestId(message, 97));
    expect(retainedHistory).toMatchObject({
      result: { data: [{ items: [expect.objectContaining({ type: "userMessage" })] }] },
    });

    subagentPhase = "working";
    session.emitSubagentTranscriptChanged("native-agent-1");
    const childTurnStarted = await fixture.collector.waitFor(
      (message) =>
        method(message, "turn/started") &&
        messageParams(message).threadId === childThreadId &&
        ((messageParams(message).turn as JsonObject | undefined)?.status as string | undefined) ===
          "inProgress",
    );
    const childTurnStartedIndex = fixture.collector.messages.indexOf(childTurnStarted);
    const childCommandCompleted = await fixture.collector.waitFor(
      (message) =>
        method(message, "item/completed") &&
        messageParams(message).threadId === childThreadId &&
        (messageParams(message).item as JsonObject | undefined)?.type === "commandExecution" &&
        (messageParams(message).item as JsonObject | undefined)?.command === "pwd",
    );
    expect(childTurnStartedIndex).toBeLessThan(
      fixture.collector.messages.indexOf(childCommandCompleted),
    );
    writeRequest(fixture.desktopInput, {
      id: 96,
      method: "thread/turns/list",
      params: { threadId: childThreadId, limit: 20, itemsView: "full" },
    });
    const mergedHistory = await fixture.collector.waitFor((message) => requestId(message, 96));
    expect(mergedHistory).toMatchObject({
      result: {
        data: [
          {
            items: expect.arrayContaining([
              expect.objectContaining({
                type: "userMessage",
                content: [expect.objectContaining({ text: "Analyze files" })],
              }),
              expect.objectContaining({ type: "commandExecution", command: "pwd" }),
            ]),
          },
        ],
      },
    });

    subagentPhase = "completed";
    session.replaceSubagents(itemId, [
      {
        subagentId: "agent-call",
        nativeSubagentId: "native-agent-1",
        description: "Analyze files",
        background: false,
        status: "completed",
        resultSummary: "Analysis complete",
      },
    ]);
    session.completeItem(itemId, { status: "succeeded" });
    session.succeedTurn();
    await fixture.collector.waitFor((message) => turnEvent(message, "turn/completed", turnId));
    expect(
      fixture.collector.messages.filter(
        (message) =>
          method(message, "item/completed") &&
          messageParams(message).threadId === childThreadId &&
          (messageParams(message).item as JsonObject | undefined)?.type === "commandExecution",
      ),
    ).toHaveLength(1);
    await expect(
      fixture.collector.waitFor(
        (message) =>
          method(message, "item/completed") &&
          messageParams(message).threadId === childThreadId &&
          (messageParams(message).item as JsonObject | undefined)?.type === "agentMessage" &&
          (messageParams(message).item as JsonObject | undefined)?.text === "Analysis complete",
      ),
    ).resolves.toBeTruthy();
    await expect(
      fixture.collector.waitFor(
        (message) =>
          method(message, "turn/completed") && messageParams(message).threadId === childThreadId,
      ),
    ).resolves.toBeTruthy();
    await expect(
      fixture.collector.waitFor(
        (message) =>
          method(message, "thread/status/changed") &&
          messageParams(message).threadId === childThreadId &&
          (messageParams(message).status as JsonObject | undefined)?.type === "idle",
      ),
    ).resolves.toBeTruthy();
    const completed = await fixture.collector.waitFor(
      (message) =>
        method(message, "item/completed") &&
        (messageParams(message).item as JsonObject | undefined)?.type === "collabAgentToolCall",
    );
    const completedChildThreadId = (
      (messageParams(completed).item as JsonObject).receiverThreadIds as string[]
    )[0];
    expect(completedChildThreadId).toBe(childThreadId);
    expect(childThreadId).toBeTruthy();
    expect(childThreadId).not.toBe("agent-call");
    if (!childThreadId) throw new Error("Projected Subagent has no Child Thread ID");

    writeRequest(fixture.desktopInput, {
      id: 99,
      method: "thread/turns/list",
      params: { threadId: childThreadId, limit: 20, itemsView: "full" },
    });
    const history = await fixture.collector.waitFor((message) => requestId(message, 99));
    expect(history).toMatchObject({
      result: {
        data: [
          {
            items: expect.arrayContaining([
              expect.objectContaining({
                type: "commandExecution",
                command: "pwd",
                aggregatedOutput: "/synthetic",
              }),
              expect.objectContaining({ type: "agentMessage", text: "Analysis complete" }),
            ]),
          },
        ],
      },
    });
    expect(adapter.subagents.readSnapshot).toHaveBeenCalledWith({
      parent: expect.objectContaining({ nativeSessionId: expect.any(String) }),
      nativeSubagentId: "native-agent-1",
      cwd: "/synthetic",
    });
    await stopFixture(fixture);
  });

  it("keeps the Parent Thread active until all background Subagents settle", async () => {
    const base = new FakeHarnessAdapter(harnessIdSchema.parse("pi"));
    let completed = false;
    const adapter = Object.assign(base, {
      subagents: {
        readSnapshot: vi.fn(async (input: { parent: { nativeSessionId: string } }) => ({
          ok: true as const,
          value: {
            turns: [
              {
                nativeTurnRef: {
                  harnessId: harnessIdSchema.parse("pi"),
                  nativeSessionId: input.parent.nativeSessionId,
                  nativeTurnKey: "background-child-turn",
                  formatVersion: 1,
                },
                input: [{ type: "text", text: "Inspect files" }],
                items: completed
                  ? [
                      {
                        item: {
                          type: "agentMessage" as const,
                          itemId: hostItemIdSchema.parse("background-child-answer"),
                          text: "Inspection complete",
                        },
                        outcome: { status: "succeeded" as const },
                      },
                    ]
                  : [],
                outcome: { status: "unknown" as const, reason: "Background work" },
              },
            ],
          },
        })),
      },
    });
    const fixture = createFixture({
      externalAdapters: new Map([["pi", adapter]]) as ReadonlyMap<
        ExternalHarnessId,
        FakeHarnessAdapter
      >,
    });
    const threadId = await startPiThread(fixture);
    const turnId = await startPiTurn(fixture, threadId);
    const session = adapter.sessions[0];
    if (!session) throw new Error("Fake Session was not opened");
    await fixture.collector.waitFor((message) => turnEvent(message, "turn/started", turnId));
    const childStartedPromise = fixture.collector.waitFor(
      (message) =>
        method(message, "thread/started") &&
        (messageParams(message).thread as JsonObject | undefined)?.parentThreadId === threadId,
    );
    const itemId = session.startSubagentDelegation({
      subagentId: "background-agent-call",
      nativeSubagentId: "native-background-agent",
      description: "Inspect files",
      background: true,
      status: "running",
    });
    const childStarted = await childStartedPromise;
    const childThreadId = (messageParams(childStarted).thread as JsonObject).id as string;
    writeRequest(fixture.desktopInput, {
      id: 95,
      method: "thread/turns/list",
      params: { threadId: childThreadId, limit: 20, itemsView: "full" },
    });
    await fixture.collector.waitFor((message) => requestId(message, 95));
    session.completeItem(itemId, { status: "succeeded" });
    session.succeedTurn();
    await fixture.collector.waitFor((message) => turnEvent(message, "turn/completed", turnId));
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(
      fixture.collector.messages.some((message) => threadStatus(message, threadId, "idle")),
    ).toBe(false);
    expect(
      fixture.collector.messages.some((message) => threadStatus(message, threadId, "active")),
    ).toBe(true);

    completed = true;
    session.emitSubagentState("native-background-agent", "completed", "Inspection complete");
    await expect(
      fixture.collector.waitFor((message) => threadStatus(message, childThreadId, "idle")),
    ).resolves.toBeTruthy();
    await expect(
      fixture.collector.waitFor(
        (message) =>
          method(message, "item/completed") &&
          messageParams(message).threadId === childThreadId &&
          (messageParams(message).item as JsonObject | undefined)?.type === "agentMessage" &&
          (messageParams(message).item as JsonObject | undefined)?.text === "Inspection complete",
      ),
    ).resolves.toBeTruthy();
    await expect(
      fixture.collector.waitFor((message) => threadStatus(message, threadId, "idle")),
    ).resolves.toBeTruthy();
    await stopFixture(fixture);
  });

  it("stops an observed Subagent individually and blocks history edits while children run", async () => {
    const adapter = Object.assign(new FakeHarnessAdapter(harnessIdSchema.parse("pi")), {
      subagents: {
        stop: vi.fn(async () => ({ ok: true as const, value: undefined })),
        readSnapshot: vi.fn(async (input: { parent: { nativeSessionId: string } }) => ({
          ok: true as const,
          value: {
            turns: [
              {
                nativeTurnRef: {
                  harnessId: harnessIdSchema.parse("pi"),
                  nativeSessionId: input.parent.nativeSessionId,
                  nativeTurnKey: "child-turn",
                  formatVersion: 1,
                },
                input: [{ type: "text", text: "Inspect" }],
                items: [],
                outcome: { status: "unknown" as const, reason: "Background work" },
              },
            ],
          },
        })),
      },
    });
    const fixture = createFixture({ externalAdapters: new Map([["pi", adapter]]) });
    try {
      const parentId = await startPiThread(fixture);
      const parentTurnId = await startPiTurn(fixture, parentId);
      const session = adapter.sessions[0];
      if (!session) throw new Error("Fake Session was not opened");
      await fixture.collector.waitFor((m) => turnEvent(m, "turn/started", parentTurnId));
      const delegation = session.startSubagentDelegation({
        subagentId: "call-1",
        nativeSubagentId: "child-1",
        description: "Inspect",
        background: true,
        status: "running",
      });
      const started = await fixture.collector.waitFor(
        (m) =>
          method(m, "thread/started") &&
          (messageParams(m).thread as JsonObject)?.parentThreadId === parentId,
      );
      const childId = (messageParams(started).thread as JsonObject).id as string;
      writeRequest(fixture.desktopInput, {
        id: 980,
        method: "thread/turns/list",
        params: { threadId: childId, limit: 20, itemsView: "full" },
      });
      const history = await fixture.collector.waitFor((m) => requestId(m, 980));
      const childTurnId = ((history.result as JsonObject).data as JsonObject[])[0]?.id;
      if (typeof childTurnId !== "string") throw new Error("Child Turn was not projected");
      writeRequest(fixture.desktopInput, {
        id: 981,
        method: "turn/interrupt",
        params: { threadId: childId, turnId: "stale" },
      });
      expect(await fixture.collector.waitFor((m) => requestId(m, 981))).toHaveProperty("error");
      expect(adapter.subagents.stop).not.toHaveBeenCalled();
      writeRequest(fixture.desktopInput, {
        id: 982,
        method: "turn/interrupt",
        params: { threadId: childId, turnId: childTurnId },
      });
      expect(await fixture.collector.waitFor((m) => requestId(m, 982))).toMatchObject({
        result: {},
      });
      expect(adapter.subagents.stop).toHaveBeenCalledExactlyOnceWith({
        parent: expect.objectContaining({ harnessId: "pi" }),
        nativeSubagentId: "child-1",
        cwd: "/synthetic",
      });
      expect(
        fixture.collector.messages.some((m) => turnEvent(m, "turn/completed", parentTurnId)),
      ).toBe(false);
      session.completeItem(delegation, { status: "succeeded" });
      session.succeedTurn();
      await fixture.collector.waitFor((m) => turnEvent(m, "turn/completed", parentTurnId));
      for (const [id, methodName] of [
        [983, "thread/rollback"],
        [984, "thread/revert"],
      ] as const) {
        writeRequest(fixture.desktopInput, {
          id,
          method: methodName,
          params: {
            threadId: parentId,
            ...(methodName === "thread/revert" ? { beforeTurnId: parentTurnId } : { numTurns: 1 }),
          },
        });
        expect(await fixture.collector.waitFor((m) => requestId(m, id))).toMatchObject({
          error: { code: -32072, message: expect.stringContaining("Background agents") },
        });
      }
      expect(adapter.sessions).toHaveLength(1);
    } finally {
      await stopFixture(fixture);
    }
  });

  it("keeps a Subagent Thread active when it is opened while its Subagent runs", async () => {
    const base = new FakeHarnessAdapter(harnessIdSchema.parse("pi"));
    const adapter = Object.assign(base, {
      subagents: {
        readSnapshot: vi.fn(async (input: { parent: { nativeSessionId: string } }) => ({
          ok: true as const,
          value: {
            turns: [
              {
                nativeTurnRef: {
                  harnessId: harnessIdSchema.parse("pi"),
                  nativeSessionId: input.parent.nativeSessionId,
                  nativeTurnKey: "open-while-running-turn",
                  formatVersion: 1,
                },
                input: [{ type: "text", text: "Inspect files" }],
                items: [],
                outcome: { status: "unknown" as const, reason: "Background work" },
              },
            ],
          },
        })),
      },
    });
    const fixture = createFixture({
      externalAdapters: new Map([["pi", adapter]]) as ReadonlyMap<
        ExternalHarnessId,
        FakeHarnessAdapter
      >,
    });
    const threadId = await startPiThread(fixture);
    const turnId = await startPiTurn(fixture, threadId);
    const session = adapter.sessions[0];
    if (!session) throw new Error("Fake Session was not opened");
    await fixture.collector.waitFor((message) => turnEvent(message, "turn/started", turnId));
    const childStartedPromise = fixture.collector.waitFor(
      (message) =>
        method(message, "thread/started") &&
        (messageParams(message).thread as JsonObject | undefined)?.parentThreadId === threadId,
    );
    session.startSubagentDelegation({
      subagentId: "open-while-running-call",
      nativeSubagentId: "native-open-while-running",
      description: "Inspect files",
      background: true,
      status: "running",
    });
    const childStarted = await childStartedPromise;
    const childThread = messageParams(childStarted).thread as JsonObject;
    const childThreadId = childThread.id as string;
    expect(childThread.status).toEqual({ type: "active", activeFlags: [] });

    writeRequest(fixture.desktopInput, {
      id: 96,
      method: "thread/resume",
      params: { threadId: childThreadId, excludeTurns: true },
    });
    const opened = await fixture.collector.waitFor((message) => requestId(message, 96));
    expect((opened.result as JsonObject).thread).toEqual(
      expect.objectContaining({ id: childThreadId, status: { type: "active", activeFlags: [] } }),
    );
    expect(
      fixture.collector.messages.some((message) => threadStatus(message, childThreadId, "idle")),
    ).toBe(false);

    session.emitSubagentState("native-open-while-running", "completed", "Inspection complete");
    await expect(
      fixture.collector.waitFor((message) => threadStatus(message, childThreadId, "idle")),
    ).resolves.toBeTruthy();
    writeRequest(fixture.desktopInput, {
      id: 97,
      method: "thread/resume",
      params: { threadId: childThreadId, excludeTurns: true },
    });
    const reopened = await fixture.collector.waitFor((message) => requestId(message, 97));
    expect((reopened.result as JsonObject).thread).toEqual(
      expect.objectContaining({ id: childThreadId, status: { type: "idle" } }),
    );
    await stopFixture(fixture);
  });

  it("stays truthful and side-effect free through the Desktop's Subagent view open sequence", async () => {
    const base = new FakeHarnessAdapter(harnessIdSchema.parse("pi"));
    const adapter = Object.assign(base, {
      subagents: {
        readSnapshot: vi.fn(async (input: { parent: { nativeSessionId: string } }) => ({
          ok: true as const,
          value: {
            turns: [
              {
                nativeTurnRef: {
                  harnessId: harnessIdSchema.parse("pi"),
                  nativeSessionId: input.parent.nativeSessionId,
                  nativeTurnKey: "view-open-turn",
                  formatVersion: 1,
                },
                input: [{ type: "text", text: "Inspect files" }],
                items: [],
                outcome: { status: "unknown" as const, reason: "Background work" },
              },
            ],
          },
        })),
      },
    });
    const fixture = createFixture({
      externalAdapters: new Map([["pi", adapter]]) as ReadonlyMap<
        ExternalHarnessId,
        FakeHarnessAdapter
      >,
    });
    const threadId = await startPiThread(fixture);
    const turnId = await startPiTurn(fixture, threadId);
    const session = adapter.sessions[0];
    if (!session) throw new Error("Fake Session was not opened");
    await fixture.collector.waitFor((message) => turnEvent(message, "turn/started", turnId));
    const childStartedPromise = fixture.collector.waitFor(
      (message) =>
        method(message, "thread/started") &&
        (messageParams(message).thread as JsonObject | undefined)?.parentThreadId === threadId,
    );
    const itemId = session.startSubagentDelegation({
      subagentId: "view-open-call",
      nativeSubagentId: "native-view-open",
      description: "Inspect files",
      background: true,
      status: "running",
    });
    const childStarted = await childStartedPromise;
    const childThreadId = (messageParams(childStarted).thread as JsonObject).id as string;
    // The Agent tool returns immediately for a background Agent, so the Parent
    // Turn ends long before the Agent does.
    session.completeItem(itemId, { status: "succeeded" });
    session.succeedTurn();
    await fixture.collector.waitFor((message) => turnEvent(message, "turn/completed", turnId));

    const execute = vi.spyOn(session, "execute");
    const close = vi.spyOn(session, "close");

    // Opening the Subagent view sends metadata read, resume and history paging.
    writeRequest(fixture.desktopInput, {
      id: 120,
      method: "thread/read",
      params: { threadId: childThreadId },
    });
    const metadata = await fixture.collector.waitFor((message) => requestId(message, 120));
    expect((metadata.result as JsonObject).thread).toEqual(
      expect.objectContaining({ id: childThreadId, status: { type: "active", activeFlags: [] } }),
    );
    writeRequest(fixture.desktopInput, {
      id: 121,
      method: "thread/resume",
      params: { threadId: childThreadId, excludeTurns: true },
    });
    const resumed = await fixture.collector.waitFor((message) => requestId(message, 121));
    expect((resumed.result as JsonObject).thread).toEqual(
      expect.objectContaining({ id: childThreadId, status: { type: "active", activeFlags: [] } }),
    );
    writeRequest(fixture.desktopInput, {
      id: 122,
      method: "thread/turns/list",
      params: { threadId: childThreadId, limit: 20, itemsView: "full" },
    });
    const running = await fixture.collector.waitFor((message) => requestId(message, 122));
    expect(running).toMatchObject({
      result: { data: [{ status: "inProgress", completedAt: null }] },
    });
    writeRequest(fixture.desktopInput, {
      id: 123,
      method: "thread/items/list",
      params: { threadId: childThreadId, limit: 20 },
    });
    await fixture.collector.waitFor((message) => requestId(message, 123));

    expect(execute).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    expect(
      fixture.collector.messages.some((message) => threadStatus(message, childThreadId, "idle")),
    ).toBe(false);
    expect(
      fixture.collector.messages.some((message) => threadStatus(message, threadId, "idle")),
    ).toBe(false);

    // Only the real Subagent terminal settles the Agent.
    session.emitSubagentState("native-view-open", "completed", "Inspection complete");
    await expect(
      fixture.collector.waitFor((message) => threadStatus(message, childThreadId, "idle")),
    ).resolves.toBeTruthy();
    writeRequest(fixture.desktopInput, {
      id: 124,
      method: "thread/turns/list",
      params: { threadId: childThreadId, limit: 20, itemsView: "full" },
    });
    const settled = await fixture.collector.waitFor((message) => requestId(message, 124));
    expect(settled).toMatchObject({ result: { data: [{ status: "completed" }] } });
    expect(close).not.toHaveBeenCalled();
    await stopFixture(fixture);
  });
});
