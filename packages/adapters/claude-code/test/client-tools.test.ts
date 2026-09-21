import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createClaudeClientTools } from "../src/client-tools.js";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

describe("Claude native MCP client transport", () => {
  it("preserves native schemas, annotations and results without local business handlers", async () => {
    const definition = {
      name: "create_thread",
      description: "Official",
      inputSchema: {
        type: "object",
        properties: { target: { anyOf: [{ const: "project" }, { const: "projectless" }] } },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false },
      _meta: { official: true },
    };
    const result = {
      isError: false,
      content: [{ type: "text", text: "native task" }],
      structuredContent: { threadId: "created" },
    };
    const call = vi.fn(async () => result),
      close = vi.fn();
    const tools = await createClaudeClientTools({
      list: async () => [{ namespace: "codex_app", definition }],
      call,
      close,
    });
    cleanups.push(() => tools.close());
    const [a, b] = InMemoryTransport.createLinkedPair();
    const server = tools.servers.codex_app;
    if (!server) throw new Error("Official server was not registered");
    await server.instance.connect(b);
    const client = new Client({ name: "test", version: "1" });
    await client.connect(a);
    cleanups.push(() => client.close());
    expect((await client.listTools()).tools).toEqual([definition]);
    expect(
      await client.callTool({ name: "create_thread", arguments: { target: "projectless" } }),
    ).toEqual(result);
    expect(call).toHaveBeenCalledWith(
      expect.objectContaining({
        namespace: "codex_app",
        name: "create_thread",
        arguments: { target: "projectless" },
        signal: expect.any(AbortSignal),
      }),
    );
    await tools.close();
    expect(close).toHaveBeenCalledOnce();
  });

  it("registers nothing when the owning client has no tools", async () => {
    const tools = await createClaudeClientTools(undefined);
    expect(tools.servers).toEqual({});
    await tools.close();
  });
});
