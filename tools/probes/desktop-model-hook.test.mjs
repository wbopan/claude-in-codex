import assert from "node:assert/strict";
import { test } from "vitest";
import vm from "node:vm";
import { installDesktopModelHook } from "./desktop-model-hook.mjs";
import { refreshDesktopModelCatalogue } from "./desktop-model-refresh.mjs";

function fixture() {
  class Connection {
    constructor(hostId = "local") {
      this.hostId = hostId;
      this.internalResponseHandlers = new Map([["models", { method: "model/list" }]]);
      this.clientRequestQueue = { getResponseMethod: () => undefined };
    }
    routeResponse(response) {
      return response;
    }
    listModels() {}
    getPendingRequestCount() {
      return 0;
    }
  }
  let now = 0;
  const timers = new Set();
  const context = vm.createContext({
    process: {
      mainModule: {
        require: () => ({
          _cache: {
            test: { filename: "/app.asar/.vite/build/src-fixture.js", exports: { Connection } },
          },
        }),
      },
    },
    Date: { now: () => now },
    setInterval(callback) {
      const timer = { callback, unref() {} };
      timers.add(timer);
      return timer;
    },
    clearInterval(timer) {
      timers.delete(timer);
    },
  });
  const install = vm.runInContext(`(${installDesktopModelHook.toString()})`, context);
  return {
    Connection,
    context,
    install,
    timers,
    handle: () => context.__claudeInCodexModelHookProbeV1,
    advance(ms) {
      now += ms;
      for (const timer of [...timers]) timer.callback();
    },
  };
}

const modelResponse = () => ({
  id: "models",
  result: { data: [{ id: "native", model: "native", isDefault: true }], nextCursor: null },
});

test("only local model responses change, with original messages and models preserved", () => {
  const f = fixture();
  f.install();
  const c = new f.Connection();
  const source = modelResponse();
  const changed = c.routeResponse(source);
  assert.equal(changed.result.data.length, 2);
  assert.equal(changed.result.data[1].id, "claude-in-codex-hook-probe");
  assert.equal(changed.result.data[1].isDefault, false);
  assert.equal(source.result.data.length, 1);
  assert.equal(changed.result.data[0], source.result.data[0]);
  assert.equal(new f.Connection("remote").routeResponse(source), source);
  const other = { id: "other", result: { data: [] } };
  assert.equal(c.routeResponse(other), other);
  const failure = { id: "models", error: { code: -1 } };
  assert.equal(c.routeResponse(failure), failure);
  f.handle().detach();
});

test("renderer requests use Desktop pending request metadata too", () => {
  const f = fixture();
  f.install();
  const c = new f.Connection();
  c.internalResponseHandlers.clear();
  c.clientRequestQueue.getResponseMethod = () => "model/list";
  assert.equal(c.routeResponse(modelResponse()).result.data.length, 2);
  f.handle().detach();
});

test("detach restores exact descriptor, removes timer and global, and refreshes once", async () => {
  const f = fixture();
  const before = Object.getOwnPropertyDescriptor(f.Connection.prototype, "routeResponse");
  let cleanups = 0;
  f.install({
    onDetach: () => {
      cleanups++;
    },
  });
  const handle = f.handle();
  assert.throws(() => f.install(), /already attached/);
  handle.detach();
  handle.detach();
  await handle.settled();
  assert.deepEqual(
    Object.getOwnPropertyDescriptor(f.Connection.prototype, "routeResponse"),
    before,
  );
  assert.equal(f.handle(), undefined);
  assert.equal(f.timers.size, 0);
  assert.equal(cleanups, 1);
  assert.equal(handle.status().cleanupFinished, true);
});

test("lost heartbeat restores native dispatch and schedules renderer cleanup", async () => {
  const f = fixture();
  let cleaned = false;
  f.install({
    leaseMs: 1_000,
    onDetach: () => {
      cleaned = true;
    },
  });
  const handle = f.handle();
  f.advance(900);
  handle.heartbeat();
  f.advance(900);
  assert.equal(handle.status().active, true);
  f.advance(101);
  await handle.settled();
  assert.equal(handle.status().reason, "lease-expired");
  assert.equal(handle.status().restored, true);
  assert.equal(cleaned, true);
  const source = modelResponse();
  assert.equal(new f.Connection().routeResponse(source), source);
});

test("an unexpected Desktop response shape detaches and passes through", async () => {
  const f = fixture();
  f.install();
  const handle = f.handle();
  const c = new f.Connection();
  c.clientRequestQueue.getResponseMethod = () => {
    throw Error("changed internals");
  };
  const source = modelResponse();
  assert.equal(c.routeResponse(source), source);
  assert.equal(handle.status().reason, "incompatible-response-shape");
  assert.equal(handle.status().restored, true);
  await handle.settled();
});

test("detach does not overwrite a newer wrapper and the old wrapper stops rewriting", () => {
  const f = fixture();
  f.install();
  const handle = f.handle();
  const oldWrapper = f.Connection.prototype.routeResponse;
  const newer = function (...args) {
    return oldWrapper.apply(this, args);
  };
  f.Connection.prototype.routeResponse = newer;
  handle.detach();
  assert.equal(f.Connection.prototype.routeResponse, newer);
  assert.equal(handle.status().restored, false);
  const source = modelResponse();
  assert.equal(new f.Connection().routeResponse(source), source);
});

test("renderer cleanup errors are observable and do not leave the protocol patched", async () => {
  const f = fixture();
  f.install({
    onDetach: () => {
      throw Error("renderer gone");
    },
  });
  const handle = f.handle();
  handle.detach();
  await handle.settled();
  assert.equal(handle.status().restored, true);
  assert.match(handle.status().cleanupError, /renderer gone/);
});

test("refresh targets only the mounted local model catalogue", async () => {
  const calls = [];
  const client = {
    getQueryCache: () => ({
      findAll: (filter) => {
        calls.push(["find", filter.queryKey]);
        return [{ queryKey: ["models", "list", "local"], state: { data: { data: [] } } }];
      },
    }),
    invalidateQueries: async (filter) => calls.push(["invalidate", filter.queryKey]),
  };
  const fiber = { memoizedProps: { client }, child: { memoizedProps: { value: client } } };
  const context = vm.createContext({
    document: {
      getElementById: () => ({ __reactContainer$test: { stateNode: { current: fiber } } }),
    },
  });
  await vm.runInContext(`(${refreshDesktopModelCatalogue.toString()})()`, context);
  assert.equal(
    JSON.stringify(calls),
    JSON.stringify([
      ["find", ["models", "list", "local"]],
      ["invalidate", ["models", "list", "local"]],
    ]),
  );
});
