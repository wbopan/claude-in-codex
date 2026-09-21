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
- [ ] J. Usage chip (bonus). Not started; there is no native seam, the renderer reads only
      `rateLimitsByLimitId.codex`, so this needs a one-way CDP overlay.

## Not done

- Carve phase: multi-harness remnants, remote*, delegation*, update-manager/updater, session
  import, accounts/settings and Windows code are still in the tree.
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
