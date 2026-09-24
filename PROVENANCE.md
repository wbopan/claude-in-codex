# Provenance

This repository was extracted on 2026-09-21 from the personal fork of
[BytePioneer-AI/codex-host](https://github.com/BytePioneer-AI/codex-host) (MIT, see `LICENSE`).

| Item | Value |
| --- | --- |
| Source repository | [wbopan/codex-host](https://github.com/wbopan/codex-host) |
| Source branch / commit | `wenbo/main` @ `43b8f282` |
| Upstream base contained in that commit | `fb36f2df` (upstream v0.9.1 line) |

Files were copied at their original paths so upstream fixes can still be compared or
cherry-picked by path (`git remote add upstream … && git cherry-pick`; no shared ancestry needed).

## Copied

`packages/{shared-contracts,harness-adapter,harness-broker,harness-discovery,mapping-store,protocol-core,desktop-control,update-manager,host-runtime}`,
`packages/adapters/claude-code`, `crates/{launcher,platform,shim,updater}`, `scripts/release`,
`tools/toolchain`, `tests/{vitest.config.js,tsconfig.json,fixtures/gate-a}`, root build configuration.

## Not copied

All other Harness adapters, `packages/renderer-extension`, `packages/repository-automation`,
gate/audit tools, e2e tests, website, docs, Windows/Linux installers' CI.

## Deviations made during extraction

- Removed host-runtime tests that import other adapters (`installed-harness-plugins`,
  `antigravity-*.real`, `harness-session-import`); narrowed `harness-plugin-loader.test.ts` to `claude-code`.
- `scripts/release/harness-plugins.json` ships only `claude-code`; license list trimmed accordingly.
- No renderer extension is built or injected. `app/renderer-extension.js` is a marker file that
  selects the passive Desktop Controller (`PASSIVE_RENDERER_MARKER`). (Removed with the launcher
  on 2026-09-23, see below.)

## Later deviations

- 2026-09-23: removed the local launcher flow that upstream still ships: `crates/launcher`, the
  macOS DMG payload (`scripts/release/{prepare-payload,prepare-version}.mjs`,
  `scripts/release/macos/`), the debug-instance/fork build, the Shim's local stdio Host path, the
  Desktop backend proxy, native account host, launcher URL opener and the Desktop Controller
  release entry. The macOS menu bar app is the only local entry. The broker CLI moved into the
  Shim (`--codexhost-broker`); the npm package ships only the Remote Host. Upstream fixes to the
  removed paths no longer apply by path.
- 2026-09-23: renamed from Codex Host (`codexhost`) to Claude in Codex (`claude-in-codex`) across
  packages, crates, commands, environment variables and on-wire names, with readers for the legacy
  names. Upstream paths and identifiers no longer match by name.
