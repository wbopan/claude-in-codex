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

## Acceptance checklist (each needs live evidence under `.codexhost/acceptance/`)

- [ ] A. Debug snapshot builds from this repo; independent debug Desktop starts; stable PIDs unchanged.
- [ ] B. No renderer injection: `__codexhostRendererBindingProbeV1` undefined in the page.
- [ ] C. Native picker lists Claude models from the adapter catalog; a real Claude turn completes.
- [ ] D. Selected reasoning effort reaches the Claude adapter (collaborationMode wins over top-level).
- [ ] E. Route id never written to `config.toml`; selection survives restart.
- [ ] F. `thread/settings/update` guarded both ways (Claude→GPT and GPT→Claude rejected or handled).
- [ ] G. Claude calls a `codex_app` tool successfully.
- [ ] H. Claude calls `cua_repl` `js` in-Host (no Python bridge) successfully.
- [ ] I. Plan toggle maps to Claude plan mode (stretch).
- [ ] J. Usage chip (bonus, stretch).

## Log

- 2026-09-21: repo created from codex-host `43b8f282`; tsc green; vitest 1420 passed.
