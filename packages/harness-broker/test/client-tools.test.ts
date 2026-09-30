import { randomUUID } from "node:crypto";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { HarnessClientTools } from "@claude-in-codex/harness-adapter";
import { FakeHarnessAdapter, FakeHarnessSession } from "@claude-in-codex/harness-adapter/testing";
import { harnessIdSchema, hostTurnIdSchema } from "@claude-in-codex/shared-contracts";
import { BrokerClientTools } from "../src/client-tools.js";
import { BrokeredHarnessAdapter, startHarnessBrokerServer } from "../src/index.js";
import { tempDir } from "../../../tests/helpers/temp-dir.js";

const catalogue = [
  {
    namespace: "cua_repl",
    definition: { name: "js", description: "Browser control", inputSchema: { type: "object" } },
  },
];
const result = { content: [{ type: "text", text: "browser ready" }] };
function pair() {
  const generation = randomUUID();
  const host = new BrokerClientTools(generation, async (frame) => {
    broker.accept(frame);
  });
  const broker = new BrokerClientTools(generation, async (frame) => {
    host.accept(frame);
  });
  return { host, broker };
}

describe("Broker client tools", () => {
  it("passes catalogues and calls during adapter.open without blocking its request queue", async () => {
    const root = await tempDir("cx-tools-");
    const descriptorPath = path.join(root, "broker.json");
    const native = new FakeHarnessAdapter(harnessIdSchema.parse("claude-code"));
    const originalOpen = native.open.bind(native);
    let remote: HarnessClientTools | undefined;
    const currentTools = () => {
      if (!remote) throw new Error("Missing client tools");
      return remote;
    };
    vi.spyOn(native, "open").mockImplementation(async (input) => {
      remote = input.clientTools;
      expect(remote).toBeDefined();
      await expect(currentTools().list()).resolves.toEqual(catalogue);
      if (input.kind === "resume") {
        const session = new FakeHarnessSession(
          native.harnessId,
          native.catalog,
          undefined,
          input.nativeRef,
          { turns: [] },
          true,
          root,
        );
        native.sessions.push(session);
        return { ok: true, value: session };
      }
      return originalOpen(input);
    });
    const server = await startHarnessBrokerServer({
      descriptorPath,
      socketPath:
        process.platform === "win32"
          ? `\\\\.\\pipe\\cx-tools-${randomUUID()}`
          : path.join(root, "b.sock"),
      adapter: native,
    });
    const adapter = new BrokeredHarnessAdapter({ descriptorPath });
    const call = vi.fn(async () => result);
    const close = vi.fn();
    try {
      const opened = await adapter.open({
        kind: "create",
        cwd: root,
        clientTools: { list: async () => catalogue, call, close },
      });
      expect(opened.ok).toBe(true);
      await expect(
        currentTools().call({
          namespace: "cua_repl",
          name: "js",
          arguments: { code: "await cua.getState()" },
          signal: new AbortController().signal,
        }),
      ).resolves.toEqual(result);
      expect(call).toHaveBeenCalledWith(
        expect.objectContaining({
          namespace: "cua_repl",
          name: "js",
          arguments: { code: "await cua.getState()" },
        }),
      );
      if (!opened.ok) throw new Error(opened.error.message);
      const outputs = opened.value.outputs[Symbol.asyncIterator]();
      native.sessions[0]?.fault({
        code: "authenticationRequired",
        message: "reopen fixture",
        retryable: true,
      });
      await expect(outputs.next()).resolves.toMatchObject({
        value: { kind: "event", event: { type: "session.faulted" } },
      });
      await expect(
        opened.value.execute({
          type: "turn.start",
          turnId: hostTurnIdSchema.parse("tools-reopen"),
          input: [{ type: "text", text: "resume" }],
        }),
      ).resolves.toMatchObject({ ok: true });
      await expect(currentTools().list()).resolves.toEqual(catalogue);
      expect(native.open).toHaveBeenCalledTimes(2);
      expect(close).not.toHaveBeenCalled();
      await opened.value.close();
      expect(close).toHaveBeenCalledOnce();
      await expect(currentTools().list()).rejects.toThrow();
    } finally {
      await adapter.close();
      await server.close();
    }
  });

  it("cancels the Host call and can create a fresh proxy after a session reopens", async () => {
    const { host, broker } = pair();
    const id = randomUUID();
    const started = Promise.withResolvers<AbortSignal>();
    host.register(id, {
      list: async () => catalogue,
      call: async (input) => {
        started.resolve(input.signal as AbortSignal);
        return new Promise((_, reject) =>
          input.signal.addEventListener("abort", () => reject(new Error("stopped")), {
            once: true,
          }),
        );
      },
    });
    const remote = broker.remote(id);
    const calling = remote.call({
      namespace: "cua_repl",
      name: "js",
      arguments: {},
      signal: new AbortController().signal,
    });
    const rejected = expect(calling).rejects.toThrow("cancelled");
    const signal = await started.promise;
    remote.close?.();
    await rejected;
    expect(signal.aborted).toBe(true);
    await expect(broker.remote(id).list()).resolves.toEqual(catalogue);
    host.close();
    broker.close();
  });

  it("rejects unknown capabilities, propagates errors, and rejects pending calls on disconnect", async () => {
    const { host, broker } = pair();
    await expect(broker.remote(randomUUID()).list()).rejects.toThrow("no longer owned");
    const id = randomUUID();
    host.register(id, {
      list: async () => {
        throw new Error("catalogue unavailable");
      },
      call: async () => new Promise(() => {}),
    });
    await expect(broker.remote(id).list()).rejects.toThrow("catalogue unavailable");
    const remote = broker.remote(id);
    const rejected = expect(
      remote.call({
        namespace: "codex_app",
        name: "test",
        arguments: {},
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("connection closed");
    broker.close();
    host.close();
    await rejected;
  });
});
