import { randomUUID } from "node:crypto";
import { PassThrough, Writable } from "node:stream";
import type { JsonObject } from "@codexhost/protocol-core";
import type {
  OfficialAppServerConnection,
  OfficialAppServerExit,
} from "../official-app-server-connection.js";
import type { OwnedOfficialBackend } from "../codex-runtime/official-runtime-owner.js";

/** A lease on virtual clients, never ownership of the signed native process. */
export class BorrowedDesktopBackend implements OwnedOfficialBackend {
  readonly #closed = Promise.withResolvers<OfficialAppServerExit>();
  readonly closed = this.#closed.promise;
  readonly #clients = new Map<string, { output: PassThrough; close(): void }>();
  #stopped = false;
  constructor(
    readonly processId: number,
    private readonly send: (value: Record<string, unknown>) => void,
  ) {}
  async start(): Promise<void> {
    if (this.#stopped) throw new Error("Desktop attachment is closed");
  }
  async connect(): Promise<OfficialAppServerConnection> {
    if (this.#stopped) throw new Error("Desktop attachment is closed");
    const channel = randomUUID();
    const output = new PassThrough();
    const stderr = new PassThrough();
    const ended = Promise.withResolvers<OfficialAppServerExit>();
    let buffer = "",
      closed = false;
    const input = new Writable({
      write: (chunk, _encoding, callback) => {
        try {
          buffer += chunk.toString();
          let end: number;
          while ((end = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, end);
            buffer = buffer.slice(end + 1);
            if (line) this.send({ type: "native", channel, message: JSON.parse(line) });
          }
          callback();
        } catch (error) {
          callback(error instanceof Error ? error : new Error(String(error)));
        }
      },
    });
    const close = (): void => {
      if (closed) return;
      closed = true;
      this.#clients.delete(channel);
      this.send({ type: "close", channel });
      input.destroy();
      output.end();
      stderr.end();
      ended.resolve({ code: 0, signal: null });
    };
    this.#clients.set(channel, { output, close });
    this.send({ type: "open", channel });
    return {
      processId: this.processId,
      stdin: input,
      stdout: output,
      stderr,
      closed: ended.promise,
      close,
    };
  }
  receive(channel: string, message: JsonObject): void {
    this.#clients.get(channel)?.output.write(`${JSON.stringify(message)}\n`);
  }
  async stop(): Promise<void> {
    this.#stopped = true;
    for (const client of [...this.#clients.values()]) client.close();
    this.#closed.resolve({ code: 0, signal: null });
  }
}
