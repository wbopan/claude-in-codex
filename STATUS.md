# STATUS — goal tracker

## MenuBar hot attachment (2026-09-22)

Implemented in the independent `codex/menubar-hot-attach` worktree, based on `8681959`.
The original checkout remains on `main`; concurrent edits there belong to other work.

- Native macOS MenuBar app, vector icons, bundled Node/Host/plugins and local signing.
- Version-checked, reversible in-memory attachment to normally started Desktop 26.915.31945.
- Existing model/permission/Plan/tool/history/memory/usage and remote implementations retained.
- Attach/detach preserve real GPT turns. Background drain, cancel, history after reconnect,
  native CUA, usage rows, second-owner rejection and abnormal process cleanup verified.
- TypeScript: 1205 passed, 7 skipped. Rust: 171 passed. Stable Desktop was never restarted.

See [migration design and acceptance](docs/menubar-migration.md) and [usage](README.md).
The earlier launcher goal and its historical evidence follow below.

Goal (owner: Wenbo, set 2026-09-21): a slim repo that runs Claude Code inside the official Codex
Desktop through native protocol seams only. Done = end-to-end verified in an independent debug
Desktop instance. The stable Host/Desktop must never be stopped or restarted (the working agent
runs inside it).

## Requirements

1. Claude in Codex: streaming, tool calls, diffs, approvals (existing adapter + projector).
2. Expose `codex_app` tools to Claude (create_thread, …).
3. Expose `cua_repl` (Computer Use / IAB) to Claude — in-Host, retire the Python bridge.
4. Pick Claude model + thinking in the native Model picker.
5. Permission level (v0: config default + native Plan toggle; mapping later).
6. Bonus: Claude subscription usage visible in the Codex UI.
7. Not needed: multi-provider management, settings UI, sidebar Claude markers.

## Acceptance checklist (live evidence under `.codexhost/acceptance/`, git-ignored)

Verified live in the independent debug Desktop on 2026-09-21 unless noted.

- [x] A. Debug snapshot builds from this repo; independent debug Desktop starts; stable PIDs
      66056/66058/66109/66114 kept their 18:07 start time through nine debug restarts.
- [x] B. No renderer injection: `__codexhostRendererBindingProbeV1` is undefined (`B-*.json`).
- [x] C. Native picker lists the Claude catalog; real turns returned `claude-sonnet-5` and
      `claude-haiku-4-5-20251001` (`C-*`, `F-same-harness-haiku.png`).
- [x] D. Native effort reaches the adapter: `thinking.select high`, session confirmed `high`
      (`D-thinking-trace.jsonl`).
- [x] E. Route id never written to `config.toml`; selection and effort survive restarts; picking
      a GPT model hands both keys back to the official config (`E-after-restart.json`).
- [x] F. `thread/settings/update` guarded both ways with the native error toast and picker
      rollback; same-Harness Sonnet -> Haiku works (`F-*`).
- [x] R1. Tool calls, native approval cards, command rendering, streaming (`R1-tools-*.png`).
- [x] G. Claude called `codex_app.list_threads` through the Host (`G-*`). This relies on the
      native parent topology, which is the macOS default (`CODEXHOST_NATIVE_APP_TOOLS=0` opts
      out). Verified with no variable set: the official `codex` is Desktop's direct child and
      the catalogue lists 44 codex_app tools plus cua_repl js/js_reset (`N-*`).
- [x] H. Claude called `cua_repl.js` in-Host with no Python bridge: `cua.getState()`, then the
      in-app browser opened example.com, read "Example Domain", closed the tab
      (`H-cua-repl-trace.jsonl`, `H-result.txt`). One elicitation was forwarded to the owning task.
- [x] I. Native permission selector and Plan toggle drive the Claude Permission Mode:
      ask -> `default`, auto-review -> `auto`, Plan on -> `plan`, Plan off -> `default`
      (`I-permission-trace.jsonl`).
      NOT live-verified on purpose: full access -> `bypassPermissions` (unit tests only).
      The reverse direction is covered too: a Permission Mode the Harness changes on its own
      (Claude's `EnterPlanMode`, a plan approval) updates the Host's Plan bookkeeping and flips
      the Desktop toggle through `thread/settings/updated` (unit test only; the earlier live
      run showed the toggle staying dark and a later Plan off being ignored).
- [x] S. Side chat (`thread/fork` + `thread/inject_items`): no failure toast, the fork inherits
      Model, Thinking and Permission Mode, both composers show the parent's level instead of a
      custom one, and the injected parent context reaches Claude (`S-side-chat-*`).
      This run also gave live evidence for full access -> `bypassPermissions`, selected by the
      user; only text-only Turns were sent under it.
- [x] T. Threads started by another Thread (`codex_app.create_thread`, `send_message_to_thread`)
      with a Claude Model: the Desktop sends `input: []` and the message in `toolOutput.output`;
      the Host reads it. A `create_thread` child on Sonnet accepted its first Turn, no
      `turn/start-rejected` in the trace (triggered by the user on build 15).
- [x] U. Native context ring for Claude Threads: `thread/tokenUsage/updated` is written during
      and after a Turn; tooltip showed 3% used, 34k of 1,000k (`U-context-*.png`).
- [x] V. Background Subagents on build 1790049566954 (2026-09-22, driven through the AX tree):
      the Desktop's Stop button always stops the whole agent tree. Stop in a child pane sent
      `turn/interrupt` to the parent first and to that child 36 ms later; Stop on the parent
      loaded every running child (`thread/turns/list`) and interrupted each one, including a
      sibling whose pane was never opened. The Host handled both as designed (held Root turn
      cancelled without touching the CLI, each child stopped through `stopTask`), so a single
      background task can only be stopped from chat (`TaskStop`), never from the button.
      Steering the held parent (`调整方向`) replaced the Turn and left the running child alone;
      it finished 1..60 and its pane showed prompt, command, handback and reply, matching the
      22-record transcript (15 `attachment` records). Editing history is hidden by the Desktop
      while the parent runs, which is exactly when children run, so the Host guard is a backstop.
- [x] W. Live Subagent pane (build 1790057469453, 2026-09-22, driven through CDP). A running
      child's pane now grows while it works: with a six-step `sleep 10; echo STEP_N` Subagent,
      `subagent/refresh` fired on every nested message and the Desktop's collapsed activity
      block (`已处理 Ns`, `data-local-conversation-item-target-ids` listing the child Items)
      showed `已运行 … STEP_1..3` when expanded at 27 s and `STEP_1..5` at 55 s; after the
      handback the block became `运行了命令 subagent handback` with all six commands and the
      reply. The header line reads `正在思考` rather than the running command because the
      refresh only projects completed Items; a command is never shown as in progress.
- [x] J. Usage chip (bonus). Premise superseded 2026-09-22: the native usage UI is fed by the
      Desktop's own `GET <workspaceRouting.backendOrigin>/backend-api/wham/usage`, and
      `account/read` is the seam. The Host proxies that origin (Phase A) and rewrites the one
      response (Phase B): `additional_rate_limits` gains one Claude bucket per route id, and
      `ambient_usage.default` (a server-driven profile-menu section the Desktop renders whenever
      present, statsig gate `3538455134` on for this account) gains "Codex 7 天 / Claude 5 小时 /
      Claude 7 天 / Fable 7 天" rows with reset hovers; the account footer stays native (no subtext).
      Verified in the debug Desktop, localized to the macOS preferred language
      (`J-ambient-menu-zh.png`, `J-wham-usage-ambient.json`). The richer per-Model sidebar
      card (`sidebar_usage_warnings.by_model`, statsig gate `3617198761`) is out of reach: the
      gate cannot be held open from the seam (see the 2026-09-22 log entry).

## Carve phase (branch `carve`, 2026-09-21)

Eleven commits on top of `main`; 158 files changed, 586 insertions, 27,693 deletions. After each
step `tsc -b` was clean and both suites were green; nothing was committed that was not green.

Removed: the self-update surface (`packages/update-manager`, `crates/updater`), the pairing-code
Remote Control bridge, cross-harness delegation, session and credential import, renderer injection
in the Desktop Controller, the injected-renderer `codexhost/*` Thread/Harness/Account JSON-RPC
surface, the legacy per-harness transport codecs (Pi, DeepSeek, OpenCode, Grok, OMP, Antigravity),
the Pi harness launch surface, and Windows support (Rust `windows_*` modules, the `codexhost-start`
and `codexhost-node-repl` binaries, `winresource`/`windows` crate dependencies, the Inno Setup
installer and `package.ps1`, the `windows-x64`/`windows-arm64` release targets). macOS and Linux
remain.

Kept deliberately, although the carve looked like it could take them:

- The SSH remote Host in full: `remote-app-server.ts`, `remote-host-cli.ts`, `remote-host-install.ts`,
  `remote-host-lifecycle.ts`, `remote-official-app-server.ts`, `remote-official-connection.ts`,
  `remote-socket-lock.ts`, the remote branch of `run-host-runtime.ts`, the shim/launcher paths that
  recognise `app-server --listen unix://` and `app-server proxy`, and the macOS LaunchAgent harness
  broker (`packages/harness-broker`, `aqua-harness-broker.ts`). Protocol-verified on 2026-09-21
  (see below); not yet verified from a real Desktop SSH workspace.
- `codexhost/settings/idle-release/set`, `codexhost/sessions/loaded/list` and
  `codexhost/harness/launch-settings/get|set`: they look like injected-renderer RPCs but are the
  only way to enable idle release and to record the Claude CLI install path.
- `codexhost/update/status`: the SSH remote probe uses it as its discriminator.
- `packages/desktop-control/src/cdp-client.ts` (used by `tools/acceptance/cdp.mjs`),
  `controller-attachment-server.ts` and `release-main.ts`: the launcher hard-requires a controller
  process, which is now passive and installs nothing.
- `process.platform === "win32"` guards inside kept TypeScript (claude-code adapter, harness
  broker, harness discovery, remote host, mapping store, `file-change-summary`). These are one-line
  defensive branches threaded through keep-list code, so removing them is refactoring rather than
  deletion; two of the files are owned by a parallel branch.

## Not done

- `turn_ended` after a cua_repl Turn is unit-tested; its live call is not in the trace yet.
- The answer to the forwarded elicitation is not recorded in the trace.
- The native parent topology holds no `LocalRuntimeLease`: there is no owner handoff when the
  Desktop respawns its app-server before the previous Host has exited. The Mapping Store lock
  fails closed, so the cost is an unavailable session, not corrupted data.

## Findings worth keeping

- The official app-server reports both `cua_repl` (plugin `unified-computer-use`, current) and
  `node_repl` (legacy `config.toml` section). The Host exposes `cua_repl` only.
- Thread responses must name a `model/list` entry id, otherwise a reopened Thread shows a custom
  Model in the picker.
- Host responses used to rewrite a granular `approvalPolicy` to `"never"`. Full access is
  therefore recognised only by `:danger-full-access` / `dangerFullAccess`.
- The context window is known only after `refreshUsage()`. Its sole caller used to be the
  injected renderer UI, so without injection the ring never appeared.
- The launcher forwards only whitelisted env vars; the acceptance trace rides on
  `CODEXHOST_STARTUP_TRACE=1`.
- The Shim enters the native parent topology only when `CODEXHOST_DATA_DIR` is set
  (`crates/shim/src/lib.rs`, `local_host_runtime`). A bare `codexhost launch` from a shell used
  to leave it unset, so the stable Desktop silently fell back to the proxy topology: the Host
  spawned its own `codex --listen ws://` backend, the `codex_app` MCP child of that backend had
  an unsigned ancestry, and the Desktop rejected it on the app-tools pipe
  (`dynamic_app_tools_peer_rejected reason=untrusted-code-signing-identity`, then
  `MCP client for codex_app failed to start: Codex app tools pipe closed`). Claude then saw
  only `cua_repl`. The debug instance and the npm wrapper always set the variable, which is why
  acceptance G passed there. Fixed 2026-09-22: the launcher defaults it to `~/.codexhost`.
- The Desktop replaces the origin of every backend request with `workspaceRouting.backendOrigin`
  from the app-server `account/read` response (zod: https + origin-only). The Host publishes its
  loopback proxy there only when the launcher pinned the proxy certificate for Chromium
  (`--user-data-dir` + `--ignore-certificate-errors-spki-list`, handshake via
  `CODEXHOST_DESKTOP_PROXY_SPKI`). `CODEXHOST_DESKTOP_PROXY=0` is the kill switch for both
  processes. The live `/wham/usage` body carries `additional_rate_limits: null` (not `[]`),
  a 7-day `primary_window` with `reset_after_seconds`, and `model_usage` keyed by slug.
- A stale `codex_desktop` stdio MCP server in `~/.claude.json` (the retired Python bridge from
  `codexhost-claude-bridge`) still starts its own `codex app-server --listen stdio://` per
  Claude session and only ever exposes `cua_repl.js/js_reset`. It is not part of this repo;
  remove it with `claude mcp remove -s user codex_desktop`.

## Log

- 2026-09-22: Subagent live view. Before: a background child's pane only refreshed while the
  Root Turn was live and the Agent call still sat in the same Segment, so an opened pane showed
  the prompt and, at the end, the reply. Now `subagent.transcript.changed` is republished from
  the idle, autonomous and Thread handlers, every accumulator recognises earlier Agent calls,
  and the Session occupancy resolves the native child id (`0f4949c`). Found on the way: the
  SDK sends `task_started`/`task_notification` for every Bash task, including each command a
  Subagent runs, and the adapter reported the Subagent as settled on each one (`4eaf950`
  filters by `task_type`). Desktop renderer facts from `app-initial-*.js`: `turn/started` for
  a known Turn whose local status is not `inProgress` is ignored entirely and never reads
  `turn.items`; `item/started` appends by id with no status check; `turn/completed` only writes
  Turn fields. Mid-Turn Items land in the collapsed activity block, which is why the pane looked
  empty until the user expanded it (W above). Verified live through CDP because the fresh debug
  Desktop did not expose its web content to the AX tree this time.
- 2026-09-22: five commits on `integrate-20260922` (launcher data root, SDK 0.3.246, Subagent
  transcripts in append order, individual Subagent stop, Plan mode reverse sync); vitest 1127
  passed, launcher cargo tests green. Live run V above; Plan reverse sync was seen live once
  (`harness/permissionMode.changed` plan -> auto in the trace) but the toggle itself was not
  screenshotted because the Peekaboo Bridge host refused capture.
- 2026-09-21: repo created from codex-host `43b8f282`; tsc green; vitest 1420 passed.
- 2026-09-21: native picker, thread settings guards, in-Host cua_repl, permission mapping;
  vitest 1429 passed; acceptance A-I verified live.
- 2026-09-21: side chat fixed (inject_items handled, fork inherits native settings, Thread
  responses carry the permission preset); vitest 1431 passed.
- 2026-09-22: `codex_app` missing in the stable Desktop (build 9731598, started by a bare
  `codexhost launch`): root-caused to the missing `CODEXHOST_DATA_DIR` -> proxy topology -> peer
  rejection chain above. Launcher now defaults the data root to `~/.codexhost`
  (`managed_desktop_data_directory`); launcher tests 43 + 5 green. Takes effect on the next
  stable relaunch; the running stable Desktop was left untouched.
- 2026-09-21: native parent topology is the macOS default; picker Models use bare names
  (Default, Fable, Haiku, Opus, Sonnet). Rust tests need `npm run test:rust` (test-utils
  feature) and a shell without inherited `CODEXHOST_*` variables.
- 2026-09-21: agent-started Turns read `toolOutput`; the Host refreshes Usage on Turn start,
  Turn completion and Thread open so the native context ring works; vitest 1435 passed.
- 2026-09-21: carve phase on branch `carve`; vitest 1114 passed / 5 skipped, Rust 158 passed.
  Re-verified live after the carve: picker lists official plus Claude Models, a text Turn and a
  Bash Turn with the native approval card ("Claude Code" / "Bash") and command rendering, the
  permission selector (`ask -> default`, `auto-review -> auto`), effort (`thinking.select high`
  then `xhigh`), `cross-harness-rejected` with the native toast when a Claude Thread is pointed at
  GPT-5.5, the context ring (`thread/tokenUsage/updated`), Thread resume across `debug:restart`,
  a clean instance `config.toml`, and a catalogue of 44 codex_app tools plus cua_repl js/js_reset.
- 2026-09-21: SSH remote Host verified at the protocol level with no installation: broker started
  from the release bundle under `env -i` with temporary `CODEX_HOME`/`CODEXHOST_DATA_DIR`/
  `CODEXHOST_HARNESS_BROKER_DIR`, `app-server --listen unix://` listener, WebSocket over the unix
  socket, `initialize` + `initialized`, and `model/list` returning 10 entries of which 5 are
  `codexhost/claude-code-native@claude-model-v1.*`.
- 2026-09-22: merged `native-reasoning` and `subagent-status` onto `carve` (branch `integrate`, then
  fast-forwarded `main`). Two textual conflicts (carve had removed session import and delegated
  Turns) plus one silent semantic conflict: carve dropped the `createHash` import that
  `subagent-status` reuses for `traceRef`; restored. Removed the leftover unused `DesktopSession`
  import in the launcher. tsc clean; vitest 1116 passed / 5 skipped; Rust 158 passed. Live in the
  debug Desktop on a clone of the carve instance state: carve Threads resume, a text Turn, a
  reasoning-heavy Turn rendered as the native Reasoning Item while running and collapsed after,
  a Bash Turn with the native approval card, a Subagent Thread opened while running reported
  `running` (`thread/read` at `childStatus: active`, stop button in the child composer) and idle
  after completion, Model and effort survive `debug:restart`, `config.toml` carries no route id
  (`int-*.png`). Not re-verified live in this run: the cross-harness toast and effort submenu
  (the picker popover kept opening on the effort slider under CDP); last verified on `carve`.
- 2026-09-22: Desktop backend proxy, Phase A. Launcher: `desktop_backend_proxy.rs` (openssl CLI
  cert under `<data>/desktop-proxy/`, SPKI pin, Chromium args; LibreSSL honours `-addext`),
  `sha256_base64` in platform. Host: `desktop-backend-proxy.ts` (127.0.0.1 HTTPS, http/1.1,
  keep-alive upstream, upgrade relay, 502 on upstream failure, `requests.jsonl` without
  queries/headers/bodies, `rewrite` hook for Phase B) and an `account/read` request branch that
  replaces `backendOrigin` only while the proxy is active. tsc clean; vitest 1151 passed / 7
  skipped (12 new proxy tests, 4 new Host tests); Rust 171 passed. Live in the debug Desktop:
  the Desktop launched with both Chromium args, `native-picker-trace.jsonl` shows
  `desktop-proxy/account-read` to `https://127.0.0.1:<port>`, 37 routed requests across 25
  paths all 200 (one upstream 400 on `payments/payment_methods`, same without the proxy),
  `GET /backend-api/wham/usage` 200 with the renderer's `rate-limit-status` query `success`
  (`P-wham-usage.json`, redacted), log hygiene grep 0, stable Desktop pids untouched
  (`P-stable-pids.txt`). Kill switch: `CODEXHOST_DESKTOP_PROXY=0 npm run debug` relaunched
  without the SPKI arg, no rewrite trace, usage query still `success` against chatgpt.com.
  Default flipped to on for the stable launch (kill switch stays). Not yet observed by a human:
  Model picker, a GPT Turn and a Claude Turn through the proxied debug Desktop (P4–P6).
- 2026-09-22: Desktop backend proxy, Phase B. `desktop-usage-buckets.ts`: `harnessUsageBuckets`
  (5-hour primary + 7-day secondary from the Harness account snapshot, `allowed: true` and
  `limit_reached: false` so entries are inert for other Models, ≤64 names) and
  `DesktopUsagePublisher` (GET `/backend-api/wham/usage` only, 200 JSON only, `null` or array
  `additional_rate_limits` only, original bytes otherwise; existing names win). The Host feeds
  it one bucket per `model/list` route id of every ready Harness with `inspectAccount` plus the
  bare transport id, through a dedicated 90 s account-inspection cache (each Claude inspection
  spawns a process; the Desktop polls every 30 s). Renderer selectedModel confirmed via CDP to be
  the route id (`codexhost/claude-code-native@claude-model-v1.*`). vitest 1163 passed / 7
  skipped (8 bucket tests incl. a transcription of the renderer's `RFa/zFa/jFa/yq`, 1 Host
  test). Live: `desktop-proxy/usage buckets: 6`, `/wham/usage` 481 → 1093 bytes, renderer cache
  shows 5-hour 39 % / 7-day 20 % for all six Claude route ids, core Codex entry unchanged, a
  Claude Turn with a Subagent kept running through the proxied Desktop meanwhile. The very first
  usage poll during startup answered without buckets (Harness not ready within the 3 s bound);
  the next poll 30 s later carried them.
- 2026-09-22: J live check in the debug Desktop. With a Claude Thread active the profile menu
  item is the simplified "使用情况 · 剩余 73 %" (one svg, no submenu) and clicking it opens
  Settings › Usage, which renders the core window only (`Rvl`). So the appended Claude buckets
  are present in the renderer but have no surface on a weekly-only account. Candidate surfaces
  seen in the bundle: the server-driven `ambient_usage.default.menu.rows` (profile menu +
  sidebar subtext), gated by a statsig gate (`L_ "3538455134"`) and a zod schema (`wIa`); not
  attempted.
- 2026-09-22: J shipped through `ambient_usage`. The per-Model rows path is dead on weekly-only
  accounts, but the bundle's `h$s`/`a$s` render `ambient_usage.default.menu.rows` (zod `wIa`:
  `{label, value:{text, tone}, hover?:{text}}`) whenever the field is present and statsig gate
  `3538455134` is on — checked live via `__STATSIG__` (true). The publisher builds the section
  with the core Codex windows first (so the native "剩余 73 %" figure survives), appends one row
  per Harness window, and extends rather than replaces a server-sent section. Text is localized:
  the Desktop UI follows `app.getSystemLocale()` while its requests carry `en-US`, so the Host
  reads `defaults read -g AppleLanguages` once (`CODEXHOST_DESKTOP_LANGUAGE` overrides; the
  request language is the fallback; only that language is logged with a rewritten request).
  Harness names are shortened to their first word in rows and subtext. vitest 1172 passed / 7
  skipped. Live: profile menu shows "Usage › Codex · 每周 剩余 72 % / Claude · 5 小时 剩余 53 % /
  Claude · 每周 剩余 78 % / Claude · Fable · 7 天 剩余 69 %", hover "57 分钟后重置", sidebar subtext
  "Codex 72% · Claude 53%" — dropped afterwards on request: nothing custom under the account
  name, `profile_subtext` is sent as `null` unless the backend provided one.
- 2026-09-22: J labels tightened on request: "Codex 7 天 / Claude 5 小时 / Claude 7 天 / Fable 7 天"
  (no middle dots, the weekly window reads as 7 days, a product-scoped row keeps only its own
  label; English: "Codex 7-day / Claude 5-hour / Claude 7-day / Fable 7-day").
- 2026-09-22: J, sidebar card — attempted and reverted. The bundle's richer per-Model surface,
  `sidebar_usage_warnings` (zod `MIa`: `{default, by_model: Record<modelId, warning>}`,
  `wYs` → `_Ys` → `bYs` → `fYs`), picks `by_model[selectedModel]` by exact key and renders the
  card's own `rate_limit` windows with native labels, progress bars and reset times
  (`XJs`/`QJs`), but only behind statsig gate `3617198761`, absent from this account. The gate
  values are seeded from `POST /backend-api/wham/statsig/bootstrap` (`{statsigPayload}`, ~1 MB,
  through the proxy), so a bootstrap rewrite adding `feature_gates["3617198761"]` was built and
  did flip the gate on start. It does not hold: the Desktop calls `updateUserAsync` within
  seconds (user-consistency check, `desktop_app_beta_enabled`, and a periodic "Codex runtime
  config" refresh), which the SDK answers with a direct `https://ab.chatgpt.com/v1/initialize`
  (4.5 MB, `networkOverrideFunc` → `Rv.fetch`, not routed through `backendOrigin`, so never
  through the proxy). The store's source became `Network`/`NetworkNotModified` 14 s after start
  and the gate was gone; storage-backed cache and `sinceTime` deltas keep the network values
  afterwards. Holding it would need `ab.chatgpt.com` interception (system CA or hosts hijack —
  off the table) or gaming Statsig's delta protocol. Reverted the gate publisher, the composite
  rewrite and the `by_model` cards; `ambient_usage` stays the J surface.
- 2026-09-22: Desktop message queue on External Threads. The Desktop stopped using `turn/start`
  while a Turn runs and calls the experimental `thread/queue/*` family instead, which the Host
  answered with `-32076 External Thread does not support thread/queue/list`, so nothing could be
  queued behind a Claude Turn. Protocol taken from `codex-rs/app-server-protocol/.../v2/thread.rs`
  and `thread_queue_processor.rs` (0.154): `add {threadId, input, clientUserMessageId} ->
  {queuedSubmission}`, `list {cursor?, limit?} -> {data, nextCursor}`, `update`, `delete ->
  {deleted}`, `reorder` (every id exactly once), `start {queuedSubmissionId?} -> {turn}`, and the
  lightweight `thread/queue/changed {threadId}` notification. Semantics copied from the official
  suite: a submission added to an idle Thread starts at once, a completed Turn drains the head
  automatically, an interrupted or failed Turn leaves the queue alone until the user picks
  `thread/queue/start`. Host-owned and in-memory (`external-thread-queue.ts`, the Harness runs
  one Turn at a time as before; cleared with `thread/delete`); official Threads keep forwarding.
  vitest host-runtime 467 passed. Live in the debug Desktop (build 1790059691506, driven through
  CDP, `Q-*.png`): the Desktop's follow-up mode defaults to "调整方向" (steer) when no local
  project exists (`settings.general.followUpQueueMode`; ⌘⏎ does the opposite of the setting),
  so the first attempt steered as before. With "加入队列" selected, the second message while a
  Claude story was streaming arrived as `thread/queue/add` (trace `thread/queue` running:true →
  queued:1), the Desktop showed the queued chip above the composer (`Q-8-queued.png`), the story
  finished with DONE2, `thread/queue-drained` fired within the same second and the queued Turn
  answered QUEUED_OK_2 (`Q-9-after.png`). The Desktop only takes the server queue path when
  statsig gate `2120612410` is on (it is) and the app-server version is ≥ `threadQueue:
  0.148.0-alpha.14`.
- 2026-09-22: "Claude Code returned an invalid Tool lifecycle" after a follow-up during a
  background-task continuation. Claude launched a Bash task with `run_in_background`; when it
  finished, Claude Code injected a `<task-notification>` and continued on its own. The transport
  only handed such a Segment to the adapter as one batch after its `result`, so for three minutes
  the Host and Desktop saw the Thread idle: the user's follow-up went out as a plain `turn/start`,
  the adapter accepted it, `runTurn` opened a fresh accumulator and wrote the prompt into the
  running Segment (Claude Code logged `queue-operation ... absorbed_mid_turn`), and the running
  Bash tool's `tool_result` then reached an accumulator that had never seen the call
  (`#protocolConflict` → `transportFailure("protocol")`). Fix: the autonomous Segment now streams
  live through `ClaudeAutonomousTurnHandler` (`onStart` at the first Root output, then
  `onEvent`/`onTerminal`); the adapter opens the Turn at `onStart` (`turn.autonomous.started`, so
  the Host marks the Thread running and the Desktop queues or steers), `turn.start` answers
  `sessionBusy` meanwhile, and `runTurn` refuses a prompt while a Segment is open as a second
  guard. A notification Segment that never produces Root output still never opens a Turn.
  vitest claude-code 316 passed (two regressions added). Not yet re-verified live in the debug
  Desktop.
