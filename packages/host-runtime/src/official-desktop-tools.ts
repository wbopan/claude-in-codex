import type { HarnessClientTool, HarnessClientTools } from "@claude-in-codex/harness-adapter";
import type { JsonObject } from "@claude-in-codex/shared-contracts";
import type { OfficialRuntimeScope } from "./codex-runtime/official-runtime-scope.js";
import type { OfficialClientSession } from "./codex-runtime/official-runtime-owner.js";
import { OfficialRequestBroker } from "./official-request-broker.js";

const object = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Official MCP servers exposed to an external Harness. `null` exposes every tool; a set names
 * the tools the Harness may call. `cua_repl` keeps `turn_ended` for the Host's own lifecycle.
 */
const EXPOSED_SERVERS: ReadonlyMap<string, ReadonlySet<string> | null> = new Map([
  ["codex_app", null],
  ["cua_repl", new Set(["js", "js_reset"])],
]);
const CUA_SERVER = "cua_repl";
const CUA_CLEANUP_TIMEOUT_MS = 5_000;
/** The feature switch that exposes each official server. */
export const DESKTOP_TOOL_FEATURES = {
  codexAppTools: "codex_app",
  computerUse: CUA_SERVER,
} as const;

/** One exposed official server as the native app-server reports it; used for problem reports. */
export interface DesktopToolServerStatus {
  /** Tool names, or null when the server reported no catalogue. */
  tools: string[] | null;
  error: string | null;
}

export type DesktopTurnEnd = "Stop" | "Interrupt";

/**
 * Reuse the native app-server's official MCP servers (codex_app, cua_repl), including their
 * native peer checks. Calls run in an ephemeral official context owned by this Host.
 */
interface DesktopToolOptions {
  scope: OfficialRuntimeScope;
  cwd: string;
  activeTurn(threadId: string): string | null;
  diagnose(error: unknown): void;
  /** Standing consent configured by the user for a native app-access confirmation. */
  appConsent?(params: JsonObject, contextThreadId: string): boolean;
  /** Show a native MCP elicitation on the owning task and resolve with the Desktop's answer. */
  elicit?(threadId: string, turnId: string, params: JsonObject): Promise<JsonObject>;
  /** Sanitized acceptance trace: names and outcomes only, never arguments or results. */
  trace?(event: JsonObject): void;
  /** Servers the feature switches allow, read when a Harness Session lists its tools. */
  enabledServers?(): Promise<ReadonlySet<string>>;
}

export class OfficialDesktopTools {
  #sessions = new Set<OfficialDesktopToolSession>();
  constructor(private readonly options: DesktopToolOptions) {}
  forThread(threadId: string, cwd = this.options.cwd): HarnessClientTools {
    let session: OfficialDesktopToolSession | undefined;
    const tools = () => {
      if (!session) {
        const created = new OfficialDesktopToolSession({ ...this.options, cwd }, threadId, () =>
          this.#sessions.delete(created),
        );
        session = created;
        this.#sessions.add(created);
      }
      return session.forThread(threadId);
    };
    return {
      // A switched-off server is left out of the next Harness Session; one already running
      // keeps the tools it started with.
      list: async () => {
        const enabled = await this.options.enabledServers?.();
        if (enabled?.size === 0) return [];
        const catalog = await tools().list();
        return enabled ? catalog.filter((tool) => enabled.has(tool.namespace)) : catalog;
      },
      call: (input) => tools().call(input),
      close: () => session?.close(),
    };
  }
  /**
   * List the exposed official servers in a fresh ephemeral context, ignoring the switches. A
   * server missing from the result was not reported by the native app-server.
   */
  async inspect(): Promise<Map<string, DesktopToolServerStatus>> {
    const session = new OfficialDesktopToolSession(
      this.options,
      "claude-in-codex:inspect",
      () => {},
    );
    try {
      const servers = new Map<string, DesktopToolServerStatus>();
      for (const server of await session.servers()) {
        if (typeof server.name !== "string" || !EXPOSED_SERVERS.has(server.name)) continue;
        servers.set(server.name, {
          tools: object(server.tools)
            ? Object.values(server.tools).flatMap((definition) =>
                object(definition) && typeof definition.name === "string" ? [definition.name] : [],
              )
            : null,
          error: typeof server.toolsError === "string" ? server.toolsError : null,
        });
      }
      return servers;
    } finally {
      session.close();
    }
  }
  /** Release Desktop resources (Computer Use, browser) a finished Turn may still hold. */
  turnEnded(threadId: string, turnId: string, event: DesktopTurnEnd): void {
    for (const session of this.#sessions)
      if (session.threadId === threadId) void session.turnEnded(turnId, event);
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
  /** Turn that last used cua_repl and has not been reported as ended. */
  #cuaTurn: string | undefined;
  #calls = new OfficialRequestBroker({
    timeoutMs: 3_600_000,
    send: (value) => {
      if (!this.#client) return Promise.reject(new Error("Desktop MCP connection is closed"));
      return this.#client.send(value);
    },
  });

  constructor(
    private readonly options: DesktopToolOptions,
    readonly threadId: string,
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

  /** Open the ephemeral official context and read every server's status, all pages. */
  async servers(): Promise<JsonObject[]> {
    if (this.#closed) return [];
    const client = this.options.scope.attach(async ({ value }) => {
      if (this.#calls.handle(value)) return;
      if (!object(value) || value.id === undefined || typeof value.method !== "string") return;
      if (value.method === "mcpServer/elicitation/request")
        await client.send({ id: value.id, result: await this.#elicit(value.params) });
      else
        await client.send({
          id: value.id,
          error: { code: -32601, message: "Unsupported Desktop MCP interaction" },
        });
    });
    this.#client = client;
    await client.initialize({
      clientInfo: { name: "claude_in_codex_desktop_tools", version: "1" },
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
    const servers: JsonObject[] = [];
    let cursor: string | undefined;
    do {
      const status = await this.#request("mcpServerStatus/list", {
        threadId: this.#context,
        limit: 100,
        ...(cursor ? { cursor } : {}),
      });
      if (!Array.isArray(status.data)) throw new Error("Invalid official MCP catalogue");
      servers.push(...status.data.filter(object));
      cursor = typeof status.nextCursor === "string" ? status.nextCursor : undefined;
    } while (cursor);
    return servers;
  }

  async #load(): Promise<readonly HarnessClientTool[]> {
    if (this.#closed) return [];
    const tools: HarnessClientTool[] = [];
    const seen: string[] = [];
    for (const server of await this.servers()) {
      if (typeof server.name !== "string") continue;
      seen.push(server.name);
      const exposed = EXPOSED_SERVERS.get(server.name);
      if (exposed === undefined) continue;
      // One unavailable server must not hide the other.
      if (typeof server.toolsError === "string" || !object(server.tools)) {
        this.options.diagnose(
          `Desktop MCP '${server.name}' is unavailable` +
            (typeof server.toolsError === "string" ? `: ${server.toolsError}` : ""),
        );
        continue;
      }
      const namespace = server.name;
      for (const definition of Object.values(server.tools))
        if (
          object(definition) &&
          typeof definition.name === "string" &&
          (exposed === null || exposed.has(definition.name))
        )
          tools.push({ namespace, definition });
    }
    this.options.trace?.({
      event: "desktop-tools/catalogue",
      officialServers: seen,
      exposed: tools.map((tool) => `${tool.namespace}.${String(tool.definition.name)}`),
    });
    if (tools.length === 0) throw new Error("Official Desktop MCP servers are not enabled");
    return tools;
  }

  /**
   * Answer a native elicitation. Standing consent is checked first; otherwise the owning task
   * shows the request. Without a UI the answer is a cancellation, never an implied denial.
   */
  async #elicit(params: unknown): Promise<JsonObject> {
    const cancel = { action: "cancel" };
    if (!object(params) || !this.#context) return cancel;
    try {
      if (this.options.appConsent?.(params, this.#context))
        return { action: "accept", content: {}, _meta: { persist: "always" } };
      const turnId = this.options.activeTurn(this.threadId);
      if (!turnId || !this.options.elicit) return cancel;
      return await this.options.elicit(this.threadId, turnId, params);
    } catch (error) {
      this.options.diagnose(error);
      return cancel;
    }
  }

  #cuaCall(tool: string, turnId: string, args: JsonObject): Promise<JsonObject> {
    if (!this.#context) return Promise.reject(new Error("Desktop MCP connection is closed"));
    return this.#request("mcpServer/tool/call", {
      threadId: this.#context,
      server: CUA_SERVER,
      tool,
      arguments: args,
      // cua_repl routes Computer Use and the in-app browser by the owning task's identity.
      _meta: {
        "x-codex-turn-metadata": {
          thread_id: this.threadId,
          session_id: this.threadId,
          turn_id: turnId,
          thread_source: "user",
        },
      },
    });
  }

  /** Report the end of a Turn that used cua_repl. An interrupted Turn also resets the kernel. */
  async turnEnded(turnId: string, event: DesktopTurnEnd): Promise<void> {
    if (this.#cuaTurn !== turnId || !this.#context || this.#closed) return;
    this.#cuaTurn = undefined;
    const cleanup = (async () => {
      await this.#cuaCall("turn_ended", turnId, {
        hook_event_name: event,
        session_id: this.threadId,
        turn_id: turnId,
      });
      if (event === "Interrupt") await this.#cuaCall("js_reset", turnId, {});
    })();
    await Promise.race([
      cleanup.catch((error: unknown) => this.options.diagnose(error)),
      new Promise((resolve) => setTimeout(resolve, CUA_CLEANUP_TIMEOUT_MS).unref()),
    ]);
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
        const cua = input.namespace === CUA_SERVER;
        if (cua) {
          if (this.#cuaTurn && this.#cuaTurn !== turnId)
            await this.turnEnded(this.#cuaTurn, "Stop");
          this.#cuaTurn = turnId;
        }
        // An interrupted cua_repl call releases Desktop control before the connection closes.
        const abort = () =>
          void (cua ? this.turnEnded(turnId, "Interrupt") : Promise.resolve()).finally(() =>
            this.#reset(),
          );
        input.signal.addEventListener("abort", abort, { once: true });
        const traceCall = (outcome: string) =>
          this.options.trace?.({
            event: "desktop-tools/call",
            tool: `${input.namespace}.${input.name}`,
            outcome,
          });
        try {
          const result = cua
            ? await this.#cuaCall(
                input.name,
                turnId,
                object(input.arguments) ? input.arguments : {},
              )
            : await this.#request("mcpServer/tool/call", {
                threadId: this.#context,
                server: input.namespace,
                tool: input.name,
                arguments: input.arguments,
                // Native app-server binds the caller to this real MCP context.
                // Do not claim it can impersonate the external task's Thread ID.
              });
          traceCall(result.isError === true ? "tool-error" : "ok");
          return result;
        } catch (error) {
          traceCall("failed");
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
    this.#cuaTurn = undefined;
  }
}
