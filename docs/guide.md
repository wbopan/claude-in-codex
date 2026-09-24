# User guide

English | [简体中文](guide.zh-CN.md)

Everything about using Claude in Codex after it is installed. For installing it, see the [README](../README.md).

To replace an installed copy, quit it from its menu first and wait for its tasks to finish, then drag the new one into Applications. Older releases that only offer a ZIP can be installed by unzipping and dragging the App into Applications. To build it yourself, see [Development](development.md).

The App's interface follows the macOS language: English by default, and Simplified Chinese when Chinese comes before English in System Settings › General › Language & Region. To choose the App's language by itself, add it under Applications in that same pane.

## Use

1. Open `/Applications/ChatGPT.app` as usual, then open Claude in Codex.
2. The cloud icon in the menu bar turns solid and opens its eyes once attached. The native model picker lists the local Claude models, and "Claude Connected" appears under the account name at the bottom left of the sidebar.
3. Choose Disconnect or Quit Claude in Codex and the App waits for running Claude Code Sessions and background tasks to finish. While it waits you can cancel the disconnect, or explicitly stop the Sessions.
4. The Codex App and its GPT tasks keep running. Reopen the App or choose Attach to Codex App to attach again.

Before attaching, the App checks only that the Codex App carries OpenAI's signature, then checks the internal connection layout at runtime. If the layout does not match, it stops and shows the reason instead of patching anything. The Host uses the Claude Code that is installed and signed in on the Mac, and the App bundles its own Node.js and plugins.

If the running Codex App was started by the old launcher, quit it and open the Codex App from Finder. The Host recognizes the old `CODEX_CLI_PATH` and refuses to attach on top of it.

This project was previously called Codex Host. If an old Codex Host.app is still running, Claude in Codex asks you to quit it first and continues starting once it has quit. The two never attach to the same Codex App at once.

## Updates

The App checks for a new version every six hours. You can check manually or turn automatic checks off under Settings › Updates. Before installing an update, the App waits for running Claude Code Sessions to finish, exactly as it does when quitting, then relaunches into the new version. Updates carry an EdDSA signature, and the App accepts only updates whose signature matches.

When the Codex App updates and attaching starts failing, the new Codex App has usually changed its internals. The App stops attaching and shows why, and a fixed version arrives through the automatic update. Each release lists the Codex App versions it was verified with.

## Menu and main window

The icon is the Claude cloud, adapted to light and dark menu bars, and its eyes show the state: an outlined cloud with closed eyes is detached, a solid cloud with open eyes is attached, three dots mean attaching or draining, and an exclamation mark means an error.

The menu keeps to a short status. The first line is the attachment state and opens the main window (⌘O). Below it are the remaining quota of each usage window as a small bar, with the percentage and reset time on hover, then Attach or Disconnect, Settings (⌘,) and Quit.

Only one Host runs at a time. Opening Claude in Codex.app again, including a copy at another path, does not start a second Host: the new instance asks the running one to show its main window and exits. Reopening the running App from Finder also shows the main window.

The main window's toolbar switches between Overview, Features and Settings, with the Attach or Disconnect button on the right.

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

## Data and remote connections

Model preferences, thread mappings, titles and archive records live in `~/Library/Application Support/Claude in Codex/`, and the log is written to `~/Library/Logs/Claude in Codex/host.log`. Both can be opened from the Settings pane. Claude's content and authentication stay with the native Claude Code. Attaching reads the `CODEX_HOME` the Codex App actually uses and keeps the existing Codex memory export and injection paths.

When upgrading from Codex Host, the first attach moves the data in `~/.codexhost` to the locations above, renames old logs to `codexhost-*.log` inside the log folder, and deletes the `desktop-proxy` the old launcher left behind. Once everything is moved, `~/.codexhost` is removed. If an old Host still holds the thread mappings, nothing is migrated and an error is shown instead. Quit the old Host and attach again. `codexhost/…` model identifiers in old threads, the old `CODEXHOST_*` environment variables and the old `codexhost/…` management methods all keep working.

Hot attach changes only the running Codex App's local stdio connection. Cloud GPT, ChatGPT Work and SSH hosts are still connected and filtered by the Codex App, and local Claude models are not added to the cloud model list. Existing SSH Remote Hosts, the Aqua broker and `claude-in-codex remote install|start|stop|status|uninstall` keep their own management, and the menu bar App never reinstalls or restarts remote services.

The Remote Host ships only as the npm package `@claude-in-codex/cli`. On the SSH target, run `npm install -g @claude-in-codex/cli` and then `claude-in-codex remote install`. The package contains only the Host Runtime (`app/host-runtime.mjs`, run by the current Node.js), the preinstalled Harness plugins and the Rust Shim (`libexec/claude-in-codex-shim`). Installing copies the Shim to `<data folder>/remote/bin/codex` (`~/Library/Application Support/Claude in Codex` on macOS, `$XDG_DATA_HOME/claude-in-codex` on Linux, by default `~/.local/share/claude-in-codex`) and adds a block to the login profile that applies only to SSH sessions. Reinstalling takes over the pre-rename `~/.codexhost/remote`: it migrates the data there, removes the old entry points and replaces the old profile block. On macOS the old `ai.bytepioneer.codexhost.*` LaunchAgents are removed as well. The Shim hands only the Codex Desktop managed `app-server --listen unix://` listener to the Host Runtime and passes every other call, including stdio `app-server`, to the official Codex CLI unchanged. On macOS the Aqua broker is installed and managed by the Shim's hidden `--claude-in-codex-broker` command, which `remote install|status|uninstall` calls automatically. It can also be managed on its own with `claude-in-codex broker install|status|stop|uninstall`. The old launcher, its DMG installer and the local stdio Host have been removed.
