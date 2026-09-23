import { readFile } from "node:fs/promises";
import path from "node:path";
import { CdpClient } from "../../packages/desktop-control/dist/index.js";
const root = path.resolve(import.meta.dirname, "../../.dev/hot-attach-research");
const state = JSON.parse(await readFile(path.join(root, "probe-state.json"), "utf8"));
const targets = await fetch("http://127.0.0.1:9229/json/list").then((r) => r.json());
const client = await CdpClient.connect(targets[0].webSocketDebuggerUrl, {
  commandTimeoutMs: 30_000,
});
if ((await client.evaluate("process.pid")) !== state.probe.pid) {
  client.close();
  throw new Error("Not the isolated Desktop");
}
async function usage() {
  const root = document.getElementById("root");
  const key = Object.keys(root).find((k) => k.startsWith("__reactContainer$"));
  const stack = [root[key].stateNode?.current ?? root[key]],
    seen = new Set();
  while (stack.length && seen.size < 30000) {
    const f = stack.pop();
    if (!f || seen.has(f)) continue;
    seen.add(f);
    for (const q of [f.memoizedProps?.client, f.memoizedProps?.value]) {
      if (!q?.getQueryCache || !q.invalidateQueries) continue;
      await q.invalidateQueries({ queryKey: ["rate-limit-status"], exact: true });
      const data = q.getQueryData(["rate-limit-status"]);
      return {
        rows: data?.ambient_usage?.default?.menu?.rows,
        buckets: data?.additional_rate_limits?.map((l) => l.limit_name),
      };
    }
    stack.push(f.child, f.sibling);
  }
  return null;
}
try {
  await client.evaluate(
    `(()=>{const n=process.mainModule.require('electron').net;const original=n.fetch;globalThis.__cxNetPaths=[];n.fetch=async function(input,...args){const u=typeof input==='string'?input:input.url??input.href;try{const path=new URL(u).pathname;if(path.includes('/usage'))globalThis.__cxNetPaths.push(path);}catch{}return original.call(this,input,...args)};globalThis.__cxNetRestore=()=>{n.fetch=original;delete globalThis.__cxNetRestore};return true})()`,
  );
  console.log(
    await client.evaluate(
      `process.mainModule.require('electron').webContents.fromId(1).executeJavaScript(${JSON.stringify(`(${usage.toString()})()`)})`,
    ),
  );
  console.log(
    await client.evaluate(
      "({paths:globalThis.__cxNetPaths,hook:globalThis.__claudeInCodexHotAttachV1?.status()??null})",
    ),
  );
} finally {
  await client.evaluate("(globalThis.__cxNetRestore?.(),delete globalThis.__cxNetPaths,true)");
  client.close();
}
