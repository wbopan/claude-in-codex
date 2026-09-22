// Real protocol acceptance against the explicitly created, disposable stock Desktop fixture.
// Never targets /Applications/ChatGPT.app. No credentials or native account payloads are recorded.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { readFile, writeFile, open, readdir } from "node:fs/promises";
import { createInterface } from "node:readline";
import path from "node:path";
import { CdpClient } from "../../packages/desktop-control/dist/index.js";
import { debugEnvironment } from "../fork/debug.mjs";
const root = path.resolve(import.meta.dirname, "../../.codexhost/hot-attach-research");
const resources = path.resolve(root, "../menubar/Codex Host.app/Contents/Resources");
const state = JSON.parse(await readFile(path.join(root, "probe-state.json"), "utf8"));
const targets = await fetch("http://127.0.0.1:9229/json/list").then((r) => r.json());
const cdp = await CdpClient.connect(targets[0].webSocketDebuggerUrl, { commandTimeoutMs: 30_000 });
assert.equal(await cdp.evaluate("process.pid"), state.probe.pid);
assert.equal(
  await cdp.evaluate("!!globalThis.__codexhostHotAttachV1"),
  false,
  "Detach the MenuBar before running acceptance",
);
const report = { startedAt: new Date().toISOString(), desktopPid: state.probe.pid, checks: [] };
const evidence = (name, value) => {
  report.checks.push({ name, ...value });
  console.log(JSON.stringify({ name, ...value }));
};
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(read, predicate, label, timeout = 60_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await read();
    if (predicate(value)) return value;
    await delay(100);
  }
  throw new Error(`Timed out: ${label}`);
}
const evaluate = (fn, value) => cdp.evaluate(`(${fn.toString()})(${JSON.stringify(value)})`);
async function begin(input) {
  const c = globalThis.__cxConnection;
  if (!c) throw new Error("Capture the isolated connection first");
  const model =
    input.kind === "gpt" ? "gpt-5.6-luna" : "codexhost/claude-code-native@claude-model-v1.aGFpa3U";
  const result = await c.sendAppServerRequest("thread/start", {
    model,
    cwd: input.cwd,
    approvalPolicy: "never",
    sandbox: "read-only",
  });
  const p = { threadId: result.thread.id, text: "", done: false, events: [] };
  globalThis.__cxMenuTests ??= {};
  globalThis.__cxMenuTests[input.name] = p;
  const stopNotifications = c.registerInternalNotificationHandler((m) => {
    if (m.params?.threadId !== p.threadId) return;
    p.events.push(m.method);
    if (m.method === "item/agentMessage/delta") p.text += m.params.delta;
    if (m.method === "turn/completed") {
      p.done = true;
      p.status = m.params.turn.status;
    }
  });
  const stopApprovals = c.registerInternalServerRequestHandler({
    methods: ["mcpServer/elicitation/request"],
    handler: (request) => {
      const params = request.params;
      p.approvals ??= [];
      p.approvals.push({ id: request.id, method: request.method, params });
      if (
        input.name !== "cua" ||
        params?.threadId !== p.threadId ||
        p.approved ||
        params.serverName !== "Claude Code" ||
        params._meta?.codex_approval_kind !== "mcp_tool_call" ||
        !/^(Js|mcp__cua_repl__js)$/i.test(params.message ?? "")
      )
        return null;
      p.approval = { requestId: request.id };
      return new Promise((resolve) => {
        p.answerApproval = resolve;
      });
    },
  });
  p.cleanup = () => {
    stopNotifications();
    stopApprovals();
  };
  const started = await c.sendAppServerRequest("turn/start", {
    threadId: p.threadId,
    effort: "low",
    input: [{ type: "text", text: input.prompt }],
  });
  p.turnId = started.turn.id;
  return { threadId: p.threadId, turnId: p.turnId };
}
const start = (name, kind, prompt) =>
  evaluate(begin, { name, kind, prompt, cwd: path.join(root, "workspace") });
const readTurn = (name) =>
  evaluate((name) => {
    const { cleanup, events, answerApproval, ...p } = globalThis.__cxMenuTests[name];
    return { ...p, eventTypes: [...new Set(events)] };
  }, name);
const finishTurn = (name, timeout = 180_000) =>
  until(
    async () => {
      const turn = await readTurn(name);
      if (name === "cua" && turn.approval && !turn.approved) {
        const mapping = JSON.parse(
          await readFile(
            path.join(root, "host/mapping-store/threads", turn.threadId + ".json"),
            "utf8",
          ),
        );
        const sessionId = mapping.nativeSessionRef.nativeSessionId;
        const projects = path.join(root, "claude/projects");
        let transcript;
        for (const directory of await readdir(projects)) {
          transcript = await readFile(
            path.join(projects, directory, sessionId + ".jsonl"),
            "utf8",
          ).catch(() => undefined);
          if (transcript) break;
        }
        assert(transcript, "Read the actual pending Claude tool input before approving");
        const calls = transcript
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line))
          .flatMap((entry) => (Array.isArray(entry.message?.content) ? entry.message.content : []))
          .filter((block) => block.type === "tool_use");
        const pending = calls.at(-1);
        // SDK permission callbacks can arrive before their assistant message is flushed.
        if (pending?.name !== "mcp__cua_repl__js") return turn;
        assert.match(pending.input.code, /^await cua\.getState\(\);?$/);
        await evaluate(() => {
          const p = __cxMenuTests.cua;
          p.approved = true;
          p.answerApproval({ action: "accept", content: {} });
          delete p.answerApproval;
          return true;
        });
      }
      return turn;
    },
    (p) => p.done,
    name,
    timeout,
  );
const call = (method, params) =>
  evaluate(
    async ({ method, params }) => globalThis.__cxConnection.sendAppServerRequest(method, params),
    { method, params },
  );
const log = await open(path.join(root, "acceptance-host.log"), "a", 0o600);
let host,
  status = {},
  commandNumber = 0;
const replies = new Map();
function launch() {
  host = spawn(
    path.join(resources, "runtime/node"),
    [path.join(resources, "host.mjs"), "--codexhost-menubar"],
    {
      env: {
        ...debugEnvironment(process.env, root),
        CODEXHOST_DESKTOP_APP: path.join(root, "app/ChatGPT.app"),
        CODEXHOST_AUTO_ATTACH: "0",
      },
      stdio: ["pipe", "pipe", log.fd],
    },
  );
  status = {};
  createInterface({ input: host.stdout }).on("line", (line) => {
    const value = JSON.parse(line);
    if (value.type === "status") status = value;
    else if (value.type === "reply") {
      const resolve = replies.get(value.id);
      replies.delete(value.id);
      resolve?.(value);
    }
  });
}
function command(command) {
  const id = String(++commandNumber);
  const promise = new Promise((resolve) => replies.set(id, resolve));
  host.stdin.write(JSON.stringify({ id, command }) + "\n");
  return promise;
}
const backendPid = await evaluate(() => __cxConnection.connection.proc.pid);
const identity = () =>
  execFileSync(
    "/bin/ps",
    [
      "-p",
      [state.probe.pid, backendPid, ...state.stable.map((p) => p.pid)].join(","),
      "-o",
      "pid=,lstart=,comm=",
    ],
    {
      encoding: "utf8",
    },
  );
const original = identity();
const nativeModelsBefore = (await call("model/list", { limit: 100 })).data
  .map((m) => m.model)
  .sort();
const nativeLoadedBefore = (await call("thread/loaded/list", {})).data;
try {
  if (!process.argv.includes("--cua-only")) {
    // Start natively before installing hooks, then attach while that native turn is alive.
    await start(
      "gpt-before",
      "gpt",
      "Use the shell tool to run python3 -c 'import time; time.sleep(20); print(\"GPT_BEFORE_OK\")'. Wait for the result, then reply exactly GPT_BEFORE_OK.",
    );
    launch();
    assert.equal((await command("attach")).ok, true);
    const models = (await call("model/list", { limit: 100 })).data;
    assert(models.some((m) => m.model.startsWith("codexhost/")));
    assert(models.some((m) => m.model === "gpt-5.6-luna"));
    evidence("model-union", {
      native: models.filter((m) => !m.model.startsWith("codexhost/")).length,
      external: models.filter((m) => m.model.startsWith("codexhost/")).length,
    });
    const before = await finishTurn("gpt-before");
    assert.equal(before.status, "completed");
    assert(before.text.includes("GPT_BEFORE_OK"));
    evidence("gpt-survives-attach", before);
    await start(
      "gpt-after",
      "gpt",
      "Use the shell tool to run python3 -c 'import time; time.sleep(15); print(\"GPT_AFTER_OK\")'. Wait for the result, then reply exactly GPT_AFTER_OK.",
    );
    assert.equal((await command("detach")).ok, true);
    const after = await finishTurn("gpt-after");
    assert.equal(after.status, "completed");
    assert(after.text.includes("GPT_AFTER_OK"));
    evidence("gpt-survives-detach", after);
    assert.equal((await command("attach")).ok, true);
    await start(
      "background",
      "claude",
      "Use Bash with run_in_background true to run sleep 40. Once launched, reply BACKGROUND_STARTED immediately. Do not stop the background task.",
    );
    await until(
      () => status,
      (s) => s.backgroundTasks > 0,
      "background work",
    );
    const disconnect = command("detach");
    await until(
      () => status,
      (s) => s.phase === "draining",
      "drain phase",
    );
    let rejected = false;
    try {
      await call("thread/start", {
        model: "codexhost/claude-code-native@claude-model-v1.aGFpa3U",
        cwd: path.join(root, "workspace"),
      });
    } catch (e) {
      rejected = /disconnecting/.test(e.message);
    }
    assert(rejected, "New external work must be rejected during drain");
    assert.equal((await command("cancel-drain")).ok, true);
    await disconnect;
    assert.equal(status.phase, "attached");
    evidence("drain-cancel", {
      externalRejected: rejected,
      backgroundTasks: status.backgroundTasks,
    });
    const started = Date.now();
    assert.equal((await command("detach")).ok, true);
    assert(Date.now() - started > 1000, "Background work should keep the attachment alive");
    evidence("background-drained", { elapsedMs: Date.now() - started, phase: status.phase });
    assert.equal((await command("attach")).ok, true);
    const background = await readTurn("background");
    const history = await call("thread/read", {
      threadId: background.threadId,
      includeTurns: true,
    });
    assert(history.thread.turns.length > 0);
    evidence("history-after-reattach", {
      turns: history.thread.turns.length,
      threadId: background.threadId,
    });
  } else {
    launch();
    assert.equal((await command("attach")).ok, true);
  }
  await start(
    "cua",
    "claude",
    "Use the native cua_repl tool exactly once with code await cua.getState(). This is a read-only integration test: do not click, type, select an app, or change anything. If it succeeds reply exactly CUA_NATIVE_OK.",
  );
  const cua = await finishTurn("cua", 420_000);
  assert.equal(cua.status, "completed");
  assert(cua.text.includes("CUA_NATIVE_OK"));
  const nativeTrace = (await readFile(path.join(root, "host/native-picker-trace.jsonl"), "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert(
    nativeTrace.some(
      (e) =>
        e.event === "desktop-tools/call" &&
        e.tool === "cua_repl.js" &&
        e.outcome === "ok" &&
        e.at >= report.startedAt,
    ),
  );
  evidence("native-cua", cua);
  assert.equal((await command("quit")).ok, true);
  await until(
    () => host.exitCode,
    (c) => c !== null,
    "Host quit",
  );
  const clean = await evaluate(() => ({
    hook: !!globalThis.__codexhostHotAttachV1,
    send: Object.hasOwn(__cxConnection.connection, "send"),
    route: Object.hasOwn(__cxConnection, "routeIncomingMessage"),
  }));
  assert.deepEqual(clean, { hook: false, send: false, route: false });
  assert.equal(identity(), original);
  const nativeModelsAfter = (await call("model/list", { limit: 100 })).data
    .map((m) => m.model)
    .sort();
  assert.deepEqual(nativeModelsAfter, nativeModelsBefore);
  evidence("native-models-restored", { models: nativeModelsAfter });
  const nativeLoadedAfter = (await call("thread/loaded/list", {})).data;
  const newGptThreads = await evaluate(() =>
    Object.entries(__cxMenuTests)
      .filter(([key]) => key.startsWith("gpt-"))
      .map(([, p]) => p.threadId),
  );
  const remainingContexts = nativeLoadedAfter.filter(
    (id) => !nativeLoadedBefore.includes(id) && !newGptThreads.includes(id),
  );
  const contextStates = [];
  for (const threadId of remainingContexts) {
    const result = await call("thread/unsubscribe", { threadId });
    assert(
      ["notSubscribed", "notLoaded"].includes(result.status),
      "The Host must already have released each tool context subscription",
    );
    contextStates.push({ threadId, status: result.status });
  }
  evidence("cleanup-and-native-identity", { ...clean, nativeCachedContexts: contextStates });
  report.passed = true;
} catch (error) {
  report.error = error.stack;
  throw error;
} finally {
  if (host && host.exitCode === null) {
    host.stdin.end();
    await until(
      () => host.exitCode,
      (c) => c !== null,
      "Host cleanup",
      20_000,
    ).catch(() => host.kill("SIGTERM"));
  }
  await evaluate(() => {
    for (const p of Object.values(globalThis.__cxMenuTests ?? {})) p.cleanup();
    return true;
  }).catch(() => {});
  report.finishedAt = new Date().toISOString();
  await writeFile(
    path.join(
      root,
      process.argv.includes("--cua-only") ? "menubar-cua.json" : "menubar-acceptance.json",
    ),
    JSON.stringify(report, null, 2),
  );
  await log.close();
  cdp.close();
}
