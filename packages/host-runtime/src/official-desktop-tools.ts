import type { HarnessClientTool, HarnessClientTools } from "@codexhost/harness-adapter";
import type { JsonObject } from "@codexhost/shared-contracts";
import type { OfficialRuntimeScope } from "./codex-runtime/official-runtime-scope.js";
import type { OfficialClientSession } from "./codex-runtime/official-runtime-owner.js";
import { OfficialRequestBroker } from "./official-request-broker.js";

const object = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Reuse the native app-server's official codex_app MCP, including its native peer checks. */
interface DesktopToolOptions {
  scope: OfficialRuntimeScope;
  cwd: string;
  activeTurn(threadId: string): string | null;
  diagnose(error: unknown): void;
}

export class OfficialDesktopTools {
  #sessions = new Set<OfficialDesktopToolSession>();
  constructor(private readonly options: DesktopToolOptions) {}
  forThread(threadId: string, cwd = this.options.cwd): HarnessClientTools {
    let session: OfficialDesktopToolSession | undefined;
    const tools = () => {
      if (!session) {
        const created = new OfficialDesktopToolSession({ ...this.options, cwd }, () =>
          this.#sessions.delete(created),
        );
        session = created;
        this.#sessions.add(created);
      }
      return session.forThread(threadId);
    };
    return {
      list: () => tools().list(),
      call: (input) => tools().call(input),
      close: () => session?.close(),
    };
  }
  close(): void {
    for (const session of this.#sessions) session.close();
  }
}

class OfficialDesktopToolSession {
  #client: OfficialClientSession | undefined;
  #context: string | undefined;
  #catalog: Promise<readonly HarnessClientTool[]> | undefined;
  #closed = false;
  #calls = new OfficialRequestBroker({
    timeoutMs: 3_600_000,
    send: (value) => {
      if (!this.#client) return Promise.reject(new Error("Desktop MCP connection is closed"));
      return this.#client.send(value);
    },
  });

  constructor(
    private readonly options: DesktopToolOptions,
    private readonly onClosed: () => void,
  ) {}

  async #request(method: string, params: JsonObject): Promise<JsonObject> {
    if (!this.#client || this.#closed) throw new Error("Desktop MCP connection is closed");
    const response =
      method === "mcpServer/tool/call"
        ? await this.#calls.request(method, params)
        : await this.#client.request(method, params);
    if (object(response.error))
      throw new Error(
        typeof response.error.message === "string"
          ? response.error.message
          : "Official MCP request failed",
      );
    if (!object(response.result)) throw new Error("Invalid official MCP response");
    return response.result;
  }

  async #load(): Promise<readonly HarnessClientTool[]> {
    if (this.#closed) return [];
    const client = this.options.scope.attach(async ({ value }) => {
      if (this.#calls.handle(value)) return;
      if (!object(value) || value.id === undefined || typeof value.method !== "string") return;
      // Unsupported native interaction is a cancellation, never an implicit user denial.
      if (value.method === "mcpServer/elicitation/request")
        await client.send({ id: value.id, result: { action: "cancel" } });
      else
        await client.send({
          id: value.id,
          error: { code: -32601, message: "Unsupported Desktop MCP interaction" },
        });
    });
    this.#client = client;
    await client.initialize({
      clientInfo: { name: "codexhost_desktop_tools", version: "1" },
      capabilities: { experimentalApi: true },
    });
    const started = await this.#request("thread/start", {
      cwd: this.options.cwd,
      ephemeral: true,
      approvalPolicy: "untrusted",
      sandbox: "read-only",
    });
    if (!object(started.thread) || typeof started.thread.id !== "string")
      throw new Error("Official MCP context was not created");
    this.#context = started.thread.id;
    let cursor: string | undefined;
    do {
      const status = await this.#request("mcpServerStatus/list", {
        threadId: this.#context,
        limit: 100,
        ...(cursor ? { cursor } : {}),
      });
      if (!Array.isArray(status.data)) throw new Error("Invalid official MCP catalogue");
      const server = status.data.find((entry) => object(entry) && entry.name === "codex_app");
      if (object(server)) {
        if (typeof server.toolsError === "string") throw new Error(server.toolsError);
        if (!object(server.tools)) throw new Error("Official app tools are unavailable");
        return Object.values(server.tools)
          .filter(object)
          .map((definition) => ({ namespace: "codex_app", definition }));
      }
      cursor = typeof status.nextCursor === "string" ? status.nextCursor : undefined;
    } while (cursor);
    throw new Error("Official codex_app MCP is not enabled");
  }

  forThread(threadId: string): HarnessClientTools {
    return {
      close: () => this.close(),
      list: () =>
        (this.#catalog ??= this.#load().catch((error: unknown) => {
          this.options.diagnose(
            `Desktop app tools unavailable: ${error instanceof Error ? error.message : String(error)}`,
          );
          this.#reset();
          return [];
        })),
      call: async (input) => {
        const turnId = this.options.activeTurn(threadId);
        if (input.signal.aborted || this.#closed) throw new Error("Desktop tool call cancelled");
        if (!turnId) throw new Error("Desktop tool call requires an active owning task");
        const tools = await (this.#catalog ??= this.#load());
        if (
          !tools?.some(
            (tool) => tool.namespace === input.namespace && tool.definition.name === input.name,
          )
        )
          throw new Error("Unknown official Desktop tool");
        if (input.signal.aborted || this.options.activeTurn(threadId) !== turnId || !this.#context)
          throw new Error("Owning task changed before Desktop tool call");
        const abort = () => this.#reset();
        input.signal.addEventListener("abort", abort, { once: true });
        try {
          return await this.#request("mcpServer/tool/call", {
            threadId: this.#context,
            server: input.namespace,
            tool: input.name,
            arguments: input.arguments,
            // Native app-server binds the caller to this real MCP context.
            // Do not claim it can impersonate the external task's Thread ID.
          });
        } catch (error) {
          this.#reset();
          throw error;
        } finally {
          input.signal.removeEventListener("abort", abort);
        }
      },
    };
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#reset();
    this.onClosed();
  }

  #reset(): void {
    this.#calls.failAll(
      new Error("Desktop MCP connection closed; an accepted action may still complete"),
    );
    this.#client?.close();
    this.#client = undefined;
    this.#context = undefined;
    this.#catalog = undefined;
  }
}
