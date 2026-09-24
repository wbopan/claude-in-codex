# Development

How to build Claude in Codex from source, run its tests and publish a release.

## Build

You need Node 22.19+ or 24 (development defaults to the version in `.node-version`), npm and the Xcode Command Line Tools. The App is built for the current machine's architecture.

```sh
npm ci
npm run app:install
open '/Applications/Claude in Codex.app'
```

`npm run app:install` builds into `.dev/app/Claude in Codex.app` and then replaces the App in `/Applications`. A running App is never overwritten: quit it from the menu first, waiting for its tasks, then install. `npm run app:build` builds without installing.

DMG packaging requires Swift 6.2 or newer. `npm run app:dmg` builds a development DMG in `build/app-dmg/`. To package an existing build, run `node tools/app/dmg.mjs`. These local images are not notarized. `npm run release:app` produces a signed, notarized DMG for installation and keeps the ZIP for Sparkle updates; see the [release runbook](release.md).

`CLAUDE_IN_CODEX_NODE_BINARY=/absolute/path/to/node` picks the Node 22 or 24 to bundle. The build produces the App icon (Xcode's `actool` compiles `apps/macos/icon/Claude.icon`, and without Xcode an icns is made from the pre-rendered PNG), embeds the Sparkle update framework (downloaded once into `.dev/toolchains` at a pinned version and checksum), then signs with the Developer ID certificate in the keychain and verifies the signature. Without a certificate it falls back to ad hoc signing. The version comes from the root `package.json`. Development builds never check for updates on their own, only on request.

Development artifacts (builds, toolchains, test data) live under the Git-ignored `.dev/`. `npm run bootstrap` installs the Node and Rust toolchains into `.dev/toolchains`.

To test against a separate copy of the Codex App, `CLAUDE_IN_CODEX_DESKTOP_APP` points at that copy and `CLAUDE_IN_CODEX_DATA_DIR` sets the Host's data folder. `CLAUDE_IN_CODEX_AUTO_ATTACH=0|1` and `CLAUDE_IN_CODEX_SHOW_DASHBOARD=1` override the matching launch settings. `CLAUDE_IN_CODEX_SHOW_FEATURES=1` and `CLAUDE_IN_CODEX_SHOW_SETTINGS=1` open the main window's Features or Settings pane at launch, and `CLAUDE_IN_CODEX_SHOW_ABOUT=1` opens the About window. Normal use needs none of these.

While Claude in Codex is running, a new build with the same bundle identifier hands over to it and exits. To test the UI side by side with the Host you are using, build a separately identified copy and turn off attaching at launch:

```sh
CLAUDE_IN_CODEX_BUNDLE_ID=ai.bytepioneer.claude-in-codex.test CLAUDE_IN_CODEX_APP_NAME='Claude in Codex Test' npm run app:build
open --env CLAUDE_IN_CODEX_AUTO_ATTACH=0 --env CLAUDE_IN_CODEX_DATA_DIR="$PWD/.dev/test-data" '.dev/app/Claude in Codex Test.app'
```

The test copy has its own preferences and login item.

To check the npm packages locally, `npm run release:npm -- --pack` builds the package for the current platform and `npm run release:npm:meta -- --version <version> --pack` builds the entry package, both into `build/npm/`.

## Release

Releases are published as GitHub Releases of this repository, and the App learns about a new version from the latest release's `appcast.xml`. To release a version:

```sh
# 1. Bump "version" in package.json, add a matching section to docs/CHANGELOG.md, and commit.
# 2. Push a matching tag. GitHub Actions builds, notarizes and publishes it.
git tag v<version> && git push origin v<version>
```

`npm run release:app -- --publish` does the same from a Mac. Credentials, key backups and what to do when something fails are in the [release runbook](release.md).

## Development

`.node-version` pins the development Node version (the same one `npm run bootstrap` downloads), and `fnm use` or `nvm use` read it. `.npmrc` turns on `engine-strict`, so `npm ci` fails on a mismatched version. `npm ci` also installs a lefthook pre-commit hook that runs Prettier, ESLint and rustfmt on staged files only. `LEFTHOOK=0 git commit` skips it once.

```sh
npm run check            # the full pre-commit check: types, lint, format and every test
npm run test:unit        # everyday changes: millisecond unit tests
npm run test:watch       # unit tests in watch mode
npm run test:integration # slower tests that start a Host or spawn processes
npm run test:coverage    # v8 coverage report in coverage/
```

`npm run typecheck` checks both the package sources and the tests (`tests/tsconfig.json`). GitHub Actions (`.github/workflows/ci.yml`) runs the same checks on every push to `main` and on every pull request.

Test conventions:

- Tests live in each package's `test/`. Tests that start a Host, spawn child processes or take seconds go in `test/integration/` and belong to the `integration` project.
- `*.real.test.ts` talks to a real Claude Code and runs only when the matching `CLAUDE_IN_CODEX_RUN_*=1` is set.
- Unit and integration tests run with `HOME`, `CODEX_HOME` and `CLAUDE_CONFIG_DIR` pointing at temporary folders (`tests/setup/isolate-home.ts`), so they never read the developer's own `~/.codex` or `~/.claude`.
- Temporary folders come from `tempDir()` in `tests/helpers/temp-dir.ts`: the path has symbolic links resolved and is removed when the test ends.
- Wait for asynchronous results on a concrete event or with `vi.waitFor`, never with a fixed sleep. A leftover `.only` fails the run in CI.
- Large test files are split by feature into a folder of the same name, with shared fixtures in a non-test module inside it.

[docs/architecture.md](architecture.md) explains how attaching works. The hot attach code is in `packages/host-runtime/src/hot-attach/`, the native menu in `apps/macos/main.swift`, and the packaging and install entry points in `tools/app/`. Data and log locations are resolved in one place, `packages/shared-contracts/src/app-paths.ts`, and compatibility with pre-rename identifiers sits in each reader. Protocol, adapters, model projection, permissions, history, tools and the remote implementation reuse the existing Host.
