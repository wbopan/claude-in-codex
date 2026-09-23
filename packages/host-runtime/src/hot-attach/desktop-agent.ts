// Both functions are serialized with Function.prototype.toString() and evaluated inside the
// Codex App (Electron main realm and renderer), where they reach undocumented internals. Typing
// them would take a cast on nearly every line, and the renderer half needs DOM types that
// host-runtime does not load, so the file opts out of type checking entirely.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment -- see above
// @ts-nocheck -- Serialized into the version-checked Desktop's main realm. No imports/closures.
/** All mutations are instance-local and have descriptor-preserving cleanup. */
export function installDesktopAgent(config) {
  const key = "__claudeInCodexHotAttachV1";
  // A pre-rename Host installs the same agent under its legacy key.
  if (globalThis[key] || globalThis.__codexhostHotAttachV1)
    throw new Error("A Host is already attached or attaching");
  const require = process.mainModule.require.bind(process.mainModule);
  const electron = require("electron");
  const net = require("node:net");
  const candidates = new Set();
  for (const [name, module] of Object.entries(require("node:module")._cache)) {
    if (!/\/\.vite\/build\/src-[^/]+\.js$/.test(name)) continue;
    for (const value of Object.values(module.exports)) {
      const p = typeof value === "function" && value.prototype;
      if (
        p &&
        [
          "routeResponse",
          "routeIncomingMessage",
          "listModels",
          "sendInternalRequest",
          "getPendingRequestCount",
        ].every((name) => typeof p[name] === "function")
      )
        candidates.add(p);
    }
  }
  if (candidates.size !== 1)
    throw new Error(
      `Desktop ${electron.app.getVersion()} changed its connection layout; update the Host adapter`,
    );
  const prototype = [...candidates][0];
  const restorers = [];
  let connection, transport, socket, incoming, outgoing;
  let phase = "discovering",
    reason = null,
    buffer = "",
    primary = null;
  let deadline = Date.now() + config.leaseMs,
    counter = 0;
  const channels = new Set(),
    pending = new Map(),
    desktopPending = new Map();
  const threadOwners = new Map(),
    releasingThreads = new Set();
  const usagePending = new Map();
  const usage = { requests: 0, rewritten: 0, timedOut: 0 };
  let activeExternal = [];
  const patch = (target, name, wrapper) => {
    const descriptor = Object.getOwnPropertyDescriptor(target, name);
    if (descriptor && !descriptor.configurable) throw new Error(`Cannot patch ${name}`);
    const original = target[name];
    const replacement = wrapper(original);
    Object.defineProperty(target, name, {
      configurable: true,
      writable: true,
      enumerable: descriptor?.enumerable ?? false,
      value: replacement,
    });
    const restore = () => {
      if (target[name] !== replacement) return;
      if (descriptor) Object.defineProperty(target, name, descriptor);
      else Reflect.deleteProperty(target, name);
    };
    restorers.push(restore);
    return restore;
  };
  const refresh = async (expression = config.refresh) => {
    const results = await Promise.allSettled(
      electron.webContents
        .getAllWebContents()
        .filter((w) => !w.isDestroyed() && w.getURL().startsWith("app://-/index.html"))
        .map((w) => w.executeJavaScript(expression)),
    );
    return results.map((r) => (r.status === "fulfilled" ? r.value : { error: String(r.reason) }));
  };
  const deliver = (message) => {
    if (message.method === "turn/completed")
      activeExternal = activeExternal.filter(
        (turn) =>
          turn.threadId !== message.params?.threadId || turn.turnId !== message.params?.turn?.id,
      );
    return incoming.call(connection, message, Buffer.byteLength(JSON.stringify(message)));
  };
  const releaseThread = (threadId) => {
    if (releasingThreads.has(threadId)) return;
    releasingThreads.add(threadId);
    // Use Desktop's own correlation table, bypassing only this cleanup request in send().
    // Borrowed clients cannot rely on killing the backend to release their ephemeral MCP contexts.
    void connection
      .sendAppServerRequest("thread/unsubscribe", { threadId })
      .catch(() => {})
      .finally(() => {
        releasingThreads.delete(threadId);
        threadOwners.delete(threadId);
      });
  };
  const send = (value) => {
    if (!socket || socket.destroyed || socket.writableLength > 32 * 1024 * 1024) {
      detach("bridge-unavailable");
      return false;
    }
    socket.write(`${JSON.stringify(value)}\n`);
    return true;
  };
  function detach(why = "requested") {
    if (phase === "detached") return;
    phase = "detached";
    reason = why;
    clearInterval(timer);
    for (const restore of restorers.reverse()) restore();
    for (const threadId of threadOwners.keys()) releaseThread(threadId);
    // Never replay a request whose side effects may already have happened.
    for (const { id } of desktopPending.values()) {
      try {
        deliver({
          id,
          error: {
            code: -32089,
            message: "Host disconnected. Reconnect to continue external tasks; retry explicitly.",
          },
        });
      } catch {}
    }
    desktopPending.clear();
    for (const pending of usagePending.values()) {
      clearTimeout(pending.timer);
      pending.resolve(null);
    }
    usagePending.clear();
    for (const { threadId, turnId } of activeExternal) {
      try {
        deliver({
          method: "turn/completed",
          params: { threadId, turn: { id: turnId, items: [], status: "interrupted", error: null } },
        });
      } catch {}
    }
    socket?.end(JSON.stringify({ type: "detached", reason: why }) + "\n");
    socket?.destroySoon();
    if (/^\/tmp\/claude-in-codex-attach-[^/]+\/bridge\.sock$/.test(config.socketPath)) {
      const fs = require("node:fs");
      fs.unlink(config.socketPath, () => fs.rmdir(config.socketPath.slice(0, -12), () => {}));
    }
    if (globalThis[key] === handle) Reflect.deleteProperty(globalThis, key);
    handle.cleanup = refresh();
  }
  function activate() {
    if (phase !== "connecting") throw new Error("Unexpected activation");
    outgoing = transport.send;
    incoming = connection.routeIncomingMessage;
    patch(
      transport,
      "send",
      (original) =>
        function (text) {
          if (phase !== "attached") return original.call(this, text);
          const message = JSON.parse(text);
          if (
            message.method === "thread/unsubscribe" &&
            releasingThreads.has(message.params?.threadId)
          )
            return original.call(this, text);
          if (message.method && message.id !== undefined)
            desktopPending.set(String(message.id), message);
          if (!send({ type: "desktop", message })) {
            // detach has explicitly failed pending requests. Never send a possible duplicate.
            return;
          }
        },
    );
    patch(
      connection,
      "routeIncomingMessage",
      (original) =>
        function (message, ...rest) {
          if (phase !== "attached") return original.call(this, message, ...rest);
          if (message.id !== undefined && !message.method) {
            const item = pending.get(String(message.id));
            if (!item) return original.call(this, message, ...rest); // Pre-attach request.
            pending.delete(String(message.id));
            const threadId = message.result?.thread?.id;
            if (threadId && item.channel !== primary) threadOwners.set(threadId, item.channel);
            send({ type: "native", channel: item.channel, message: { ...message, id: item.id } });
          } else if (message.method) {
            const channel = threadOwners.get(message.params?.threadId) ?? primary;
            if (!send({ type: "native", channel, message }))
              return original.call(this, message, ...rest);
          } else return original.call(this, message, ...rest);
          return {
            routeKind: message.method ? "notification" : "response",
            method: message.method ?? null,
          };
        },
    );
    // The Desktop's native HTTP transport retains auth, routing and TLS. Only a successful
    // usage payload is extended, using the same publisher as the legacy launch proxy.
    patch(
      electron.net,
      "fetch",
      (original) =>
        async function (input, options) {
          const response = await original.call(this, input, options);
          if (phase !== "attached") return response;
          let url;
          try {
            url = new URL(typeof input === "string" ? input : (input.url ?? input.href));
          } catch {
            return response;
          }
          if (
            url.pathname !== "/backend-api/wham/usage" ||
            (options?.method ?? "GET") !== "GET" ||
            response.status !== 200 ||
            !response.headers.get("content-type")?.includes("json")
          )
            return response;
          usage.requests++;
          try {
            const body = await response.clone().text();
            if (body.length > 2 * 1024 * 1024) return response;
            const id = `usage:${++counter}`;
            const rewritten = await new Promise((resolve) => {
              const timer = setTimeout(() => {
                usagePending.delete(id);
                usage.timedOut++;
                resolve(null);
              }, 1500);
              usagePending.set(id, { resolve, timer });
              send({ type: "usage", id, body });
            });
            if (!rewritten || phase !== "attached") return response;
            const headers = new Headers(response.headers);
            headers.delete("content-length");
            headers.delete("content-encoding");
            const result = new Response(rewritten, {
              status: response.status,
              statusText: response.statusText,
              headers,
            });
            for (const name of ["url", "redirected", "type"])
              Object.defineProperty(result, name, { value: response[name], configurable: true });
            usage.rewritten++;
            return result;
          } catch {
            return response;
          }
        },
    );
    phase = "attached";
    send({ type: "attached", backendPid: transport.proc.pid });
    void refresh();
  }
  function receive(value) {
    if (value.type === "usage") {
      const pending = usagePending.get(value.id);
      if (pending) {
        usagePending.delete(value.id);
        clearTimeout(pending.timer);
        pending.resolve(value.body);
      }
    } else if (value.type === "heartbeat") {
      deadline = Date.now() + config.leaseMs;
      activeExternal = value.activeExternal ?? [];
      send({ type: "heartbeat", pending: desktopPending.size, backendPending: pending.size });
    } else if (value.type === "open") {
      channels.add(value.channel);
      primary ??= value.channel;
    } else if (value.type === "close") {
      channels.delete(value.channel);
      for (const [id, owner] of threadOwners) if (owner === value.channel) releaseThread(id);
    } else if (value.type === "activate") activate();
    else if (value.type === "detach") detach(value.reason);
    else if (value.type === "refresh") void refresh();
    else if (value.type === "usage-ready") void refresh(config.refreshUsage ?? config.refresh);
    else if (value.type === "desktop" && phase === "attached") {
      if (value.message.id !== undefined && !value.message.method)
        desktopPending.delete(String(value.message.id));
      deliver(value.message);
    } else if (value.type === "native" && channels.has(value.channel)) {
      const message = value.message;
      if (message.method === "initialize") {
        send({
          type: "native",
          channel: value.channel,
          message: {
            id: message.id,
            result: {
              userAgent: `codex/${connection.initializedAppServerVersion ?? "unknown"}`,
              codexHome: connection.initializedCodexHome,
              platformFamily: connection.initializedPlatformFamily,
              platformOs: connection.initializedPlatformOs,
            },
          },
        });
      } else if (message.method === "initialized") {
        // This virtual client borrows the already negotiated native connection.
      } else if (message.method && message.id !== undefined) {
        const id = `claude-in-codex:bridge:${config.token.slice(0, 8)}:${++counter}`;
        pending.set(id, { channel: value.channel, id: message.id });
        outgoing.call(transport, JSON.stringify({ ...message, id }));
      } else {
        outgoing.call(transport, JSON.stringify(message));
      }
    }
  }
  function capture(candidate) {
    if (
      connection ||
      phase !== "discovering" ||
      candidate.hostId !== "local" ||
      candidate.getTransportKind() !== "stdio" ||
      !candidate.initialized ||
      !candidate.connection?.proc?.pid
    )
      return;
    connection = candidate;
    transport = candidate.connection;
    restoreDiscovery();
    phase = "connecting";
    // Save these before activation so initialization can borrow the live transport.
    incoming = connection.routeIncomingMessage;
    outgoing = transport.send;
    socket = net.createConnection(config.socketPath);
    socket.setEncoding("utf8");
    socket.on("connect", () =>
      send({
        type: "hello",
        token: config.token,
        pid: process.pid,
        backendPid: transport.proc.pid,
        codexHome: connection.initializedCodexHome,
        cliPath: process.env.CODEX_CLI_PATH ?? "",
        appVersion: electron.app.getVersion(),
      }),
    );
    socket.on("error", () => detach("socket-error"));
    socket.on("close", () => detach("host-lost"));
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 64 * 1024 * 1024) return detach("oversized-frame");
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        try {
          receive(JSON.parse(line));
        } catch {
          detach("invalid-bridge-message");
          break;
        }
      }
    });
  }
  const restoreDiscovery = patch(
    prototype,
    "routeResponse",
    (original) =>
      function (...args) {
        capture(this);
        return original.apply(this, args);
      },
  );
  const handle = {
    ownerToken: config.token,
    status: () => ({
      phase,
      reason,
      pid: process.pid,
      backendPid: transport?.proc?.pid,
      pending: desktopPending.size,
      backendPending: pending.size,
      usage: { ...usage },
    }),
    detach,
    cleanup: Promise.resolve(),
  };
  globalThis[key] = handle;
  // detach() reads this timer, but nothing can call detach() before this function returns.
  const timer = setInterval(() => {
    if (Date.now() > deadline) detach("lease-expired");
    else if (connection && connection.connection !== transport) detach("native-backend-changed");
  }, 500);
  timer.unref();
  void refresh();
  return handle.status();
}

// Serialized separately into the renderer. It changes query state, never markup or React props.
export async function refreshDesktopQueries(kind = "all") {
  const root = document.getElementById("root");
  const key = root && Object.keys(root).find((key) => key.startsWith("__reactContainer$"));
  if (!key) return { refreshed: false };
  const stack = [root[key].stateNode?.current ?? root[key]],
    seen = new Set(),
    clients = new Set();
  while (stack.length && seen.size < 30000) {
    const fiber = stack.pop();
    if (!fiber || seen.has(fiber)) continue;
    seen.add(fiber);
    for (const candidate of [fiber.memoizedProps?.client, fiber.memoizedProps?.value])
      if (candidate?.getQueryCache && candidate?.invalidateQueries) clients.add(candidate);
    stack.push(fiber.child, fiber.sibling);
  }
  const keys = [];
  for (const client of clients) {
    if (kind === "usage") {
      await client.invalidateQueries({ queryKey: ["rate-limit-status"], exact: true });
      continue;
    }
    // Host isolation is part of the key. Cloud, SSH and durable caches are untouched.
    await Promise.all([
      client.invalidateQueries({ queryKey: ["models", "list", "local"] }),
      client.invalidateQueries({
        predicate: (q) =>
          (q.queryKey[0] === "config" && q.queryKey[2] === "local") ||
          (q.queryKey[0] === "user-saved-config" && q.queryKey[1] === "local"),
      }),
      client.invalidateQueries({ queryKey: ["rate-limit-status"], exact: true }),
    ]);
    keys.push(
      ...client
        .getQueryCache()
        .findAll({ queryKey: ["models", "list", "local"] })
        .map((q) => ({ key: q.queryKey, models: q.state.data?.data?.map((m) => m.id) })),
    );
  }
  return { refreshed: clients.size > 0, keys };
}
