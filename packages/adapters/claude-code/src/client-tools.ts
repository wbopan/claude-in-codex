import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  CallToolResultSchema,
  ToolSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import type { HarnessClientTools } from "@claude-in-codex/harness-adapter";
import type { JsonValue } from "@claude-in-codex/shared-contracts";

/** Adapt only the transport. Schemas, descriptions, annotations and results stay client-owned. */
export async function createClaudeClientTools(client: HarnessClientTools | undefined) {
  const servers: Record<string, McpSdkServerConfigWithInstance> = {};
  const closing = new AbortController();
  let closed = false;
  const catalog = (await client?.list()) ?? [];
  for (const namespace of new Set(catalog.map((tool) => tool.namespace))) {
    const tools = catalog
      .filter((tool) => tool.namespace === namespace)
      .map((tool) => ToolSchema.parse(tool.definition));
    const instance = new McpServer(
      { name: namespace, version: "1" },
      { capabilities: { tools: {} } },
    );
    instance.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
    instance.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      if (!client || !tools.some((tool) => tool.name === request.params.name))
        throw new Error("Unknown client tool");
      try {
        return CallToolResultSchema.parse(
          await client.call({
            namespace,
            name: request.params.name,
            arguments: (request.params.arguments ?? {}) as JsonValue,
            signal: AbortSignal.any([extra.signal, closing.signal]),
          }),
        );
      } catch (error) {
        return {
          isError: true,
          content: [
            { type: "text" as const, text: error instanceof Error ? error.message : String(error) },
          ],
        };
      }
    });
    servers[namespace] = { type: "sdk", name: namespace, instance };
  }
  return {
    servers,
    async close() {
      if (closed) return;
      closed = true;
      closing.abort();
      client?.close?.();
      await Promise.all(Object.values(servers).map((server) => server.instance.close()));
    },
  };
}
