import { createServer } from "node:http";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { describe, it } from "vitest";
import { resolveClaudeCodeExecutable } from "../../packages/adapters/claude-code/dist/command.js";

// Runs the real CLI against a loopback-only fake Messages API. No paid model
// requests or existing Claude sessions are used. Requires Claude Code >= 2.1.246.
// CLAUDE_IN_CODEX_RUN_CLAUDE_STOP_REAL=1 npx vitest run --config tests/vitest.config.js tools/probes/claude-subagent-stop.real.test.mjs
describe.skipIf(process.env.CLAUDE_IN_CODEX_RUN_CLAUDE_STOP_REAL !== "1")(
  "native Claude background task interrupt",
  () => {
    it.each([false, true])(
      "perTaskStopAffordance=%s controls background task survival",
      async (preserve) => {
        const root = await mkdtemp(join(tmpdir(), "claude-stop-probe-"));
        await mkdir(join(root, "config"));
        const pending = new Map();
        const events = [];
        const requests = [];
        const wait = async (predicate, label) => {
          const until = Date.now() + 25000;
          while (!predicate()) {
            if (Date.now() > until)
              throw new Error("Timeout: " + label + " " + JSON.stringify({ requests, events }));
            await new Promise((r) => setTimeout(r, 25));
          }
        };
        const emit = (r, data) => r.write(`event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`);
        function begin(r, model) {
          r.writeHead(200, { "content-type": "text/event-stream" });
          emit(r, {
            type: "message_start",
            message: {
              id: "msg_" + randomUUID(),
              type: "message",
              role: "assistant",
              model,
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 20, output_tokens: 0 },
            },
          });
        }
        function end(r, reason = "end_turn") {
          emit(r, {
            type: "message_delta",
            delta: { stop_reason: reason, stop_sequence: null },
            usage: { output_tokens: 10 },
          });
          emit(r, { type: "message_stop" });
          r.end();
        }
        function textStart(r, text) {
          emit(r, {
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
          });
          emit(r, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } });
        }
        function finishText(r) {
          emit(r, { type: "content_block_stop", index: 0 });
          end(r);
        }
        const server = createServer(async (req, res) => {
          let raw = "";
          for await (const chunk of req) raw += chunk;
          const body = JSON.parse(raw || "{}");
          if (req.url.includes("count_tokens")) {
            res.end(JSON.stringify({ input_tokens: 20 }));
            return;
          }
          const last = body.messages?.filter((x) => x.role === "user").at(-1)?.content;
          const text =
            typeof last === "string"
              ? last
              : Array.isArray(last)
                ? last
                    .filter((x) => x.type === "text")
                    .map((x) => x.text)
                    .join("\n")
                : "";
          requests.push({ url: req.url, text: text.slice(-120), model: body.model });

          begin(res, body.model);
          if (text.includes("WORKER_ONE") || text.includes("WORKER_TWO")) {
            const key = text.includes("WORKER_ONE") ? "one" : "two";
            pending.set(key, res);
            textStart(res, "Child " + key + " working.");
          } else if (text.includes("PARENT_START")) {
            for (const [index, prompt] of ["WORKER_ONE", "WORKER_TWO"].entries()) {
              emit(res, {
                type: "content_block_start",
                index,
                content_block: { type: "tool_use", id: "call_" + index, name: "Agent", input: {} },
              });
              emit(res, {
                type: "content_block_delta",
                index,
                delta: {
                  type: "input_json_delta",
                  partial_json: JSON.stringify({
                    description: prompt,
                    prompt,
                    subagent_type: "general-purpose",
                    run_in_background: true,
                  }),
                },
              });
              emit(res, { type: "content_block_stop", index });
            }
            end(res, "tool_use");
          } else if (
            Array.isArray(last) &&
            last.some((x) => x.type === "tool_result") &&
            !pending.has("root")
          ) {
            pending.set("root", res);
            textStart(res, "Root waiting.");
          } else {
            textStart(res, "PARENT_REPLY");
            finishText(res);
          }
        });
        await new Promise((r) => server.listen(0, "127.0.0.1", r));
        let push;
        let closed = false;
        const inputs = [];
        const prompt = {
          [Symbol.asyncIterator]() {
            return {
              next() {
                if (inputs.length) return Promise.resolve({ done: false, value: inputs.shift() });
                if (closed) return Promise.resolve({ done: true });
                return new Promise((r) => (push = r));
              },
            };
          },
        };
        function send(text) {
          const value = {
            type: "user",
            message: { role: "user", content: text },
            parent_tool_use_id: null,
            session_id: "",
            uuid: randomUUID(),
          };
          if (push) {
            const done = push;
            push = null;
            done({ done: false, value });
          } else inputs.push(value);
        }
        let q;
        let consuming;
        try {
          q = query({
            prompt,
            options: {
              cwd: root,
              pathToClaudeCodeExecutable: resolveClaudeCodeExecutable(),
              settingSources: [],
              strictMcpConfig: true,
              mcpServers: {},
              tools: ["Agent"],
              model: "claude-sonnet-4-6",
              thinking: { type: "disabled" },
              permissionMode: "bypassPermissions",
              allowDangerouslySkipPermissions: true,
              perTaskStopAffordance: preserve,
              persistSession: false,
              includePartialMessages: true,
              env: {
                ...process.env,
                CLAUDECODE: undefined,
                CLAUDE_CONFIG_DIR: join(root, "config"),
                ANTHROPIC_API_KEY: "local-test-key",
                ANTHROPIC_AUTH_TOKEN: undefined,
                ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`,
                CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
                HTTP_PROXY: "",
                HTTPS_PROXY: "",
                ALL_PROXY: "",
                NO_PROXY: "127.0.0.1",
              },
            },
          });
          consuming = (async () => {
            for await (const m of q) {
              if (m.type === "system" || m.type === "result") {
                const e = {
                  type: m.type,
                  subtype: m.subtype,
                  task_id: m.task_id,
                  description: m.description,
                  status: m.status,
                  terminal_reason: m.terminal_reason,
                };
                events.push(e);
              }
            }
          })();
          send("PARENT_START");
          await wait(
            () => pending.has("one") && pending.has("two") && pending.has("root"),
            "all requests",
          );
          await q.interrupt();
          await wait(() => events.some((x) => x.type === "result"), "interrupt result");
          await new Promise((r) => setTimeout(r, 200));

          if (preserve) {
            if (pending.get("one").destroyed || pending.get("two").destroyed)
              throw new Error("Child killed by interrupt");
            send("PARENT_REPLACEMENT");
            await wait(
              () => events.filter((x) => x.type === "result").length >= 2,
              "replacement result",
            );
            const one = events.find(
              (x) => x.subtype === "task_started" && x.description === "WORKER_ONE",
            );
            if (!one) throw new Error("Missing first child identity");
            await q.stopTask(one.task_id);
            await wait(
              () =>
                events.some(
                  (x) =>
                    x.subtype === "task_notification" &&
                    x.task_id === one.task_id &&
                    x.status === "stopped",
                ),
              "single child stop",
            );
            if (pending.get("two").destroyed) throw new Error("Sibling killed by task stop");
            finishText(pending.get("two"));
            await wait(
              () =>
                events.some((x) => x.subtype === "task_notification" && x.status === "completed"),
              "sibling completion",
            );
          } else {
            await wait(
              () =>
                events.filter((x) => x.subtype === "task_notification" && x.status === "stopped")
                  .length === 2,
              "baseline kills both",
            );
          }
        } finally {
          closed = true;
          push?.({ done: true });
          q?.close();
          await consuming?.catch(() => {});
          server.closeAllConnections();
          await new Promise((r) => server.close(r));
          await rm(root, { recursive: true, force: true });
        }
      },
      60000,
    );
  },
);
