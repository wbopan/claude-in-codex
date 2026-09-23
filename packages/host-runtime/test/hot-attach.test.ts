import { EventEmitter } from "node:events";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { installDesktopAgent } from "../src/hot-attach/desktop-agent.js";
import { BorrowedDesktopBackend } from "../src/hot-attach/borrowed-backend.js";

/** A JSON frame the agent wrote; tests read only the fields they know it carries. */
interface Frame {
  type?: string;
  channel?: string;
  id?: unknown;
  method?: string;
  body?: string;
  params?: unknown;
  result?: unknown;
  message?: { id?: unknown; result?: { codexHome?: string } };
}

function fixture() {
  const wire: Frame[] = [],
    native: Frame[] = [],
    desktop: Frame[] = [],
    routed: unknown[] = [];
  class Socket extends EventEmitter {
    destroyed = false;
    writableLength = 0;
    setEncoding() {}
    write(text: string) {
      wire.push(JSON.parse(text));
    }
    end(text: string) {
      this.write(text);
    }
    destroySoon() {
      this.destroyed = true;
    }
  }
  const socket = new Socket();
  class Connection {
    hostId = "local";
    initialized = true;
    initializedCodexHome = "/fixture/codex";
    initializedPlatformFamily = "unix";
    initializedPlatformOs = "macos";
    initializedAppServerVersion = "1.0";
    connection = {
      proc: { pid: 54321 },
      send(text: string) {
        native.push(JSON.parse(text));
      },
    };
    routeResponse(response: unknown) {
      routed.push(response);
      return "native-response";
    }
    routeIncomingMessage(message: Frame) {
      desktop.push(message);
      return "native-route";
    }
    async sendAppServerRequest(method: string, params: unknown) {
      this.connection.send(JSON.stringify({ id: "native-cleanup", method, params }));
    }
    listModels() {}
    sendInternalRequest() {}
    getPendingRequestCount() {}
    getTransportKind() {
      return "stdio";
    }
  }
  const connection = new Connection();
  const timers: (() => void)[] = [];
  let now = 0;
  const nativeFetch: (input: string) => Promise<Response> = async () =>
    new Response('{"rate_limit":{"allowed":true}}', {
      headers: { "content-type": "application/json" },
    });
  const electron = {
    app: { getVersion: () => "26.915.31945" },
    webContents: { getAllWebContents: () => [] },
    net: { fetch: nativeFetch },
  };
  const context = vm.createContext({
    Buffer,
    URL,
    Headers,
    Response,
    Date: { now: () => now },
    process: {
      pid: 12345,
      env: {},
      mainModule: {
        require: (name: string) => {
          if (name === "electron") return electron;
          if (name === "node:net") return { createConnection: () => socket };
          if (name === "node:module")
            return { _cache: { "/app/.vite/build/src-fixture.js": { exports: { Connection } } } };
          throw new Error(name);
        },
      },
    },
    setInterval: (fn: () => void) => {
      timers.push(fn);
      return { unref() {} };
    },
    clearInterval() {},
    setTimeout,
    clearTimeout,
  });
  const originalSend = connection.connection.send,
    originalIncoming = connection.routeIncomingMessage;
  const originalDiscovery = Object.getOwnPropertyDescriptor(Connection.prototype, "routeResponse");
  vm.runInContext(
    `(${installDesktopAgent.toString()})(${JSON.stringify({ socketPath: "/fixture/socket", token: "test-token", leaseMs: 5000, refresh: "true" })})`,
    context,
  );
  connection.routeResponse({ id: "old", result: {} });
  socket.emit("connect");
  const receive = (value: unknown) => socket.emit("data", JSON.stringify(value) + "\n");
  receive({ type: "open", channel: "primary" });
  receive({ type: "activate" });
  return {
    wire,
    native,
    desktop,
    routed,
    connection,
    receive,
    context,
    electron,
    socket,
    originalSend,
    originalIncoming,
    originalDiscovery,
    Connection,
    expire: () => {
      now = 6000;
      timers.forEach((fn) => fn());
    },
  };
}

describe("memory-only Desktop bridge", () => {
  it("rejects a second owner without detaching the existing Host", () => {
    const f = fixture();
    expect(() => vm.runInContext(`(${installDesktopAgent.toString()})({})`, f.context)).toThrow(
      "already attached",
    );
    expect(vm.runInContext("__claudeInCodexHotAttachV1.status().phase", f.context)).toBe(
      "attached",
    );
    f.receive({ type: "detach", reason: "test" });
  });
  it("does not duplicate a completed turn when the Host disconnects before the next heartbeat", () => {
    const f = fixture();
    f.receive({ type: "heartbeat", activeExternal: [{ threadId: "claude", turnId: "one" }] });
    f.receive({
      type: "desktop",
      message: {
        method: "turn/completed",
        params: { threadId: "claude", turn: { id: "one", status: "completed" } },
      },
    });
    f.receive({ type: "detach", reason: "test" });
    expect(f.desktop.filter((m) => m.method === "turn/completed")).toHaveLength(1);
  });
  it("borrows the existing initialized backend and correlates virtual clients without sending initialize again", () => {
    const f = fixture();
    f.receive({
      type: "native",
      channel: "primary",
      message: { id: "init", method: "initialize" },
    });
    expect(f.native).toEqual([]);
    expect(f.routed).toEqual([{ id: "old", result: {} }]);
    expect(f.wire.at(-1)?.message?.result?.codexHome).toBe("/fixture/codex");
    f.receive({ type: "open", channel: "tools" });
    for (const channel of ["primary", "tools"])
      f.receive({ type: "native", channel, message: { id: 1, method: "model/list", params: {} } });
    expect(f.native).toHaveLength(2);
    expect(f.native[0]?.id).not.toBe(f.native[1]?.id);
    f.native.forEach((request) =>
      f.connection.routeIncomingMessage({ id: request.id, result: { data: [] } }),
    );
    expect(f.wire.slice(-2).map((m) => [m.channel, m.message?.id])).toEqual([
      ["primary", 1],
      ["tools", 1],
    ]);
    f.receive({ type: "detach", reason: "test" });
  });
  it("preserves pre-attach replies and other hosts, with notifications on the primary path", () => {
    const f = fixture();
    const pre = { id: "old-request", result: { ok: true } };
    f.connection.routeIncomingMessage(pre);
    expect(f.desktop).toEqual([pre]);
    const remote = new f.Connection();
    remote.hostId = "durable";
    remote.routeIncomingMessage({ method: "turn/started", params: {} });
    expect(f.desktop).toHaveLength(2);
    remote.connection.send(JSON.stringify({ id: "cloud-models", method: "model/list" }));
    expect(f.native.at(-1)).toEqual({ id: "cloud-models", method: "model/list" });
    expect(Object.hasOwn(remote, "routeIncomingMessage")).toBe(false);
    f.connection.routeIncomingMessage({ method: "turn/completed", params: { threadId: "native" } });
    expect(f.wire.at(-1)?.channel).toBe("primary");
    f.receive({ type: "detach", reason: "test" });
  });
  it("routes native tool elicitations to the client that created their context", () => {
    const f = fixture();
    f.receive({ type: "open", channel: "tools" });
    f.receive({
      type: "native",
      channel: "tools",
      message: { id: "start", method: "thread/start", params: { ephemeral: true } },
    });
    expect(f.native).toHaveLength(1);
    f.connection.routeIncomingMessage({
      id: f.native[0]?.id,
      result: { thread: { id: "context" } },
    });
    f.connection.routeIncomingMessage({
      id: 42,
      method: "mcpServer/elicitation/request",
      params: { threadId: "context" },
    });
    expect(f.wire.at(-1)?.channel).toBe("tools");
    f.receive({ type: "close", channel: "tools" });
    expect(f.native.at(-1)).toMatchObject({
      method: "thread/unsubscribe",
      params: { threadId: "context" },
    });
    expect(f.wire.filter((m) => m.type === "desktop")).toEqual([]);
    f.receive({ type: "detach", reason: "test" });
  });
  it("restores the exact descriptors on lease loss, fails pending work once, and never replays it", () => {
    const f = fixture();
    f.connection.connection.send(
      JSON.stringify({ id: "mutating", method: "thread/start", params: {} }),
    );
    f.expire();
    expect(f.connection.connection.send).toBe(f.originalSend);
    expect(f.connection.routeIncomingMessage).toBe(f.originalIncoming);
    expect(Object.getOwnPropertyDescriptor(f.Connection.prototype, "routeResponse")).toEqual(
      f.originalDiscovery,
    );
    expect(Object.hasOwn(f.connection, "routeIncomingMessage")).toBe(false);
    expect(f.native).toEqual([]);
    expect(f.desktop).toMatchObject([{ id: "mutating", error: { code: -32089 } }]);
    expect(vm.runInContext("globalThis.__claudeInCodexHotAttachV1", f.context)).toBeUndefined();
  });
  it("does not overwrite a later owner of an instance method", () => {
    const f = fixture();
    const replacement = () => {};
    f.connection.connection.send = replacement;
    f.receive({ type: "detach", reason: "test" });
    expect(f.connection.connection.send).toBe(replacement);
  });
  it("extends only the exact usage response and leaves auth and unrelated responses on the native transport", async () => {
    const f = fixture();
    const nativeResponse = await f.electron.net.fetch("https://chatgpt.com/backend-api/me");
    expect(await nativeResponse.json()).toEqual({ rate_limit: { allowed: true } });
    const response = f.electron.net.fetch("https://chatgpt.com/backend-api/wham/usage");
    const request = await vi.waitFor(() => {
      const frame = f.wire.find((m) => m.type === "usage");
      if (!frame) throw new Error("The agent has not forwarded the usage body yet");
      return frame;
    });
    expect(request.body).toContain("rate_limit");
    f.receive({ type: "usage", id: request.id, body: '{"ambient_usage":{"default":{}}}' });
    expect(await (await response).json()).toEqual({ ambient_usage: { default: {} } });
    f.receive({ type: "detach", reason: "test" });
  });
});

it("closing borrowed virtual clients never owns or signals the official process", async () => {
  const wire: Record<string, unknown>[] = [];
  const backend = new BorrowedDesktopBackend(1234, (value) => wire.push(value));
  await backend.start();
  const client = await backend.connect();
  expect(client.stopProcess).toBeUndefined();
  const channel = wire[0]?.channel;
  if (typeof channel !== "string") throw new Error("The backend did not open a channel");
  const received: string[] = [];
  client.stdout.on("data", (value) => received.push(value.toString()));
  backend.receive(channel, { id: "a", result: {} });
  expect(received).toHaveLength(1);
  expect(JSON.parse(received[0] ?? "")).toEqual({ id: "a", result: {} });
  await backend.stop();
  expect(await backend.closed).toEqual({ code: 0, signal: null });
  expect(wire.map((value) => value.type)).toEqual(["open", "close"]);
});
