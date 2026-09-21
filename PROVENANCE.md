# Provenance

This repository was extracted on 2026-09-21 from the personal fork of
[BytePioneer-AI/codex-host](https://github.com/BytePioneer-AI/codex-host) (MIT, see `LICENSE`).

| Item | Value |
| --- | --- |
| Source repository | `/Users/wenbopan/Projects/codex-host` (`origin` = github.com/wbopan/codex-host) |
| Source branch / commit | `wenbo/main` @ `43b8f282` |
| Upstream base contained in that commit | `fb36f2df` (upstream v0.9.1 line) |

Files were copied at their original paths so upstream fixes can still be compared or
cherry-picked by path (`git remote add upstream … && git cherry-pick`; no shared ancestry needed).

## Copied

`packages/{shared-contracts,harness-adapter,harness-broker,harness-discovery,mapping-store,protocol-core,desktop-control,update-manager,host-runtime}`,
`packages/adapters/claude-code`, `crates/{launcher,platform,shim,updater}`, `scripts/release`,
`tools/fork`, `tests/{vitest.config.js,tsconfig.json,fixtures/gate-a}`, root build configuration.

## Not copied

All other Harness adapters, `packages/renderer-extension`, `packages/repository-automation`,
gate/audit tools, e2e tests, website, docs, Windows/Linux installers' CI.

## Deviations made during extraction

- Removed host-runtime tests that import other adapters (`installed-harness-plugins`,
  `antigravity-*.real`, `harness-session-import`); narrowed `harness-plugin-loader.test.ts` to `claude-code`.
- `scripts/release/harness-plugins.json` ships only `claude-code`; license list trimmed accordingly.
- No renderer extension is built or injected. `app/renderer-extension.js` is a marker file that
  selects the passive Desktop Controller (`PASSIVE_RENDERER_MARKER`).
