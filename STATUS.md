# STATUS — goal tracker

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
- [ ] J. Usage chip (bonus). Not started; there is no native seam, the renderer reads only
      `rateLimitsByLimitId.codex`, so this needs a one-way CDP overlay.

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

## Log

- 2026-09-21: repo created from codex-host `43b8f282`; tsc green; vitest 1420 passed.
- 2026-09-21: native picker, thread settings guards, in-Host cua_repl, permission mapping;
  vitest 1429 passed; acceptance A-I verified live.
- 2026-09-21: side chat fixed (inject_items handled, fork inherits native settings, Thread
  responses carry the permission preset); vitest 1431 passed.
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
