// Acceptance-only helper. Requires an already captured connection in the isolated fixture.
import { readFile, writeFile } from "node:fs/promises";
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
async function start(input) {
  const c = globalThis.__cxConnection;
  if (!c) throw new Error("Capture the isolated native connection before running acceptance");
  const models = (await c.sendAppServerRequest("model/list", { limit: 100 })).data;
  const model =
    input.model === "gpt"
      ? "gpt-5.6-luna"
      : models.find((m) => m.displayName === "Haiku 4.5").model;
  const started = await c.sendAppServerRequest("thread/start", {
    model,
    cwd: input.cwd,
    approvalPolicy: "never",
    sandbox: "read-only",
  });
  const probe = { threadId: started.thread.id, model, events: [], text: "", done: false };
  globalThis.__cxAcceptance?.cleanup?.();
  globalThis.__cxAcceptance = probe;
  probe.cleanup = c.registerInternalNotificationHandler((m) => {
    if (m.params?.threadId !== probe.threadId) return;
    probe.events.push(m.method);
    if (m.method === "item/agentMessage/delta") probe.text += m.params.delta;
    if (m.method === "turn/completed") {
      probe.done = true;
      probe.result = m.params.turn;
    }
  });
  const response = await c.sendAppServerRequest("turn/start", {
    threadId: probe.threadId,
    effort: "low",
    input: [{ type: "text", text: input.prompt }],
  });
  return { threadId: probe.threadId, turnId: response.turn.id, model };
}
try {
  if (process.argv[2] === "start")
    console.log(
      await client.evaluate(
        `(${start.toString()})(${JSON.stringify({
          cwd: path.join(root, "workspace"),
          model: process.argv[3],
          prompt: process.argv[4] ?? "Reply exactly HOT_ATTACH_OK. Do not use tools.",
        })})`,
      ),
    );
  else {
    const result = await client.evaluate(
      "(({cleanup,...result})=>result)(globalThis.__cxAcceptance)",
    );
    await writeFile(path.join(root, "latest-turn.json"), JSON.stringify(result, null, 2));
    console.log(result);
  }
} finally {
  client.close();
}
