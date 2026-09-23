import { describe, expect, it, vi } from "vitest";
import { hostTurnIdSchema } from "@claude-in-codex/shared-contracts";

import type { HarnessOutput } from "@claude-in-codex/harness-adapter";
import { ClaudeCodeAdapter } from "../../src/index.js";
import { ClaudeCodeExecutableError } from "../../src/command.js";
import type { ClaudeAdapterDependencies } from "../../src/transport.js";
import { deferred, fixture, nextEvent, nextInteraction, openSession, textTurn } from "./fixture.js";

describe("Claude Code HarnessAdapter", () => {
  it("maps proven cancellation and continues on the same Transport", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();

    await session.execute(textTurn("cancelled"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    transports[0]?.approval({
      type: "approval",
      requestId: "cancel-request",
      title: "Allow pending native action?",
    });
    const cancelledInteraction = await nextInteraction(iterator);
    const cancel = {
      type: "turn.cancel" as const,
      turnId: hostTurnIdSchema.parse("cancelled"),
    };
    await expect(session.execute(cancel)).resolves.toEqual({
      ok: true,
      value: { cancellationRequested: true },
    });
    await expect(session.execute(cancel)).resolves.toEqual({
      ok: true,
      value: { cancellationRequested: true },
    });
    expect(transports[0]?.abort).toHaveBeenCalledOnce();
    transports[0]?.event({
      type: "interaction.closed",
      requestId: "cancel-request",
      reason: "cancelled",
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "interaction.closed",
      interactionId: cancelledInteraction.interactionId,
      reason: "cancelled",
    });
    transports[0]?.finish({ status: "cancelled", reason: "aborted_streaming" });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: { outcome: { status: "cancelled" } },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "turn.completed",
      outcome: { status: "cancelled" },
    });

    await expect(session.execute(textTurn("continued"))).resolves.toMatchObject({ ok: true });
    await nextEvent(iterator);
    await nextEvent(iterator);
    transports[0]?.finish({ status: "succeeded" });
    await nextEvent(iterator);
    await nextEvent(iterator);
    expect(transports).toHaveLength(1);
    await session.close();
  });

  it("kills a hung interrupt and continues on a resumed Transport", async () => {
    const { adapter, dependencies, transports } = fixture({ cancelTimeoutMs: 20 });
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();

    await session.execute(textTurn("hung"));
    expect((await nextEvent(iterator)).type).toBe("session.state.changed");
    expect((await nextEvent(iterator)).type).toBe("turn.started");
    expect((await nextEvent(iterator)).type).toBe("item.started");
    transports[0]?.abort.mockImplementation(async () => new Promise(() => undefined));

    await expect(
      session.execute({ type: "turn.cancel", turnId: hostTurnIdSchema.parse("hung") }),
    ).resolves.toEqual({
      ok: true,
      value: { cancellationRequested: true },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: { outcome: { status: "cancelled" } },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "turn.completed",
      outcome: { status: "cancelled", reason: "Cancelled by user" },
    });
    expect(transports[0]?.close).toHaveBeenCalled();

    await expect(session.execute(textTurn("after-kill"))).resolves.toMatchObject({ ok: true });
    expect(transports).toHaveLength(2);
    expect(dependencies.createTransport).toHaveBeenLastCalledWith(
      expect.objectContaining({ openMode: "resume" }),
    );
    expect((await nextEvent(iterator)).type).toBe("session.state.changed");
    expect((await nextEvent(iterator)).type).toBe("turn.started");
    expect((await nextEvent(iterator)).type).toBe("item.started");
    transports[1]?.finish({ status: "succeeded" });
    expect((await nextEvent(iterator)).type).toBe("item.completed");
    expect((await nextEvent(iterator)).type).toBe("turn.completed");
    await session.close();
  });

  it("escalates an acked interrupt that never ends the Turn", async () => {
    const { adapter, transports } = fixture({ cancelTimeoutMs: 20 });
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();

    await session.execute(textTurn("acked"));
    expect((await nextEvent(iterator)).type).toBe("session.state.changed");
    expect((await nextEvent(iterator)).type).toBe("turn.started");
    expect((await nextEvent(iterator)).type).toBe("item.started");

    await expect(
      session.execute({ type: "turn.cancel", turnId: hostTurnIdSchema.parse("acked") }),
    ).resolves.toEqual({
      ok: true,
      value: { cancellationRequested: true },
    });
    expect(transports[0]?.abort).toHaveBeenCalledOnce();
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: { outcome: { status: "cancelled" } },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "turn.completed",
      outcome: { status: "cancelled", reason: "Cancelled by user" },
    });
    expect(transports[0]?.close).toHaveBeenCalled();

    await expect(session.execute(textTurn("after-escalate"))).resolves.toMatchObject({ ok: true });
    expect(transports).toHaveLength(2);
    expect((await nextEvent(iterator)).type).toBe("session.state.changed");
    expect((await nextEvent(iterator)).type).toBe("turn.started");
    expect((await nextEvent(iterator)).type).toBe("item.started");
    transports[1]?.finish({ status: "succeeded" });
    expect((await nextEvent(iterator)).type).toBe("item.completed");
    expect((await nextEvent(iterator)).type).toBe("turn.completed");
    await session.close();
  });

  it("keeps an escalated cancellation busy until the old Transport closes", async () => {
    const { adapter, transports } = fixture({ cancelTimeoutMs: 10 });
    const session = await openSession(adapter);
    const events: HarnessOutput[] = [];
    const consuming = (async () => {
      for await (const output of session.outputs) events.push(output);
    })();
    await session.execute(textTurn("retiring"));
    const transport = transports[0];
    if (!transport) throw new Error("Expected an active Transport");
    const stopped = Promise.withResolvers<undefined>();
    transport.close.mockImplementation(() => stopped.promise);
    await session.execute({ type: "turn.cancel", turnId: hostTurnIdSchema.parse("retiring") });
    await vi.waitFor(() => expect(transport.close).toHaveBeenCalled());
    // A late cancelled frame also does not prove that owned processes have exited.
    transport.finish({ status: "cancelled", reason: "aborted_streaming" });
    await Promise.resolve();
    try {
      await expect(session.readSnapshot()).resolves.toMatchObject({
        ok: false,
        error: { code: "sessionBusy" },
      });
      expect(
        events.some((output) => output.kind === "event" && output.event.type === "turn.completed"),
      ).toBe(false);
      await expect(session.execute(textTurn("too-early"))).resolves.toMatchObject({
        ok: false,
        error: { code: "sessionBusy" },
      });
      expect(transports).toHaveLength(1);
    } finally {
      stopped.resolve(undefined);
      await session.close();
      await consuming;
    }
  });

  it("does not confirm Session close while a hard-cancelled Transport is still stopping", async () => {
    const { adapter, transports } = fixture({ cancelTimeoutMs: 10 });
    const session = await openSession(adapter);
    await session.execute(textTurn("retiring-close"));
    const transport = transports[0];
    if (!transport) throw new Error("Expected an active Transport");
    const stopped = Promise.withResolvers<undefined>();
    transport.close.mockImplementation(() => stopped.promise);
    await session.execute({
      type: "turn.cancel",
      turnId: hostTurnIdSchema.parse("retiring-close"),
    });
    await vi.waitFor(() => expect(transport.close).toHaveBeenCalled());
    let closed = false;
    const closing = session.close().then(() => {
      closed = true;
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(closed).toBe(false);
    } finally {
      stopped.resolve(undefined);
      await closing;
    }
  });

  it("retains a failed hard-cancel Transport and rejects reuse and confirmed close", async () => {
    const { adapter, transports } = fixture({ cancelTimeoutMs: 10 });
    const session = await openSession(adapter);
    const events: HarnessOutput[] = [];
    const consuming = (async () => {
      for await (const output of session.outputs) events.push(output);
    })();
    await session.execute(textTurn("failed-close"));
    const transport = transports[0];
    if (!transport) throw new Error("Expected an active Transport");
    transport.close.mockRejectedValue(new Error("native process remains alive"));
    await session.execute({ type: "turn.cancel", turnId: hostTurnIdSchema.parse("failed-close") });
    await vi.waitFor(() => expect(transport.close).toHaveBeenCalled());
    await expect(session.execute(textTurn("unsafe-retry"))).resolves.toMatchObject({ ok: false });
    expect(transports).toHaveLength(1);
    await expect(session.close()).rejects.toThrow("could not stop safely");
    await consuming;
    expect(
      events.some((output) => output.kind === "event" && output.event.type === "session.faulted"),
    ).toBe(true);
  });

  it("maps failed native results without faulting a reusable Session", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();

    await session.execute(textTurn("failed"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    transports[0]?.finish({ status: "failed", kind: "authentication" });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: { outcome: { status: "failed", error: { code: "authenticationRequired" } } },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "turn.completed",
      outcome: { status: "failed", error: { code: "authenticationRequired" } },
    });
    await expect(session.execute(textTurn("retry"))).resolves.toMatchObject({ ok: true });
    transports[0]?.finish({ status: "succeeded" });
    await session.close();
  });

  it("finalizes an active Turn before a Query fault", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();

    await session.execute(textTurn("faulted"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    transports[0]?.approval({
      type: "approval",
      requestId: "fault-request",
      title: "Allow pending native action?",
    });
    await nextInteraction(iterator);
    transports[0]?.fault(new Error("synthetic Query fault"));

    expect(await nextEvent(iterator)).toMatchObject({
      type: "interaction.closed",
      reason: "cancelled",
    });
    expect((await nextEvent(iterator)).type).toBe("item.completed");
    expect((await nextEvent(iterator)).type).toBe("turn.completed");
    expect(await nextEvent(iterator)).toMatchObject({
      type: "session.faulted",
      error: { code: "processExited" },
    });
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
  });

  it("rejects missing installation before acceptance without outputs", async () => {
    const dependencies: ClaudeAdapterDependencies = {
      randomUUID: () => "claude-id",
      inspectInstallation: () => undefined,
      createInspector: () => ({
        inspect: async () => ({
          models: [],
          canSelectModel: false,
          canSelectPermissionMode: false,
        }),
        close: async () => undefined,
      }),
      deleteSession: async () => undefined,
      forkSession: async () => ({ sessionId: "derived-session" }),
      getSessionInfo: async () => ({ cwd: "/synthetic" }),
      readSessionMessages: async () => [],
      readSubagentMessages: async () => [],
      createTransport: () => ({
        sessionId: "claude-id",
        setAutonomousTurnHandler: () => undefined,
        setIdleTurnHandler: () => undefined,
        setThreadEventHandler: () => undefined,
        setIdleLive: () => undefined,
        start: async () => {
          throw new ClaudeCodeExecutableError("Claude Code is not installed");
        },
        getContextUsage: async () => null,
        getPermissionMode: () => "default",
        setModel: async () => undefined,
        setThinkingOption: async () => undefined,
        setPermissionMode: async () => undefined,
        compact: async () => ({ status: "succeeded" }),
        init: async () => ({ status: "succeeded" }),
        recap: async () => ({ status: "succeeded" }),
        runTurn: async () => ({ status: "succeeded" }),
        respondToInteraction: async () => undefined,
        abort: async () => undefined,
        close: async () => undefined,
      }),
    };
    const adapter = new ClaudeCodeAdapter({}, dependencies);
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();

    await expect(session.execute(textTurn("missing"))).resolves.toMatchObject({
      ok: false,
      error: { code: "notInstalled" },
    });
    await session.close();
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
  });

  it("closes an in-flight Inspector before Adapter close resolves", async () => {
    const { adapter, dependencies } = fixture();
    const pending = deferred<{
      models: unknown[];
      canSelectModel: boolean;
      canSelectPermissionMode: boolean;
    }>();
    const close = vi.fn(async () => {
      pending.resolve({
        models: [],
        canSelectModel: false,
        canSelectPermissionMode: false,
      });
    });
    vi.mocked(dependencies.createInspector).mockReturnValueOnce({
      inspect: () => pending.promise,
      close,
    });

    const inspecting = adapter.inspect({ cwd: "/closing" });
    await expect(adapter.close()).resolves.toBeUndefined();
    await expect(inspecting).resolves.toMatchObject({
      status: "unavailable",
      error: { code: "unavailable", retryable: false },
    });
    expect(close).toHaveBeenCalled();
    await expect(adapter.inspect()).resolves.toMatchObject({
      status: "unavailable",
      error: { code: "invalidState" },
    });
  });

  it("closes all Sessions idempotently", async () => {
    const { adapter } = fixture();
    await openSession(adapter);
    await openSession(adapter);

    await expect(Promise.all([adapter.close(), adapter.close()])).resolves.toEqual([
      undefined,
      undefined,
    ]);
  });
});
