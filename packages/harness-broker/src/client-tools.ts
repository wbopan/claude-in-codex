import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { HarnessClientTools } from "@claude-in-codex/harness-adapter";
import { jsonObjectSchema, jsonValueSchema } from "@claude-in-codex/shared-contracts";
import {
  HARNESS_BROKER_MAX_PENDING_REQUESTS,
  HARNESS_BROKER_PROTOCOL_VERSION,
} from "./protocol.js";

const messageSchema = z.discriminatedUnion("type", [
  z
    .object({ type: z.literal("list"), id: z.string().uuid(), provider: z.string().uuid() })
    .strict(),
  z
    .object({
      type: z.literal("call"),
      id: z.string().uuid(),
      provider: z.string().uuid(),
      namespace: z.string(),
      name: z.string(),
      arguments: jsonValueSchema,
    })
    .strict(),
  z.object({ type: z.literal("cancel"), id: z.string().uuid() }).strict(),
  z
    .object({
      type: z.literal("result"),
      id: z.string().uuid(),
      value: z.unknown().optional(),
      error: z.string().optional(),
    })
    .strict(),
]);
const frameSchema = z
  .object({
    kind: z.literal("clientTools"),
    version: z.literal(HARNESS_BROKER_PROTOCOL_VERSION),
    generation: z.string().uuid(),
    message: messageSchema,
  })
  .strict();
const catalogueSchema = z.array(
  z.object({ namespace: z.string(), definition: jsonObjectSchema }).strict(),
);
type Message = z.infer<typeof messageSchema>;

/** Reverse RPC on the authenticated socket. These frames bypass the serialized Session queue:
 * adapter.open may itself await a catalogue. UUIDs correlate this independent duplex channel.
 */
export class BrokerClientTools {
  #providers = new Map<string, HarnessClientTools>();
  #active = new Map<string, { provider: string; abort: AbortController }>();
  #pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
  #closed = false;
  constructor(
    private readonly generation: string,
    private readonly sendFrame: (frame: object) => Promise<void>,
  ) {}

  register(id: string, tools: HarnessClientTools): void {
    if (this.#closed) throw new Error("Client tool connection is closed");
    this.#providers.set(id, tools);
  }
  unregister(id: string): void {
    for (const call of this.#active.values()) if (call.provider === id) call.abort.abort();
    this.#providers.delete(id);
  }
  accept(raw: unknown): boolean {
    if (!raw || typeof raw !== "object" || !("kind" in raw) || raw.kind !== "clientTools")
      return false;
    const frame = frameSchema.parse(raw);
    if (frame.generation !== this.generation || this.#closed)
      throw new Error("Invalid client tool connection");
    const message = frame.message;
    if (message.type === "result") {
      const pending = this.#pending.get(message.id);
      if (pending) {
        this.#pending.delete(message.id);
        if (message.error !== undefined) pending.reject(new Error(message.error));
        else pending.resolve(message.value);
      }
    } else if (message.type === "cancel") {
      this.#active.get(message.id)?.abort.abort();
    } else {
      if (this.#active.size >= HARNESS_BROKER_MAX_PENDING_REQUESTS || this.#active.has(message.id))
        throw new Error("Client tool request limit exceeded");
      const abort = new AbortController();
      this.#active.set(message.id, { provider: message.provider, abort });
      void this.#serve(message, abort).finally(() => this.#active.delete(message.id));
    }
    return true;
  }
  async #serve(
    message: Extract<Message, { type: "list" | "call" }>,
    abort: AbortController,
  ): Promise<void> {
    let result: Message;
    try {
      const provider = this.#providers.get(message.provider);
      if (!provider) throw new Error("Client tools are no longer owned by this connection");
      const value =
        message.type === "list"
          ? await provider.list()
          : await provider.call({
              namespace: message.namespace,
              name: message.name,
              arguments: message.arguments,
              signal: abort.signal,
            });
      result = { type: "result", id: message.id, value };
    } catch (error) {
      result = {
        type: "result",
        id: message.id,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    await this.#send(result).catch(async () => {
      // A screenshot can exceed the frame bound. Return an error instead of leaving a
      // live caller waiting for the full tool timeout.
      await this.#send({
        type: "result",
        id: message.id,
        error: "Client tool result could not be delivered",
      }).catch(() => {});
    });
  }
  #send(message: Message): Promise<void> {
    if (this.#closed) return Promise.reject(new Error("Client tool connection is closed"));
    return this.sendFrame({
      kind: "clientTools",
      version: HARNESS_BROKER_PROTOCOL_VERSION,
      generation: this.generation,
      message,
    });
  }
  async #request(
    message: Extract<Message, { type: "list" | "call" }>,
    signal: Parameters<HarnessClientTools["call"]>[0]["signal"],
  ): Promise<unknown> {
    if (this.#closed || signal.aborted) throw new Error("Client tool call cancelled");
    if (this.#pending.size >= HARNESS_BROKER_MAX_PENDING_REQUESTS)
      throw new Error("Client tool request limit exceeded");
    const response = Promise.withResolvers<unknown>();
    this.#pending.set(message.id, response);
    const abort = () => {
      this.#pending.delete(message.id);
      response.reject(new Error("Client tool call cancelled"));
      void this.#send({ type: "cancel", id: message.id }).catch(() => {});
    };
    signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, message.type === "list" ? 60_000 : 3_600_000);
    timer.unref();
    void this.#send(message).catch(response.reject);
    try {
      return await response.promise;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      this.#pending.delete(message.id);
    }
  }
  remote(provider: string): HarnessClientTools {
    const closing = new AbortController();
    return {
      list: async () =>
        catalogueSchema.parse(
          await this.#request({ type: "list", id: randomUUID(), provider }, closing.signal),
        ),
      call: async (input) => {
        const abort = new AbortController();
        const cancel = () => abort.abort();
        input.signal.addEventListener("abort", cancel, { once: true });
        closing.signal.addEventListener("abort", cancel, { once: true });
        if (input.signal.aborted || closing.signal.aborted) abort.abort();
        try {
          return jsonObjectSchema.parse(
            await this.#request(
              {
                type: "call",
                id: randomUUID(),
                provider,
                namespace: input.namespace,
                name: input.name,
                arguments: input.arguments,
              },
              abort.signal,
            ),
          );
        } finally {
          input.signal.removeEventListener("abort", cancel);
          closing.signal.removeEventListener("abort", cancel);
        }
      },
      close: () => closing.abort(),
    };
  }
  close(): void {
    this.#closed = true;
    for (const pending of this.#pending.values())
      pending.reject(new Error("Client tool connection closed"));
    this.#pending.clear();
    for (const call of this.#active.values()) call.abort.abort();
    this.#active.clear();
    this.#providers.clear();
  }
}
