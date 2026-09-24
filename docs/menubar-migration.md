# MenuBar Host migration

Development checkout: `menubar-hot-attach/claude-in-codex`, branch `codex/menubar-hot-attach`.
The original checkout stays on `main`; this migration does not edit it. The stable Desktop serving development is never a test target.

## Ownership

The signed Desktop starts normally and keeps its original app-server process. The MenuBar owns a Node Host and external harness sessions. A version-checked, memory-only agent bridges one existing local stdio connection to the existing `AppServerHost` over an authenticated Unix socket. `BorrowedDesktopBackend` supplies virtual clients to `OfficialRuntimeScope`; stopping one never stops the signed backend.

The socket directory is private (0700), the socket is 0600, and the agent authenticates with a random 256-bit token. Attachment checks the exact process identity, official signature, archive hash, inspector owner, and absence of a legacy launcher override. It opens the inspector only for installation and closes an inspector it owns; an existing developer debugger remains open. A second Host cannot remove the first Host's hooks.

Every method replacement retains its original descriptor and restores only its own replacement. A lost socket or expired 15-second lease restores the native methods and cache. Accepted requests are never replayed. In-flight external requests fail explicitly, and active external turns become interrupted. Ephemeral native tool contexts are unsubscribed through Desktop's own request correlation. Temporary socket files are cleaned by either owner.

Unsubscribing a native context does not immediately unload it. The official app-server keeps idle,
unsubscribed contexts for a 30-minute grace period. Acceptance checks `notSubscribed`/`notLoaded`
after Host exit, rather than requiring the native loaded-thread cache to be empty. These cached
contexts remain owned by the original app-server. See the [official unsubscribe contract](https://developers.openai.com/zh-Hans/docs/app-server).

## Lifecycle

`detached → attaching → attached → draining → detaching → detached`

Draining closes admission for new external turns, forks, steering and queue submissions. Approvals, cancellation, history reads and native GPT requests continue. The Host waits for foreground turns, background shell tasks, subagents and requests already in progress. The existing successful-turn queue processing remains active. Canceling a drain reopens admission. Explicit stop cancels external work and releases adapter processes; it does not signal Desktop or its backend.

The native app's ordinary quit waits for this drain. Losing the native app's control pipe forces cleanup so an orphaned Host does not keep the integration active. A crashed Host is reported in the menu and can be restarted with “接入 Codex App”. If Desktop itself exits or replaces the local backend, the attachment restores itself; the user can attach again after Desktop is ready.

## Feature parity

| Surface | Implementation retained | Verification |
| --- | --- | --- |
| Models, effort, hidden/family filters | `native-picker`, original model/config responses plus local external projection | Existing picker tests and real model union |
| Native Cloud/GPT and SSH routing | Other connection instances remain unchanged | Scope isolation tests; real GPT turns span attach and detach; remote suites |
| Permissions and Plan | Existing request decoding, native permission/Plan synchronization | Host, picker and Claude adapter suites |
| Streaming and reasoning | Existing Claude SDK adapter and Codex projector | Real Haiku stream and full protocol suite |
| Native app tools and Computer Use | Borrowed signed backend, ephemeral tool contexts, native elicitations and `turn_ended` | Tool suites and isolated live calls |
| Child tasks, steering and queues | Existing session/child projection and thread queue | Host, subagent and queue suites |
| History, titles, archive and memory | Same mapping store and Claude transcript/native memory adapters | History/memory suites; history read after detach/reattach |
| Quota | Read from the native authenticated usage response for the menu bar only; the Desktop's usage menu stays native | Live Codex/Claude/Fable rows in the App and usage suites |
| Remote lifecycle and macOS broker | Existing remote lifecycle; shipped only as the npm `@claude-in-codex/cli` Remote Host, whose Shim also manages the broker (`--claude-in-codex-broker`) | Full existing TypeScript/Rust remote tests |

External catalog entries are added only to the local connection. Native cloud membership and filters are left to the original connection and renderer. Detach invalidates local model/config queries and the exact `rate-limit-status` query, restoring their native values without page reload or persistent app changes.

The usage hook only touches successful JSON GET responses for `/backend-api/wham/usage`: Host reads the Codex quota from them for the menu bar and sets `ambient_usage.default.profile_subtext` to "Claude Connected", the line under the account name in the sidebar footer. Quota rows and per-Model limits stay native. The native network implementation retains authentication, workspace routing and TLS. A 1.5-second fallback returns the original response when Host does not answer. Attach refreshes the usage query so the subtext appears without a reload.

## Menu and package

The native AppKit app starts as a menu bar accessory (`LSUIElement`) without a Dock icon; it switches to the regular activation policy while its Dashboard or About panel is open, so the Dock icon appears with the first window and leaves with the last. An 18-point monochrome template mark draws the Claude cloud from `apps/macos/icon`, and its pixel eyes show the state: open eyes in a solid cloud when attached, closed eyes in an outlined cloud when detached, three dots while attaching or draining and `!` on error. The menu exposes active foreground/background counts, connect, drain, cancel drain, explicit stop, open Desktop, status, logs and quit. The optional status window has the same actions and menu. The App icon comes from the Icon Composer document `apps/macos/icon/Claude.icon`: with Xcode, `actool` compiles it into `Assets.car` with its dark, tinted and clear appearances; without Xcode the build falls back to an icns made from `AppIcon-1024.png`.

The package contains the Swift executable, Node 22/24, bundled Host and reviewed harness plugins. `build.json` records source revision/digest, Node version and supported Desktop version. Rebuilding a running bundle is refused. The official App is neither edited nor re-signed. This is a local ad-hoc signed build for the build machine's architecture.

## Acceptance evidence

The disposable stock App is under `.dev/hot-attach-research/app/ChatGPT.app`; Codex, Electron, Claude and Host data are isolated. Native authentication is reused through the supported default credential store. No credentials are copied into source or reports. The fixture starts without a CLI override or inspector launch flags.

Local reports, logs and screenshots are generated under `.dev/` and excluded from Git. `tools/probes/menubar-acceptance.mjs` drives real protocol requests against the recorded fixture PID and writes a sanitized report. It checks live model union, GPT continuity, background drain/cancel, admission, history and native CUA. `menubar-turn.mjs` and `menubar-usage.mjs` provide targeted probes. The older model-only prototype and its distinct evidence remain documented in [hot-attach-research.md](hot-attach-research.md).

Recorded checks (2026-09-22, Desktop 26.915.31945):

- TypeScript: 1205 passed, 7 skipped; 107 files passed, 3 skipped.
- Rust: 171 passed across launcher/platform/shim unit and integration suites. (The launcher crate and the local launcher flow were removed on 2026-09-23; the workspace is now `platform` and `shim` only, see [STATUS](status.md).)
- Real native GPT turns completed across both attach and detach; Desktop and signed backend PIDs stayed unchanged.
- Local model list contained 5 native GPT models and 5 Claude choices.
- Background drain was canceled and resumed, rejected new external work, then waited about 40 seconds for a native Claude shell task. History remained readable after reconnecting.
- Native `codex_app.get_usage_limits` and `cua_repl.js` calls succeeded. CUA acceptance reads the actual pending tool input and grants only that one `await cua.getState()` request, with no persistent consent.
- Live native quota cache contained Codex, Claude 5-hour/7-day and Fable 7-day rows.
- An additional Host was rejected while preserving the first Host. Control-pipe loss during a pending quit forced cleanup. Host SIGKILL restored native hooks; the Host, Claude, shell and background sleep exited, and their private socket directory was removed. A Host-opened inspector closed after attachment.
- The native MenuBar app's status, dropdown, connect and disconnect actions were checked through accessibility. The template/App icons were visually inspected.

Current generated reports are in `.dev/hot-attach-research/`, including `menubar-acceptance.json`, `menubar-lifecycle.json`, `menubar-owner-loss.json` and `second-host.json`. `tools/probes/menubar-lifecycle.mjs` reproduces the fault tests against a newly spawned Host and the recorded disposable Desktop. Re-run these probes after future compatibility changes. The main checkout can contain unrelated concurrent edits; migration changes stay in this worktree.
