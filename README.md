# Claude in Codex

English | [简体中文](docs/README.zh-CN.md)

Use your local Claude Code inside the normally launched Codex App (`/Applications/ChatGPT.app`). Claude in Codex is a macOS menu bar app: once it attaches, the Codex App's native model picker gains the local Claude models, and Claude Code Sessions run next to GPT tasks in the same window.

The App's interface is currently in Chinese. English support is planned; this README gives each Chinese label next to its English meaning.

## Install

1. Download `Claude-in-Codex-<version>-arm64.dmg` from the [latest release](https://github.com/wbopan/claude-in-codex/releases/latest).
2. Open the DMG and drag **Claude in Codex.app** onto **Applications**. If replacing an installed copy, quit it from its menu first and wait for its tasks to finish.
3. Eject the disk image. Open the Codex App first, then Claude in Codex from Applications.

Older releases that only offer a ZIP can still be installed by unzipping and dragging the App into Applications.

The App is signed with a Developer ID and notarized by Apple, so it opens without warnings. It needs an Apple silicon Mac, macOS 14 or later, the official Codex App, and [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed and signed in. To build it yourself, see [Build](#build).

## Use

1. Open `/Applications/ChatGPT.app` as usual, then open Claude in Codex.
2. The cloud icon in the menu bar turns solid and opens its eyes once attached. The native model picker lists the local Claude models, and "Claude Connected" appears under the account name at the bottom left of the sidebar.
3. Choose Disconnect (断开) or Quit Claude in Codex (退出 Claude in Codex) and the App waits for running Claude Code Sessions and background tasks to finish. While it waits you can cancel the disconnect, or explicitly stop the Sessions.
4. The Codex App and its GPT tasks keep running. Reopen the App or choose Attach to Codex App (接入 Codex App) to attach again.

Before attaching, the App checks only that the Codex App carries OpenAI's signature, then checks the internal connection layout at runtime. If the layout does not match, it stops and shows the reason instead of patching anything. The Host uses the Claude Code that is installed and signed in on the Mac, and the App bundles its own Node.js and plugins.

If the running Codex App was started by the old launcher, quit it and open the Codex App from Finder. The Host recognizes the old `CODEX_CLI_PATH` and refuses to attach on top of it.

This project was previously called Codex Host. If an old Codex Host.app is still running, Claude in Codex asks you to quit it first and continues starting once it has quit. The two never attach to the same Codex App at once.

## Updates

The App checks for a new version every six hours. You can check manually or turn automatic checks off under Settings › Updates (设置 › 更新). Before installing an update, the App waits for running Claude Code Sessions to finish, exactly as it does when quitting, then relaunches into the new version. Updates carry an EdDSA signature, and the App accepts only updates whose signature matches.

When the Codex App updates and attaching starts failing, the new Codex App has usually changed its internals. The App stops attaching and shows why, and a fixed version arrives through the automatic update. Each release lists the Codex App versions it was verified with.

## Menu and main window

The icon is the Claude cloud, adapted to light and dark menu bars, and its eyes show the state: an outlined cloud with closed eyes is detached, a solid cloud with open eyes is attached, three dots mean attaching or draining, and an exclamation mark means an error.

The menu keeps to a short status. The first line is the attachment state and opens the main window (⌘O). Below it are the remaining quota of each usage window as a small bar, with the percentage and reset time on hover, then Attach or Disconnect, Settings (⌘,) and Quit.

Only one Host runs at a time. Opening Claude in Codex.app again, including a copy at another path, does not start a second Host: the new instance asks the running one to show its main window and exits. Reopening the running App from Finder also shows the main window.

The main window's toolbar switches between Overview (概览), Features (功能) and Settings (设置), with the Attach or Disconnect button on the right.

**Overview**

- Components: cards for the Codex App, the Claude Code CLI and Claude in Codex, each with its icon and health (running, the number of Claude processes the Host started, attached). The icons are plain glyphs: the Codex cloud taken from the Codex App's own icon, the Clawd pixel art for the Claude Code CLI, and the Claude cloud for Claude in Codex.
- Usage: one row per quota window with a remaining bar, the percentage and the reset time. Windows at 20% or less turn orange. Codex quotas come from `/backend-api/wham/usage`, which the Codex App polls itself: structured `rate_limit` windows first, otherwise the text lines the server sends. Claude Code quotas come from Claude Code's account usage endpoint (the 5-hour, weekly and per-model weekly windows, such as Fable) and are cached for 90 seconds. The Codex App's own usage menu stays native.
- Claude Code Sessions: one row per Session with its title, current activity (thinking, running a command, waiting for approval and so on) and elapsed time. Hovering shows its directory. Prompts, commands and output are never shown.

The Claude Code CLI process count and the usage are read after attaching.

**Features**

Switches for optional features, saved in `features.json` in the data folder. When a feature has a problem, its description is replaced by an orange line explaining it.

- Tools: Codex App tools (let Claude create and manage Codex threads and send them messages), and Computer & Browser Use.
- Memory: Codex memory injection (appends the Codex memory summary to Claude's system prompt), and Claude Code memory sync (syncs Claude's auto memory into Codex's memory).
- Session: idle release is a duration rather than a switch. It is either never, or the number of idle minutes after which a Session's Claude process is released and resumed on the next message. The default is never. The file stores it as the switch `idleRelease` plus the timeout `idleReleaseTimeoutMinutes`.

Tools and memory injection apply from the next Session, the rest immediately. Whether a feature is on is decided only by `features.json`, never by environment variables.

**Settings**

- Launch at login: registers the App as a login item. If macOS asks for approval, this row says so and offers to open the Login Items settings.
- Attach to the Codex App at launch: on by default. When off, the Host starts but stays detached until you choose Attach to Codex App from the menu.
- Open this window at launch: off by default.
- Updates: automatic checks (on by default in released builds, every six hours) and Check for Updates, with the current version shown below.
- The locations of the Codex App, the data folder and the diagnostic log, each of which can be revealed in Finder. The log can also be opened directly.

About Claude in Codex shows the version, and the Git revision and build time recorded by the build.

## Uninstall

1. Choose Quit Claude in Codex from the menu bar and wait for running tasks to finish.
2. Delete Claude in Codex.app from the Applications folder.
3. To remove its data as well, delete `~/Library/Application Support/Claude in Codex` and `~/Library/Logs/Claude in Codex`.

## Privacy

Attaching happens only on your Mac, and it changes only the connection between the running Codex App and your local Claude Code. Claude conversations and authentication are handled by Claude Code itself. Besides that, the App contacts only GitHub, to check for and download updates, and it collects no usage data.

## Data and remote connections

Model preferences, thread mappings, titles and archive records live in `~/Library/Application Support/Claude in Codex/`, and the log is written to `~/Library/Logs/Claude in Codex/host.log`. Both can be opened from the Settings pane. Claude's content and authentication stay with the native Claude Code. Attaching reads the `CODEX_HOME` the Codex App actually uses and keeps the existing Codex memory export and injection paths.

When upgrading from Codex Host, the first attach moves the data in `~/.codexhost` to the locations above, renames old logs to `codexhost-*.log` inside the log folder, and deletes the `desktop-proxy` the old launcher left behind. Once everything is moved, `~/.codexhost` is removed. If an old Host still holds the thread mappings, nothing is migrated and an error is shown instead. Quit the old Host and attach again. `codexhost/…` model identifiers in old threads, the old `CODEXHOST_*` environment variables and the old `codexhost/…` management methods all keep working.

Hot attach changes only the running Codex App's local stdio connection. Cloud GPT, ChatGPT Work and SSH hosts are still connected and filtered by the Codex App, and local Claude models are not added to the cloud model list. Existing SSH Remote Hosts, the Aqua broker and `claude-in-codex remote install|start|stop|status|uninstall` keep their own management, and the menu bar App never reinstalls or restarts remote services.

The Remote Host ships only as the npm package `@claude-in-codex/cli`. On the SSH target, run `npm install -g @claude-in-codex/cli` and then `claude-in-codex remote install`. The package contains only the Host Runtime (`app/host-runtime.mjs`, run by the current Node.js), the preinstalled Harness plugins and the Rust Shim (`libexec/claude-in-codex-shim`). Installing copies the Shim to `<data folder>/remote/bin/codex` (`~/Library/Application Support/Claude in Codex` on macOS, `$XDG_DATA_HOME/claude-in-codex` on Linux, by default `~/.local/share/claude-in-codex`) and adds a block to the login profile that applies only to SSH sessions. Reinstalling takes over the pre-rename `~/.codexhost/remote`: it migrates the data there, removes the old entry points and replaces the old profile block. On macOS the old `ai.bytepioneer.codexhost.*` LaunchAgents are removed as well. The Shim hands only the Codex Desktop managed `app-server --listen unix://` listener to the Host Runtime and passes every other call, including stdio `app-server`, to the official Codex CLI unchanged. On macOS the Aqua broker is installed and managed by the Shim's hidden `--claude-in-codex-broker` command, which `remote install|status|uninstall` calls automatically. It can also be managed on its own with `claude-in-codex broker install|status|stop|uninstall`. The old launcher, its DMG installer and the local stdio Host have been removed.

To check the npm packages locally, `npm run release:npm -- --pack` builds the package for the current platform and `npm run release:npm:meta -- --version <version> --pack` builds the entry package, both into `build/npm/`.

## Build

You need Node 22.19+ or 24 (development defaults to the version in `.node-version`), npm and the Xcode Command Line Tools. The App is built for the current machine's architecture.

```sh
npm ci
npm run app:install
open '/Applications/Claude in Codex.app'
```

`npm run app:install` builds into `.dev/app/Claude in Codex.app` and then replaces the App in `/Applications`. A running App is never overwritten: quit it from the menu first, waiting for its tasks, then install. `npm run app:build` builds without installing.

DMG packaging requires Swift 6.2 or newer. `npm run app:dmg` builds a development DMG in `build/app-dmg/`. To package an existing build, run `node tools/app/dmg.mjs`. These local images are not notarized. `npm run release:app` produces a signed, notarized DMG for installation and keeps the ZIP for Sparkle updates; see the [release runbook](docs/release.md).

`CLAUDE_IN_CODEX_NODE_BINARY=/absolute/path/to/node` picks the Node 22 or 24 to bundle. The build produces the App icon (Xcode's `actool` compiles `apps/macos/icon/Claude.icon`, and without Xcode an icns is made from the pre-rendered PNG), embeds the Sparkle update framework (downloaded once into `.dev/toolchains` at a pinned version and checksum), then signs with the Developer ID certificate in the keychain and verifies the signature. Without a certificate it falls back to ad hoc signing. The version comes from the root `package.json`. Development builds never check for updates on their own, only on request.

Development artifacts (builds, toolchains, test data) live under the Git-ignored `.dev/`. `npm run bootstrap` installs the Node and Rust toolchains into `.dev/toolchains`.

To test against a separate copy of the Codex App, `CLAUDE_IN_CODEX_DESKTOP_APP` points at that copy and `CLAUDE_IN_CODEX_DATA_DIR` sets the Host's data folder. `CLAUDE_IN_CODEX_AUTO_ATTACH=0|1` and `CLAUDE_IN_CODEX_SHOW_DASHBOARD=1` override the matching launch settings. `CLAUDE_IN_CODEX_SHOW_FEATURES=1` and `CLAUDE_IN_CODEX_SHOW_SETTINGS=1` open the main window's Features or Settings pane at launch, and `CLAUDE_IN_CODEX_SHOW_ABOUT=1` opens the About window. Normal use needs none of these.

While Claude in Codex is running, a new build with the same bundle identifier hands over to it and exits. To test the UI side by side with the Host you are using, build a separately identified copy and turn off attaching at launch:

```sh
CLAUDE_IN_CODEX_BUNDLE_ID=ai.bytepioneer.claude-in-codex.test CLAUDE_IN_CODEX_APP_NAME='Claude in Codex Test' npm run app:build
open --env CLAUDE_IN_CODEX_AUTO_ATTACH=0 --env CLAUDE_IN_CODEX_DATA_DIR="$PWD/.dev/test-data" '.dev/app/Claude in Codex Test.app'
```

The test copy has its own preferences and login item.

## Release

Releases are published as GitHub Releases of this repository, and the App learns about a new version from the latest release's `appcast.xml`. To release a version:

```sh
# 1. Bump "version" in package.json, add a matching section to docs/CHANGELOG.md, and commit.
# 2. Push a matching tag. GitHub Actions builds, notarizes and publishes it.
git tag v<version> && git push origin v<version>
```

`npm run release:app -- --publish` does the same from a Mac. Credentials, key backups and what to do when something fails are in the [release runbook](docs/release.md).

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

[docs/architecture.md](docs/architecture.md) explains how attaching works. The hot attach code is in `packages/host-runtime/src/hot-attach/`, the native menu in `apps/macos/main.swift`, and the packaging and install entry points in `tools/app/`. Data and log locations are resolved in one place, `packages/shared-contracts/src/app-paths.ts`, and compatibility with pre-rename identifiers sits in each reader. Protocol, adapters, model projection, permissions, history, tools and the remote implementation reuse the existing Host.

## License

MIT, see [LICENSE](LICENSE). The App's third-party notices are in `Claude in Codex.app/Contents/Resources/THIRD_PARTY_NOTICES.txt`.

Claude in Codex is an independent project and is not affiliated with Anthropic or OpenAI. Claude and Claude Code are trademarks of Anthropic. Codex and ChatGPT are trademarks of OpenAI.
