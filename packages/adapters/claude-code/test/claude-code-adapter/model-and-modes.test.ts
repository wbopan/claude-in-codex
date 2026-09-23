import { describe, expect, it, vi } from "vitest";
import {
  harnessPermissionModeIdSchema,
  harnessThinkingOptionIdSchema,
} from "@claude-in-codex/shared-contracts";

import { ClaudeCodeExecutableError } from "../../src/command.js";
import { CLAUDE_DEFAULT_MODEL_REF, encodeClaudeModelRef } from "../../src/model-catalog.js";
import { deferred, fixture, nextEvent, openSession, textTurn } from "./fixture.js";

describe("Claude Code HarnessAdapter", () => {
  it("inspects the runtime Model catalog and publishes Claude Code Thinking control", async () => {
    const { adapter, dependencies, inspectors } = fixture();

    const first = await adapter.inspect({ cwd: "/synthetic" });
    expect(first).toMatchObject({
      status: "ready",
      catalog: {
        models: [
          {
            ref: CLAUDE_DEFAULT_MODEL_REF,
            label: "Default",
            resolvedModelLabel: "runtime-default",
          },
          { label: "Family alias", resolvedModelLabel: "runtime-custom" },
        ],
        defaultModel: CLAUDE_DEFAULT_MODEL_REF,
        thinkingOptions: [
          { id: "off", label: "Off" },
          { id: "auto", label: "Auto" },
          { id: "low", label: "Low" },
          { id: "medium", label: "Medium" },
          { id: "high", label: "High" },
          { id: "xhigh", label: "Extra High" },
          { id: "max", label: "Max" },
        ],
        defaultThinkingOptionId: "auto",
      },
      permissionModes: {
        defaultModeId: "default",
        modes: [
          { id: "plan" },
          { id: "default" },
          { id: "acceptEdits" },
          { id: "auto" },
          { id: "bypassPermissions", dangerous: true },
        ],
      },
      capabilities: {
        configuration: {
          selectModel: true,
          selectThinkingOption: true,
          selectPermissionMode: true,
        },
        history: { fork: true, forkAcrossCwd: false, rollbackLastTurn: true },
        subagents: { observe: true, readTranscript: true },
      },
    });
    await expect(adapter.inspect({ cwd: "/synthetic" })).resolves.toEqual(first);
    expect(dependencies.createInspector).toHaveBeenCalledOnce();
    expect(inspectors[0]?.close).toHaveBeenCalledOnce();

    await adapter.inspect({ cwd: "/synthetic", refresh: true });
    expect(dependencies.createInspector).toHaveBeenCalledTimes(2);
    expect(dependencies.createTransport).not.toHaveBeenCalled();

    const session = await openSession(adapter);
    expect(session.capabilities).toEqual({
      configuration: {
        selectModel: true,
        selectThinkingOption: true,
        selectPermissionMode: true,
        permissionModeScope: "live",
      },
      history: { fork: true, forkAcrossCwd: false, rollbackLastTurn: true },
      subagents: { observe: true, readTranscript: true },
    });
    const iterator = session.outputs[Symbol.asyncIterator]();
    await expect(
      session.execute({
        type: "thinking.select",
        thinkingOptionId: harnessThinkingOptionIdSchema.parse("high"),
      }),
    ).resolves.toEqual({ ok: true, value: { completed: true } });
    await expect(nextEvent(iterator)).resolves.toMatchObject({
      type: "session.state.changed",
      state: {
        effectiveThinkingOptionId: "high",
        availableThinkingOptions: [
          { id: "off" },
          { id: "auto" },
          { id: "low" },
          { id: "medium" },
          { id: "high" },
          { id: "xhigh" },
          { id: "max" },
        ],
      },
    });
    expect(dependencies.createTransport).not.toHaveBeenCalled();
    const configured = await adapter.open({
      kind: "create",
      cwd: "/synthetic",
      model: encodeClaudeModelRef("sonnet"),
    });
    expect(configured.ok).toBe(true);
    if (configured.ok) await configured.value.close();
    expect(dependencies.createTransport).not.toHaveBeenCalled();
    await session.close();
  });

  it("omits Auto when no runtime Model explicitly supports it", async () => {
    const { adapter, dependencies } = fixture();
    vi.mocked(dependencies.createInspector).mockReturnValueOnce({
      inspect: vi.fn(async () => ({
        models: [{ value: "default", displayName: "Custom Model" }],
        canSelectModel: true,
        canSelectPermissionMode: true,
      })),
      close: vi.fn(async () => undefined),
    });

    await expect(adapter.inspect({ cwd: "/no-auto" })).resolves.toMatchObject({
      status: "ready",
      permissionModes: {
        defaultModeId: "default",
        modes: [
          { id: "plan" },
          { id: "default" },
          { id: "acceptEdits" },
          { id: "bypassPermissions" },
        ],
      },
      capabilities: { configuration: { selectPermissionMode: true } },
    });
  });

  it("coalesces concurrent inspection and does not cache failures or unsupported capability", async () => {
    const { adapter, dependencies } = fixture();
    const pending = deferred<{
      models: unknown[];
      canSelectModel: boolean;
      canSelectPermissionMode: boolean;
    }>();
    const close = vi.fn(async () => undefined);
    vi.mocked(dependencies.createInspector)
      .mockReturnValueOnce({ inspect: () => pending.promise, close })
      .mockReturnValueOnce({
        inspect: async () => {
          throw new Error("synthetic startup failure");
        },
        close,
      })
      .mockReturnValueOnce({
        inspect: async () => ({
          models: [],
          canSelectModel: false,
          canSelectPermissionMode: false,
        }),
        close,
      })
      .mockReturnValueOnce({
        inspect: async () => ({
          models: [],
          canSelectModel: false,
          canSelectPermissionMode: false,
        }),
        close,
      });

    const first = adapter.inspect({ cwd: "/coalesced" });
    const second = adapter.inspect({ cwd: "/coalesced" });
    expect(dependencies.createInspector).toHaveBeenCalledOnce();
    pending.resolve({
      models: [{ value: "default", displayName: "Default" }],
      canSelectModel: true,
      canSelectPermissionMode: true,
    });
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);

    await expect(adapter.inspect({ cwd: "/failure" })).resolves.toMatchObject({
      status: "error",
    });
    await expect(adapter.inspect({ cwd: "/failure" })).resolves.toMatchObject({
      status: "unavailable",
      error: { code: "unavailable", retryable: false },
    });
    await expect(adapter.inspect({ cwd: "/unsupported" })).resolves.toMatchObject({
      status: "unavailable",
      error: { code: "unavailable", retryable: false },
    });
    expect(dependencies.createInspector).toHaveBeenCalledTimes(4);
    expect(close).toHaveBeenCalledTimes(4);
  });

  it("re-inspects the Model catalog after Claude Code is updated", async () => {
    const { adapter, dependencies, inspectInstallation } = fixture();
    inspectInstallation.mockReturnValue("claude-2.1.279");
    await adapter.inspect({ cwd: "/synthetic" });
    await adapter.inspect({ cwd: "/synthetic" });
    expect(dependencies.createInspector).toHaveBeenCalledOnce();

    inspectInstallation.mockReturnValue("claude-2.1.280");
    await adapter.inspect({ cwd: "/synthetic" });
    expect(dependencies.createInspector).toHaveBeenCalledTimes(2);
  });

  it("reports a missing installation without starting a Transport", async () => {
    const { adapter, dependencies, inspectInstallation } = fixture();
    inspectInstallation.mockImplementation(() => {
      throw new ClaudeCodeExecutableError("Claude Code is not installed");
    });

    await expect(adapter.inspect()).resolves.toMatchObject({
      status: "notInstalled",
      error: { code: "notInstalled", retryable: false },
    });
    expect(dependencies.createTransport).not.toHaveBeenCalled();
  });

  it("applies a create-time alias lazily and publishes the configured Model before the Turn", async () => {
    const { adapter, dependencies, transports } = fixture();
    const selected = encodeClaudeModelRef("sonnet");
    const thinkingOptionId = harnessThinkingOptionIdSchema.parse("max");
    const opened = await adapter.open({
      kind: "create",
      cwd: "/synthetic",
      model: selected,
      thinkingOptionId,
    });
    if (!opened.ok) throw new Error(opened.error.message);
    const session = opened.value;
    expect(dependencies.createTransport).not.toHaveBeenCalled();
    const iterator = session.outputs[Symbol.asyncIterator]();

    await expect(session.execute(textTurn("selected-first"))).resolves.toMatchObject({ ok: true });
    expect(dependencies.createTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "sonnet",
        openMode: "create",
        thinkingOptionId: "max",
      }),
    );
    expect(await nextEvent(iterator)).toMatchObject({
      type: "session.state.changed",
      state: {
        effectiveModel: selected,
        effectiveThinkingOptionId: "max",
      },
    });
    expect((await nextEvent(iterator)).type).toBe("turn.started");
    expect((await nextEvent(iterator)).type).toBe("item.started");
    transports[0]?.finish({ status: "succeeded" });
    await nextEvent(iterator);
    await nextEvent(iterator);
    await session.close();
  });

  it("selects an Idle alias and restores default without Model readback", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();
    await session.execute(textTurn("initialize-selection"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    const transport = transports[0];
    if (!transport) throw new Error("Fake Claude transport was not created");
    transport.finish({ status: "succeeded" });
    await nextEvent(iterator);
    await nextEvent(iterator);

    const contextReadsBeforeSelection = transport.getContextUsage.mock.calls.length;
    const alias = encodeClaudeModelRef("sonnet");
    const selectingAlias = session.execute({ type: "model.select", model: alias });
    const aliasState = await nextEvent(iterator);
    expect(aliasState).toMatchObject({
      type: "session.state.changed",
      state: { effectiveModel: alias },
    });
    expect(aliasState).not.toHaveProperty("state.resolvedModelLabel");
    await expect(selectingAlias).resolves.toEqual({ ok: true, value: { completed: true } });
    expect(transport.setModel).toHaveBeenLastCalledWith("sonnet");

    const resetting = session.execute({ type: "model.select", model: CLAUDE_DEFAULT_MODEL_REF });
    const defaultState = await nextEvent(iterator);
    expect(defaultState).toMatchObject({
      type: "session.state.changed",
      state: { effectiveModel: CLAUDE_DEFAULT_MODEL_REF },
    });
    expect(defaultState).not.toHaveProperty("state.resolvedModelLabel");
    await expect(resetting).resolves.toEqual({ ok: true, value: { completed: true } });
    expect(transport.setModel).toHaveBeenLastCalledWith(undefined);
    expect(transport.getContextUsage).toHaveBeenCalledTimes(contextReadsBeforeSelection);
    await session.close();
  });

  it("dynamically switches Thinking on an Idle Query", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();
    await session.execute(textTurn("initialize-thinking"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    const transport = transports[0];
    if (!transport) throw new Error("Fake Claude transport was not created");
    transport.finish({ status: "succeeded" });
    await nextEvent(iterator);
    await nextEvent(iterator);

    await expect(
      session.execute({
        type: "thinking.select",
        thinkingOptionId: harnessThinkingOptionIdSchema.parse("high"),
      }),
    ).resolves.toEqual({ ok: true, value: { completed: true } });
    await expect(nextEvent(iterator)).resolves.toMatchObject({
      type: "session.state.changed",
      state: { effectiveThinkingOptionId: "high" },
    });
    expect(transport.setThinkingOption).toHaveBeenCalledWith("high");
    await session.close();
  });

  it("uses auto Permission Mode for unattended delegation sessions", async () => {
    const { adapter, dependencies } = fixture();
    const opened = await adapter.open({
      kind: "create",
      cwd: "/synthetic",
      executionPolicy: "unattended-full-access",
    });
    if (!opened.ok) throw new Error(opened.error.message);

    await opened.value.execute(textTurn("unattended"));
    expect(dependencies.createTransport).toHaveBeenCalledWith(
      expect.objectContaining({ permissionMode: "auto" }),
    );
    await opened.value.close();
  });

  it("defers cold Permission Mode selection and dynamically switches a started Query", async () => {
    const { adapter, dependencies, transports } = fixture();
    const plan = harnessPermissionModeIdSchema.parse("plan");
    const opened = await adapter.open({
      kind: "create",
      cwd: "/synthetic",
      permissionModeId: plan,
    });
    if (!opened.ok) throw new Error(opened.error.message);
    const session = opened.value;
    const iterator = session.outputs[Symbol.asyncIterator]();
    const auto = harnessPermissionModeIdSchema.parse("auto");

    await expect(
      session.execute({ type: "permissionMode.select", permissionModeId: auto }),
    ).resolves.toEqual({ ok: true, value: { completed: true } });
    await expect(nextEvent(iterator)).resolves.toMatchObject({
      type: "session.state.changed",
      state: { effectivePermissionModeId: "auto" },
    });
    expect(dependencies.createTransport).not.toHaveBeenCalled();

    await session.execute(textTurn("permission-start"));
    expect(dependencies.createTransport).toHaveBeenCalledWith(
      expect.objectContaining({ permissionMode: "auto" }),
    );
    expect(transports[0]?.setPermissionMode).not.toHaveBeenCalled();
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    transports[0]?.finish({ status: "succeeded" });
    await nextEvent(iterator);
    await nextEvent(iterator);

    transports[0]?.changePermissionMode("acceptEdits");
    await expect(nextEvent(iterator)).resolves.toMatchObject({
      type: "session.state.changed",
      state: { effectivePermissionModeId: "acceptEdits" },
    });

    transports[0]?.setPermissionMode.mockRejectedValueOnce(new Error("policy rejected"));
    await expect(
      session.execute({
        type: "permissionMode.select",
        permissionModeId: harnessPermissionModeIdSchema.parse("bypassPermissions"),
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "nativeFailure" } });
    expect(transports[0]?.permissionMode).toBe("acceptEdits");
    transports[0]?.setPermissionMode.mockRejectedValueOnce(
      new Error("Cannot set permission mode to auto: auto mode unavailable for this model"),
    );
    await expect(
      session.execute({ type: "permissionMode.select", permissionModeId: auto }),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: "nativeFailure",
        message: "Auto mode is unavailable for the current Claude Code Model",
      },
    });
    await expect(
      session.execute({
        type: "permissionMode.select",
        permissionModeId: harnessPermissionModeIdSchema.parse("dontAsk"),
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "invalidRequest" } });
    await session.close();
  });

  it("switches Permission Mode on the current Session while a Turn is active", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    await session.execute(textTurn("permission-active"));

    await expect(
      session.execute({
        type: "permissionMode.select",
        permissionModeId: harnessPermissionModeIdSchema.parse("auto"),
      }),
    ).resolves.toEqual({ ok: true, value: { completed: true } });
    expect(transports[0]?.setPermissionMode).toHaveBeenCalledWith("auto");
    transports[0]?.finish({ status: "succeeded" });
    await session.close();
  });

  it("selects Model and Thinking during a Turn and preserves native Model rejection", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();
    await session.execute(textTurn("initialize-failure"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    const transport = transports[0];
    if (!transport) throw new Error("Fake Claude transport was not created");
    const alias = encodeClaudeModelRef("sonnet");
    await expect(session.execute({ type: "model.select", model: alias })).resolves.toMatchObject({
      ok: true,
    });
    expect(transport.setModel).toHaveBeenCalledWith("sonnet");
    expect(await nextEvent(iterator)).toMatchObject({
      type: "session.state.changed",
      state: { effectiveModel: alias },
    });
    await expect(
      session.execute({
        type: "thinking.select",
        thinkingOptionId: harnessThinkingOptionIdSchema.parse("high"),
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(transport.setThinkingOption).toHaveBeenCalledWith("high");
    expect(await nextEvent(iterator)).toMatchObject({
      type: "session.state.changed",
      state: { effectiveThinkingOptionId: "high" },
    });
    transport.finish({ status: "succeeded" });
    await nextEvent(iterator);
    await nextEvent(iterator);

    transport.setModel.mockRejectedValueOnce(new Error("policy rejected"));
    await expect(session.execute({ type: "model.select", model: alias })).resolves.toMatchObject({
      ok: false,
      error: { code: "nativeFailure" },
    });

    const contextReadsBeforeSelection = transport.getContextUsage.mock.calls.length;
    await expect(session.execute({ type: "model.select", model: alias })).resolves.toEqual({
      ok: true,
      value: { completed: true },
    });
    await expect(nextEvent(iterator)).resolves.toMatchObject({
      type: "session.state.changed",
      state: { effectiveModel: alias },
    });
    expect(transport.getContextUsage).toHaveBeenCalledTimes(contextReadsBeforeSelection);
    await session.close();
  });
});
