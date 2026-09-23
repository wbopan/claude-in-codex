import { describe, expect, it, vi } from "vitest";
import type { JsonObject } from "@claude-in-codex/shared-contracts";
import type { OfficialRuntimeScope } from "../src/codex-runtime/official-runtime-scope.js";
import { OfficialDesktopTools } from "../src/official-desktop-tools.js";

const definition = {
  name: "read_thread",
  description: "Official description",
  inputSchema: {
    type: "object",
    properties: { id: { anyOf: [{ type: "string" }, { type: "null" }] } },
  },
  annotations: { readOnlyHint: true },
  _meta: { official: true },
};
const cuaTool = (name: string) => ({ name, description: name, inputSchema: { type: "object" } });
function fixture(
  options: {
    elicit?: (params: JsonObject) => Promise<JsonObject>;
    enabledServers?: () => Promise<ReadonlySet<string>>;
  } = {},
) {
  const sent: JsonObject[] = [];
  let cua = false;
  const contexts: JsonObject[] = [];
  const clients: Array<{
    close: ReturnType<typeof vi.fn>;
    reply(value: JsonObject): Promise<void>;
  }> = [];
  let discoveryError: string | undefined;
  const scope = {
    attach: (output: (event: { value: JsonObject }) => Promise<void>) => {
      const id = clients.length + 1;
      const client = {
        initialize: vi.fn(async () => ({})),
        request: vi.fn(async (method: string, params: JsonObject) => {
          if (method === "thread/start") contexts.push(params);
          return method === "thread/start"
            ? { result: { thread: { id: `native-context-${id}` } } }
            : {
                result: {
                  data: [
                    {
                      name: "codex_app",
                      tools: { read_thread: definition },
                      ...(discoveryError ? { toolsError: discoveryError } : {}),
                    },
                    { name: "unrelated", tools: { other: cuaTool("other") } },
                    ...(cua
                      ? [
                          {
                            name: "cua_repl",
                            tools: {
                              js: cuaTool("js"),
                              js_reset: cuaTool("js_reset"),
                              turn_ended: cuaTool("turn_ended"),
                            },
                          },
                        ]
                      : []),
                  ],
                },
              };
        }),
        send: vi.fn(async (value: JsonObject) => {
          sent.push(value);
        }),
        close: vi.fn(),
        reply: (value: JsonObject) => output({ value }),
      };
      clients.push(client);
      return client;
    },
  } as unknown as OfficialRuntimeScope;
  const activeTurn = vi.fn((): string | null => "actual-turn");
  const diagnose = vi.fn();
  const trace = vi.fn();
  const elicit = options.elicit;
  const service = new OfficialDesktopTools({
    scope,
    cwd: "/workspace",
    activeTurn,
    diagnose,
    trace,
    appConsent: (params) => params.consented === true,
    ...(elicit
      ? { elicit: (_thread: string, _turn: string, params: JsonObject) => elicit(params) }
      : {}),
    ...(options.enabledServers ? { enabledServers: options.enabledServers } : {}),
  });
  const signal = new AbortController();
  const input = {
    namespace: "codex_app",
    name: "read_thread",
    arguments: { threadId: "target" },
    signal: signal.signal,
  };
  return {
    service,
    clients,
    sent,
    contexts,
    activeTurn,
    signal,
    input,
    diagnose,
    trace,
    withCua: () => {
      cua = true;
    },
    discoveryFailure: () => {
      discoveryError = "Codex app tools pipe closed";
    },
  };
}

describe("official Desktop MCP feature switches", () => {
  it("leaves a switched-off server out of the next listing", async () => {
    let enabled: ReadonlySet<string> = new Set(["cua_repl"]);
    const f = fixture({ enabledServers: async () => enabled });
    f.withCua();
    const listed = await f.service.forThread("actual-thread").list();
    expect(listed.map((tool) => `${tool.namespace}.${String(tool.definition.name)}`)).toEqual([
      "cua_repl.js",
      "cua_repl.js_reset",
    ]);
    enabled = new Set(["codex_app", "cua_repl"]);
    const both = await f.service.forThread("next-thread").list();
    expect(new Set(both.map((tool) => tool.namespace))).toEqual(new Set(["codex_app", "cua_repl"]));
  });

  it("does not open an official context when every server is switched off", async () => {
    const f = fixture({ enabledServers: async () => new Set() });
    await expect(f.service.forThread("actual-thread").list()).resolves.toEqual([]);
    expect(f.clients).toHaveLength(0);
  });

  it("inspects the exposed servers in a closed ephemeral context, ignoring the switches", async () => {
    const f = fixture({ enabledServers: async () => new Set() });
    f.withCua();
    f.discoveryFailure();
    const servers = await f.service.inspect();
    expect(Object.fromEntries(servers)).toEqual({
      codex_app: { tools: ["read_thread"], error: "Codex app tools pipe closed" },
      cua_repl: { tools: ["js", "js_reset", "turn_ended"], error: null },
    });
    expect(f.clients).toHaveLength(1);
    expect(f.clients[0]?.close).toHaveBeenCalled();
  });
});

describe("official Desktop MCP reuse", () => {
  it("discovers the official schema and lets native MCP own its context identity", async () => {
    const f = fixture();
    const tools = f.service.forThread("actual-thread", "/actual Claude workspace");
    expect(await tools.list()).toEqual([{ namespace: "codex_app", definition }]);
    expect(f.contexts).toEqual([
      {
        cwd: "/actual Claude workspace",
        ephemeral: true,
        approvalPolicy: "untrusted",
        sandbox: "read-only",
      },
    ]);
    const pending = tools.call(f.input);
    await vi.waitFor(() => expect(f.sent).toHaveLength(1));
    expect(f.sent[0]).toMatchObject({
      method: "mcpServer/tool/call",
      params: {
        threadId: "native-context-1",
        server: "codex_app",
        tool: "read_thread",
        arguments: { threadId: "target" },
      },
    });
    expect(f.sent[0]?.params).not.toHaveProperty("_meta");
    const result = {
      content: [{ type: "text", text: "native result" }],
      isError: false,
      structuredContent: { native: true },
    };
    const client = f.clients[0],
      request = f.sent[0];
    if (!client || request?.id === undefined) throw new Error("Missing native call");
    await client.reply({ id: request.id, result });
    await expect(pending).resolves.toEqual(result);
    f.service.close();
  });

  it("keeps long official waits alive and cancels only the caller's connection", async () => {
    vi.useFakeTimers();
    const f = fixture();
    try {
      const a = f.service.forThread("a"),
        b = f.service.forThread("b");
      await a.list();
      await b.list();
      let settled = false;
      const pending = a.call(f.input).finally(() => {
        settled = true;
      });
      const rejected = expect(pending).rejects.toThrow("accepted action may still complete");
      await vi.advanceTimersByTimeAsync(60_000);
      expect(settled).toBe(false);
      f.signal.abort();
      await rejected;
      expect(f.clients[0]?.close).toHaveBeenCalledOnce();
      expect(f.clients[1]?.close).not.toHaveBeenCalled();
      expect(f.sent).toHaveLength(1);
      // Recovery opens a fresh native context; the accepted call is never replayed.
      await a.list();
      expect(f.clients).toHaveLength(3);
      expect(f.sent).toHaveLength(1);
    } finally {
      f.service.close();
      vi.useRealTimers();
    }
  });

  it("reports native discovery rejection without exposing a replacement tool", async () => {
    const f = fixture();
    f.discoveryFailure();
    expect(await f.service.forThread("a").list()).toEqual([]);
    expect(f.diagnose).toHaveBeenCalledWith(expect.stringContaining("Codex app tools pipe closed"));
    expect(f.sent).toEqual([]);
    f.service.close();
  });

  it("requires the actual active task and preserves native tool errors", async () => {
    const f = fixture();
    const tools = f.service.forThread("a");
    await tools.list();
    f.activeTurn.mockReturnValue(null);
    await expect(tools.call(f.input)).rejects.toThrow("active owning task");
    expect(f.sent).toEqual([]);
    f.activeTurn.mockReturnValue("actual-turn");
    const pending = tools.call(f.input);
    await vi.waitFor(() => expect(f.sent).toHaveLength(1));
    const result = {
      isError: true,
      content: [{ type: "text", text: "Official permission denied" }],
    };
    const client = f.clients[0],
      request = f.sent[0];
    if (!client || request?.id === undefined) throw new Error("Missing native call");
    await client.reply({ id: request.id, result });
    await expect(pending).resolves.toEqual(result);
    f.service.close();
  });
  it("exposes cua_repl js and js_reset with the owning task identity and ends the Turn", async () => {
    const f = fixture();
    f.withCua();
    const tools = f.service.forThread("host-thread");
    const names = (await tools.list()).map((tool) => `${tool.namespace}.${tool.definition.name}`);
    // turn_ended stays a Host lifecycle call; unrelated official servers are never exposed.
    expect(names).toEqual(["codex_app.read_thread", "cua_repl.js", "cua_repl.js_reset"]);
    expect(f.trace).toHaveBeenCalledWith(
      expect.objectContaining({ officialServers: ["codex_app", "unrelated", "cua_repl"] }),
    );
    const identity = {
      thread_id: "host-thread",
      session_id: "host-thread",
      turn_id: "actual-turn",
      thread_source: "user",
    };
    const reply = async (index: number, result: JsonObject) => {
      await vi.waitFor(() => expect(f.sent).toHaveLength(index + 1));
      await f.clients[0]?.reply({ id: f.sent[index]?.id as string, result });
    };
    const pending = tools.call({
      namespace: "cua_repl",
      name: "js",
      arguments: { code: "1" },
      signal: f.signal.signal,
    });
    await reply(0, { content: [] });
    await pending;
    expect(f.sent[0]?.params).toMatchObject({
      threadId: "native-context-1",
      server: "cua_repl",
      tool: "js",
      arguments: { code: "1" },
      _meta: { "x-codex-turn-metadata": identity },
    });
    // A Turn that never used cua_repl reports nothing.
    f.service.turnEnded("host-thread", "another-turn", "Stop");
    f.service.turnEnded("host-thread", "actual-turn", "Interrupt");
    await reply(1, { content: [] });
    await reply(2, { content: [] });
    expect(f.sent.slice(1).map((request) => (request.params as JsonObject).tool)).toEqual([
      "turn_ended",
      "js_reset",
    ]);
    expect(f.sent[1]?.params).toMatchObject({
      arguments: {
        hook_event_name: "Interrupt",
        session_id: "host-thread",
        turn_id: "actual-turn",
      },
      _meta: { "x-codex-turn-metadata": identity },
    });
    f.service.close();
  });

  it("answers native elicitations by consent, by the owning task, or by cancelling", async () => {
    const elicit = vi.fn(async () => ({ action: "decline" }));
    const f = fixture({ elicit });
    await f.service.forThread("host-thread").list();
    const client = f.clients[0];
    if (!client) throw new Error("Missing native client");
    const ask = async (id: number, params: JsonObject) => {
      await client.reply({ id, method: "mcpServer/elicitation/request", params });
      return f.sent.find((message) => message.id === id)?.result;
    };
    expect(await ask(1, { consented: true })).toEqual({
      action: "accept",
      content: {},
      _meta: { persist: "always" },
    });
    expect(await ask(2, { mode: "form" })).toEqual({ action: "decline" });
    expect(elicit).toHaveBeenCalledWith({ mode: "form" });
    // Without an active owning task nobody can answer: cancel, never an implied denial.
    f.activeTurn.mockReturnValue(null);
    expect(await ask(3, { mode: "form" })).toEqual({ action: "cancel" });
    f.service.close();
  });
});
