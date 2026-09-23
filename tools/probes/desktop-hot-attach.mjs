// Isolated research driver. Never targets the user's installed/running Desktop.
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { prepareInstance } from "./fixture-instance.mjs";
import { installDesktopModelHook } from "./desktop-model-hook.mjs";
import { refreshDesktopModelCatalogue } from "./desktop-model-refresh.mjs";

const root = path.resolve(import.meta.dirname, "../../.dev/hot-attach-research");
const app = path.join(root, "app/ChatGPT.app");
const executable = path.join(app, "Contents/MacOS/ChatGPT");
const stateFile = path.join(root, "probe-state.json");
const expectedAsar = "1f7939c1c781887c167043c4d1d307af3400d324685cfc315dfe2f80e634f483";
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const processes = () =>
  execFileSync("/bin/ps", ["-axo", "pid=,ppid=,lstart=,comm="], { encoding: "utf8" })
    .split("\n")
    .map((line) => {
      const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\w+\s+\w+\s+\d+\s+[\d:]+\s+\d+)\s+(.*)$/);
      return m && { pid: +m[1], ppid: +m[2], started: m[3], exe: m[4] };
    })
    .filter(Boolean);
async function owned() {
  const state = JSON.parse(await fs.readFile(stateFile, "utf8"));
  const probe = processes().find(
    (p) => p.exe === executable && p.pid === state.probe.pid && p.started === state.probe.started,
  );
  if (!probe) throw new Error("The recorded isolated Desktop is not running");
  return probe;
}
async function checkVersion() {
  const bytes = await fs.readFile(path.join(app, "Contents/Resources/app.asar"));
  if (createHash("sha256").update(bytes).digest("hex") !== expectedAsar) {
    throw new Error("This research probe only supports the inspected Desktop 26.915.31945 archive");
  }
}
async function start() {
  if (processes().some((p) => p.exe === executable))
    throw new Error("Isolated Desktop already running");
  await prepareInstance(root);
  await checkVersion();
  const stable = processes().filter(
    (p) => p.exe === "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
  );
  const launchEnvironment = {
    CODEX_HOME: path.join(root, "codex"),
    CODEX_SQLITE_HOME: path.join(root, "codex"),
    CODEX_ELECTRON_USER_DATA_PATH: path.join(root, "electron"),
    CODEX_CLI_PATH: "",
    CLAUDE_CONFIG_DIR: path.join(root, "claude"),
  };
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !key.startsWith("CODEX") &&
        !key.startsWith("CLAUDE") &&
        !["NODE_OPTIONS", "ELECTRON_RUN_AS_NODE"].includes(key),
    ),
  );
  const log = await fs.open(path.join(root, "logs/native-launch.log"), "a", 0o600);
  const child = spawn(
    "/usr/bin/open",
    [
      "-n",
      "-g",
      "-W",
      ...Object.entries(launchEnvironment).flatMap(([key, value]) => ["--env", `${key}=${value}`]),
      app,
      "--args",
      `--user-data-dir=${path.join(root, "electron")}`,
    ],
    {
      env,
      detached: true,
      stdio: ["ignore", log.fd, log.fd],
    },
  );
  child.unref();
  await log.close();
  for (let attempt = 0; attempt < 100; attempt++) {
    const probe = processes().find((p) => p.exe === executable);
    if (probe) {
      await fs.writeFile(
        stateFile,
        JSON.stringify(
          { probe, stable, createdAt: new Date().toISOString(), inspectorAtStartup: false },
          null,
          2,
        ),
        { mode: 0o600 },
      );
      return probe;
    }
    await delay(200);
  }
  throw new Error("Isolated Desktop did not start");
}
async function connect(activate) {
  const probe = await owned();
  await checkVersion();
  let owners = [];
  try {
    owners = execFileSync("/usr/sbin/lsof", ["-nP", "-t", "-iTCP:9229", "-sTCP:LISTEN"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .trim()
      .split("\n")
      .map(Number);
  } catch (error) {
    if (error.status !== 1) throw error;
  }
  if (owners.some((pid) => pid !== probe.pid))
    throw new Error("Inspector port belongs to another process");
  if (!owners.length) {
    if (!activate) throw new Error("Isolated Desktop inspector is closed");
    process.kill(probe.pid, "SIGUSR1");
  }
  let targets;
  for (let attempt = 0; attempt < 30; attempt++) {
    targets = await fetch("http://127.0.0.1:9229/json/list", { signal: AbortSignal.timeout(500) })
      .then((r) => r.json())
      .catch(() => null);
    if (targets) break;
    await delay(100);
  }
  if (targets?.length !== 1) throw new Error("Expected one isolated inspector target");
  const endpoint = new URL(targets[0].webSocketDebuggerUrl);
  if (
    endpoint.protocol !== "ws:" ||
    !["127.0.0.1", "localhost"].includes(endpoint.hostname) ||
    endpoint.port !== "9229"
  )
    throw new Error("Unexpected inspector endpoint");
  const ws = new WebSocket(endpoint);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  let next = 1;
  const pending = new Map();
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    const request = pending.get(message.id);
    if (request) {
      pending.delete(message.id);
      message.error
        ? request.reject(new Error(JSON.stringify(message.error)))
        : request.resolve(message.result);
    }
  });
  const evaluate = async (expression) => {
    const result = await new Promise((resolve, reject) => {
      const id = next++;
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error("Inspector evaluation timeout"));
      }, 20_000);
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });
      ws.send(
        JSON.stringify({
          id,
          method: "Runtime.evaluate",
          params: { expression, awaitPromise: true, returnByValue: true },
        }),
      );
    });
    if (result.exceptionDetails)
      throw new Error(
        result.exceptionDetails.exception?.description ?? result.exceptionDetails.text,
      );
    return result.result.value;
  };
  try {
    const identity = await evaluate(
      "({pid:process.pid,home:process.env.CODEX_HOME,cli:process.env.CODEX_CLI_PATH})",
    );
    if (identity.pid !== probe.pid || identity.home !== path.join(root, "codex") || identity.cli)
      throw new Error("Inspector is not the stock isolated instance");
  } catch (error) {
    ws.close();
    throw error;
  }
  return { evaluate, close: () => ws.close() };
}

const [command = "status"] = process.argv.slice(2);
if (!["start", "attach", "status", "detach", "close-inspector", "stop"].includes(command))
  throw new Error("Use start|attach|status|detach|close-inspector|stop");
if (command === "start") {
  console.log(JSON.stringify(await start(), null, 2));
} else {
  const client = await connect(["attach", "stop"].includes(command));
  try {
    if (command === "attach") {
      const refreshSource = `(${refreshDesktopModelCatalogue.toString()})()`;
      const script = `(async()=>{
        const electron=process.mainModule.require('electron');
        const views=electron.webContents.getAllWebContents().filter(w=>w.getType()==='window'&&w.getURL().split('?')[0]==='app://-/index.html');
        const w=views.sort((a,b)=>{const area=w=>{const r=electron.BrowserWindow.fromWebContents(w)?.getBounds();return r?r.width*r.height:0};return area(b)-area(a)})[0];
        if(!w)throw Error('Main Desktop view missing');
        const refresh=()=>w.executeJavaScript(${JSON.stringify(refreshSource)});
        (${installDesktopModelHook.toString()})({leaseMs:5000,onDetach:refresh});
        try{await refresh()}catch(error){const h=globalThis.__claudeInCodexModelHookProbeV1;h.detach('attach-failed');await h.settled();throw error}
        return globalThis.__claudeInCodexModelHookProbeV1.status();
      })()`;
      console.log(JSON.stringify(await client.evaluate(script), null, 2));
      console.log(
        "Attached to the isolated Desktop. Ctrl-C detaches; a lost controller expires after 5 seconds.",
      );
      let stopping = false;
      const stop = () => {
        stopping = true;
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      try {
        while (!stopping) {
          await delay(1500);
          if (
            !stopping &&
            !(await client.evaluate(
              "globalThis.__claudeInCodexModelHookProbeV1?.heartbeat()??null",
            ))
          )
            break;
        }
      } finally {
        process.removeListener("SIGINT", stop);
        process.removeListener("SIGTERM", stop);
        console.log(
          JSON.stringify(
            await client.evaluate(
              "(async()=>{const h=globalThis.__claudeInCodexModelHookProbeV1;if(!h)return null;h.detach();return await h.settled()})()",
            ),
            null,
            2,
          ),
        );
      }
    } else if (command === "status") {
      console.log(
        JSON.stringify(
          await client.evaluate(
            "({pid:process.pid,hook:globalThis.__claudeInCodexModelHookProbeV1?.status()??null})",
          ),
          null,
          2,
        ),
      );
    } else if (command === "detach") {
      console.log(
        JSON.stringify(
          await client.evaluate(
            "(async()=>{const h=globalThis.__claudeInCodexModelHookProbeV1;if(!h)return null;h.detach();return await h.settled()})()",
          ),
          null,
          2,
        ),
      );
    } else if (command === "close-inspector") {
      console.log(
        await client.evaluate(
          "(()=>{if(globalThis.__claudeInCodexModelHookProbeV1)throw Error('Detach first');const inspector=process.mainModule.require('node:inspector');setTimeout(()=>inspector.close(),100);return 'Inspector close scheduled'})()",
        ),
      );
    } else {
      console.log(
        await client.evaluate(
          "(async()=>{const h=globalThis.__claudeInCodexModelHookProbeV1;if(h){h.detach();await h.settled()}setTimeout(()=>process.mainModule.require('electron').app.quit(),100);return 'Isolated Desktop quit scheduled'})()",
        ),
      );
    }
  } finally {
    client.close();
  }
}
