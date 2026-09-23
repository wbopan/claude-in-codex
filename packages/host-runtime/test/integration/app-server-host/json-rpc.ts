import type { PassThrough } from "node:stream";

import { expect, vi } from "vitest";
import type { JsonObject } from "@claude-in-codex/protocol-core";

export class JsonLineCollector {
  readonly messages: JsonObject[] = [];
  readonly #waiters: Array<{
    predicate: (message: JsonObject) => boolean;
    resolve(message: JsonObject): void;
    timeout: ReturnType<typeof setTimeout>;
  }> = [];
  #buffer = "";

  constructor(stream: PassThrough) {
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      this.#buffer += chunk;
      let newline = this.#buffer.indexOf("\n");
      while (newline >= 0) {
        const message = JSON.parse(this.#buffer.slice(0, newline)) as JsonObject;
        this.#buffer = this.#buffer.slice(newline + 1);
        this.messages.push(message);
        const matched = this.#waiters.filter(({ predicate }) => predicate(message));
        for (const waiter of matched) {
          const index = this.#waiters.indexOf(waiter);
          if (index >= 0) this.#waiters.splice(index, 1);
          clearTimeout(waiter.timeout);
          waiter.resolve(message);
        }
        newline = this.#buffer.indexOf("\n");
      }
    });
  }

  waitFor(predicate: (message: JsonObject) => boolean): Promise<JsonObject> {
    const existing = this.messages.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise<JsonObject>((resolve, reject) => {
      const waiter = {
        predicate,
        resolve,
        timeout: setTimeout(() => {
          const index = this.#waiters.indexOf(waiter);
          if (index >= 0) this.#waiters.splice(index, 1);
          reject(new Error("Timed out waiting for Host output"));
        }, 2_000),
      };
      this.#waiters.push(waiter);
    });
  }
}

export function method(message: JsonObject, value: string): boolean {
  return message.method === value;
}

export function requestId(message: JsonObject, id: number): boolean {
  return message.id === id;
}

export function requiredMessageId(message: JsonObject): string | number {
  if (typeof message.id === "string" || typeof message.id === "number") return message.id;
  throw new Error("JSON-RPC message has no ID");
}

export function messageParams(message: JsonObject): JsonObject {
  return (message.params ?? {}) as JsonObject;
}

export function threadStatus(message: JsonObject, threadId: string, type: string): boolean {
  const params = messageParams(message);
  return (
    method(message, "thread/status/changed") &&
    params.threadId === threadId &&
    (params.status as JsonObject | undefined)?.type === type
  );
}

export function turnEvent(message: JsonObject, eventMethod: string, turnId: string): boolean {
  const params = messageParams(message);
  return (
    method(message, eventMethod) &&
    ((params.turn as JsonObject | undefined)?.id === turnId || params.turnId === turnId)
  );
}

export function writeRequest(stream: PassThrough, value: JsonObject): void {
  stream.write(`${JSON.stringify(value)}\n`);
}

const jsonLineBuffers = new WeakMap<PassThrough, string>();

export async function readJsonLine(stream: PassThrough): Promise<JsonObject> {
  let buffer = jsonLineBuffers.get(stream) ?? "";
  if (!buffer.includes("\n")) {
    await vi.waitFor(() => {
      const chunk = stream.read() as Buffer | string | null;
      if (chunk !== null) buffer += String(chunk);
      expect(buffer).toContain("\n");
    });
  }
  const newline = buffer.indexOf("\n");
  const line = buffer.slice(0, newline);
  jsonLineBuffers.set(stream, buffer.slice(newline + 1));
  return JSON.parse(line) as JsonObject;
}
