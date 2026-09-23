// Destructive fault tests target only a newly spawned Host and the recorded disposable Desktop.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { readFile, writeFile, readdir, open } from "node:fs/promises";
import { createInterface } from "node:readline";
import path from "node:path";
import { CdpClient } from "../../packages/desktop-control/dist/index.js";
import { debugEnvironment } from "../fork/debug.mjs";

const root = path.resolve(import.meta.dirname, "../../.codexhost/hot-attach-research");
const resources = path.resolve(root, "../menubar/Codex Host.app/Contents/Resources");
const state = JSON.parse(await readFile(path.join(root, "probe-state.json"), "utf8"));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(read, predicate, label, timeout = 30_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await read();
    if (predicate(value)) return value;
    await delay(100);
  }
  throw new Error(`Timed out: ${label}`);
}
function processes() {
  return execFileSync("/bin/ps", ["-axo", "pid=,ppid=,lstart=,comm="], { encoding: "utf8" })
    .split("\n")
    .flatMap((line) => {
      const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\w+\s+\w+\s+\d+\s+[\d:]+\s+\d+)\s+(.*)$/);
      return m ? [{ pid: +m[1], ppid: +m[2], started: m[3], exe: m[4] }] : [];
    });
}
function owners() {
  try {
    return execFileSync("/usr/sbin/lsof", ["-nP", "-t", "-iTCP:9229", "-sTCP:LISTEN"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .trim()
      .split("\n")
      .map(Number);
  } catch (error) {
    if (error.status === 1) return [];
    throw error;
  }
}
function assertFixture() {
  const current = processes().find((p) => p.pid === state.probe.pid);
  assert.equal(current?.exe, state.probe.exe);
  assert.equal(current?.started, state.probe.started);
  assert(state.probe.exe.startsWith(path.join(root, "app/")));
}
async function connect() {
  assertFixture();
  assert.deepEqual(owners(), [state.probe.pid]);
  const targets = await fetch("http://127.0.0.1:9229/json/list").then((r) => r.json());
  const client = await CdpClient.connect(targets[0].webSocketDebuggerUrl);
  assert.equal(await client.evaluate("process.pid"), state.probe.pid);
  return client;
}
let cdp = await connect();
assert.equal(await cdp.evaluate("!!globalThis.__codexhostHotAttachV1"), false);
const backendPid = await cdp.evaluate("__cxConnection.connection.proc.pid");
const originals = processes().filter((p) =>
  [backendPid, state.probe.pid, ...state.stable.map((p) => p.pid)].includes(p.pid),
);
const dirs = async () => (await readdir("/tmp")).filter((n) => n.startsWith("codexhost-attach-"));
const report = { startedAt: new Date().toISOString(), checks: [] };
const log = await open(path.join(root, "lifecycle-host.log"), "a", 0o600);
let host,
  status = {},
  counter = 0;
const replies = new Map();
function command(command) {
  const id = String(++counter);
  const promise = new Promise((resolve) => replies.set(id, resolve));
  host.stdin.write(JSON.stringify({ id, command }) + "\n");
  return promise;
}
async function launch() {
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
      replies.get(value.id)?.(value);
      replies.delete(value.id);
    }
  });
  assert.equal((await command("attach")).ok, true);
  assert.equal(status.phase, "attached");
}
try {
  // Give ownership of opening and closing the inspector to the actual Host.
  await cdp.evaluate(
    '(setTimeout(()=>process.mainModule.require("node:inspector").close(),100),true)',
  );
  cdp.close();
  await until(owners, (p) => !p.length, "close fixture debugger");
  for (const scenario of ["owner-loss-during-quit", "host-sigkill"]) {
    const before = new Set(await dirs());
    await launch();
    if (scenario === "owner-loss-during-quit") {
      await until(owners, (p) => !p.length, "Host closes its inspector");
      report.checks.push({ name: "owned-inspector-closed", passed: true });
      assertFixture();
      process.kill(state.probe.pid, "SIGUSR1");
      await until(owners, (p) => p.includes(state.probe.pid), "reopen fixture debugger");
      cdp = await connect();
    }
    const socketDirs = (await dirs()).filter((n) => !before.has(n));
    assert.equal(socketDirs.length, 1);
    const thread = await cdp.evaluate(`(async()=>{
      const c=__cxConnection;
      const r=await c.sendAppServerRequest("thread/start",{model:"codexhost/claude-code-native@claude-model-v1.aGFpa3U",cwd:${JSON.stringify(path.join(root, "workspace"))},approvalPolicy:"never",sandbox:"read-only"});
      await c.sendAppServerRequest("turn/start",{threadId:r.thread.id,effort:"low",input:[{type:"text",text:"Use Bash with run_in_background true to run sleep 180. Once launched reply BACKGROUND_STARTED immediately. Do not stop the background task."}]});
      return r.thread.id;
    })()`);
    await until(
      () => status,
      (s) => s.backgroundTasks > 0,
      "background task starts",
      90_000,
    );
    const all = processes(),
      selected = new Set([host.pid]);
    for (let changed = true; changed;) {
      changed = false;
      for (const p of all)
        if (selected.has(p.ppid) && !selected.has(p.pid)) {
          selected.add(p.pid);
          changed = true;
        }
    }
    const owned = all.filter((p) => selected.has(p.pid));
    assert.equal(owned.find((p) => p.pid === host.pid)?.exe, path.join(resources, "runtime/node"));
    assert(
      owned.some((p) => path.basename(p.exe) === "sleep"),
      "Observe the real background shell task",
    );
    const started = Date.now();
    if (scenario === "owner-loss-during-quit") {
      void command("quit");
      await until(
        () => status,
        (s) => s.phase === "draining",
        "quit is draining",
      );
      host.stdin.end();
    } else host.kill("SIGKILL");
    await until(
      processes,
      (ps) => owned.every((old) => !ps.some((p) => p.pid === old.pid && p.started === old.started)),
      "Host and owned descendants exit",
      30_000,
    );
    const clean = await until(
      () =>
        cdp.evaluate(
          '({hook:!!globalThis.__codexhostHotAttachV1,send:Object.hasOwn(__cxConnection.connection,"send"),route:Object.hasOwn(__cxConnection,"routeIncomingMessage")})',
        ),
      (s) => !s.hook && !s.send && !s.route,
      "native methods restored",
    );
    await until(
      dirs,
      (current) => socketDirs.every((d) => !current.includes(d)),
      "private sockets removed",
    );
    report.checks.push({
      name: scenario,
      threadId: thread,
      elapsedMs: Date.now() - started,
      processesExited: owned.map(({ pid, exe }) => ({ pid, exe: path.basename(exe) })),
      ...clean,
      socketsRemoved: true,
    });
    console.log(JSON.stringify(report.checks.at(-1)));
  }
  for (const original of originals)
    assert.deepEqual(
      processes().find((p) => p.pid === original.pid),
      original,
    );
  report.passed = true;
} catch (error) {
  report.error = error.stack;
  throw error;
} finally {
  if (host?.exitCode === null && host.signalCode === null) host.stdin.end();
  cdp.close();
  await log.close();
  report.finishedAt = new Date().toISOString();
  await writeFile(path.join(root, "menubar-lifecycle.json"), JSON.stringify(report, null, 2), {
    mode: 0o600,
  });
}
