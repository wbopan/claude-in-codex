import { describe, expect, it, vi } from "vitest";
import type { JsonObject } from "@codexhost/shared-contracts";
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
function fixture() {
  const sent: JsonObject[] = [];
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
  const service = new OfficialDesktopTools({ scope, cwd: "/workspace", activeTurn, diagnose });
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
    discoveryFailure: () => {
      discoveryError = "Codex app tools pipe closed";
    },
  };
}

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
});
