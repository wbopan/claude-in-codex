interface CdpSocketEvent {
  data?: unknown;
}

interface CdpSocket {
  addEventListener(
    type: "open" | "message" | "error" | "close",
    listener: (event: CdpSocketEvent) => void,
  ): void;
  removeEventListener(
    type: "open" | "message" | "error" | "close",
    listener: (event: CdpSocketEvent) => void,
  ): void;
  send(data: string): void;
  close(): void;
}

export type CdpSocketFactory = (url: string) => CdpSocket;

export interface CdpClientOptions {
  commandTimeoutMs?: number;
  connectTimeoutMs?: number;
  socketFactory?: CdpSocketFactory;
}

export type CdpEventListener = (params: unknown, sessionId: string | undefined) => void;

interface PendingCommand {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timeout: NodeJS.Timeout;
}

interface CdpResponse {
  id: number;
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function loopbackUrl(value: string, protocols: readonly string[]): URL {
  const url = new URL(value);
  if (!protocols.includes(url.protocol)) {
    throw new Error(`CDP endpoint must use ${protocols.join(" or ")}`);
  }
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    throw new Error("CDP endpoint must use a loopback host");
  }
  return url;
}

function defaultSocketFactory(url: string): CdpSocket {
  return new WebSocket(url) as unknown as CdpSocket;
}

function messageText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof ArrayBuffer) return new TextDecoder().decode(value);
  if (ArrayBuffer.isView(value)) {
    return new TextDecoder().decode(
      new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
    );
  }
  throw new Error("CDP WebSocket returned a non-text message");
}

function parseResponse(value: unknown): CdpResponse | null {
  if (!isRecord(value) || typeof value.id !== "number") return null;
  const response: CdpResponse = { id: value.id };
  if ("result" in value) response.result = value.result;
  if (isRecord(value.error)) {
    response.error = {
      ...(typeof value.error.code === "number" ? { code: value.error.code } : {}),
      ...(typeof value.error.message === "string" ? { message: value.error.message } : {}),
    };
  }
  return response;
}

export class CdpClient {
  readonly #commandTimeoutMs: number;
  readonly #socket: CdpSocket;
  #closed = false;
  #nextId = 1;
  #pending = new Map<number, PendingCommand>();
  #listeners = new Map<string, Set<CdpEventListener>>();

  private constructor(socket: CdpSocket, commandTimeoutMs: number) {
    this.#socket = socket;
    this.#commandTimeoutMs = commandTimeoutMs;
    socket.addEventListener("message", (event) => this.#onMessage(event));
    socket.addEventListener("error", () => this.#fail(new Error("CDP WebSocket failed")));
    socket.addEventListener("close", () => this.#fail(new Error("CDP WebSocket closed")));
  }

  static async connect(url: string, options: CdpClientOptions = {}): Promise<CdpClient> {
    loopbackUrl(url, ["ws:", "wss:"]);
    const socketFactory = options.socketFactory ?? defaultSocketFactory;
    const socket = socketFactory(url);
    const connectTimeoutMs = options.connectTimeoutMs ?? 10_000;
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        socket.close();
        reject(new Error("CDP WebSocket connection timed out"));
      }, connectTimeoutMs);
      const onOpen = (): void => {
        cleanup();
        resolve();
      };
      const onError = (): void => {
        cleanup();
        reject(new Error("CDP WebSocket connection failed"));
      };
      const cleanup = (): void => {
        clearTimeout(timeout);
        socket.removeEventListener("open", onOpen);
        socket.removeEventListener("error", onError);
      };
      socket.addEventListener("open", onOpen);
      socket.addEventListener("error", onError);
    });
    return new CdpClient(socket, options.commandTimeoutMs ?? 10_000);
  }

  command(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    return this.#send(method, params);
  }

  sessionCommand(
    sessionId: string,
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<unknown> {
    if (sessionId.length === 0) return Promise.reject(new Error("CDP session ID is required"));
    return this.#send(method, params, sessionId);
  }

  on(method: string, listener: CdpEventListener): () => void {
    const listeners = this.#listeners.get(method) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(method, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.#listeners.delete(method);
    };
  }

  #send(method: string, params: Record<string, unknown>, sessionId?: string): Promise<unknown> {
    if (this.#closed) return Promise.reject(new Error("CDP client is closed"));
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`CDP command '${method}' timed out`));
      }, this.#commandTimeoutMs);
      this.#pending.set(id, { resolve, reject, timeout });
      try {
        this.#socket.send(
          JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }),
        );
      } catch (error) {
        clearTimeout(timeout);
        this.#pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  async evaluate<T>(expression: string): Promise<T> {
    const response = await this.command("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (!isRecord(response)) throw new Error("Runtime.evaluate returned an invalid result");
    if (isRecord(response.exceptionDetails)) {
      const text =
        typeof response.exceptionDetails.text === "string"
          ? response.exceptionDetails.text
          : "Runtime evaluation failed";
      throw new Error(text);
    }
    if (!isRecord(response.result) || !("value" in response.result)) {
      throw new Error("Runtime.evaluate did not return a value");
    }
    return response.result.value as T;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#fail(new Error("CDP client closed"));
    this.#listeners.clear();
    this.#socket.close();
  }

  #onMessage(event: CdpSocketEvent): void {
    try {
      const value: unknown = JSON.parse(messageText(event.data));
      const response = parseResponse(value);
      if (!response) {
        if (!isRecord(value) || typeof value.method !== "string") return;
        const sessionId = typeof value.sessionId === "string" ? value.sessionId : undefined;
        for (const listener of this.#listeners.get(value.method) ?? []) {
          listener(value.params, sessionId);
        }
        return;
      }
      const pending = this.#pending.get(response.id);
      if (!pending) return;
      clearTimeout(pending.timeout);
      this.#pending.delete(response.id);
      if (response.error) {
        const code = response.error.code === undefined ? "unknown" : String(response.error.code);
        pending.reject(
          new Error(response.error.message ?? `CDP command failed with error ${code}`),
        );
      } else {
        pending.resolve(response.result);
      }
    } catch (error) {
      this.#fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  #fail(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}
