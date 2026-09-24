# Architecture

Claude in Codex attaches to a Codex App that the user started normally. It never edits or re-signs the Codex App, never takes over launching it and never restarts it. This document explains how the attachment works and which parts stay native.

## Ownership

The signed Desktop starts normally and keeps its original app-server process. The MenuBar owns a Node Host and external harness sessions. A version-checked, memory-only agent bridges one existing local stdio connection to the existing `AppServerHost` over an authenticated Unix socket. `BorrowedDesktopBackend` supplies virtual clients to `OfficialRuntimeScope`; stopping one never stops the signed backend.

The socket directory is private (0700), the socket is 0600, and the agent authenticates with a random 256-bit token. Attachment checks the exact process identity, official signature, archive hash, inspector owner, and absence of a legacy launcher override. It opens the inspector only for installation and closes an inspector it owns; an existing developer debugger remains open. A second Host cannot remove the first Host's hooks.

Every method replacement retains its original descriptor and restores only its own replacement. A lost socket or expired 15-second lease restores the native methods and cache. Accepted requests are never replayed. In-flight external requests fail explicitly, and active external turns become interrupted. Ephemeral native tool contexts are unsubscribed through Desktop's own request correlation. Temporary socket files are cleaned by either owner.

Unsubscribing a native context does not immediately unload it. The official app-server keeps idle,
unsubscribed contexts for a 30-minute grace period. Tests check `notSubscribed`/`notLoaded`
after Host exit, rather than requiring the native loaded-thread cache to be empty. These cached
contexts remain owned by the original app-server. See the [official unsubscribe contract](https://developers.openai.com/codex/app-server).

## Attaching

The Codex App's main process is an Electron app. The Host sends it `SIGUSR1`, which opens the Node inspector on loopback, and evaluates a small agent in the main process. The agent finds the Desktop's connection class among the loaded modules by the shape of its methods (`routeResponse`, `listModels`, `getPendingRequestCount`), not by minified class names or export aliases, which change with every build. It then installs restorable wrappers on that class's prototype. The code is in `packages/host-runtime/src/hot-attach/`.

The agent never scans heap objects. `Runtime.queryObjects` crashed the Desktop process in testing, so the attachment relies only on exported modules and prototypes.

The agent holds a short lease that the Host renews. If the Host disappears, the main process's own timer restores every replaced method and clears the caches the attachment touched, so recovery does not depend on the Host still running.

These are internal details of the Codex App, not a published plugin interface. A new Codex App version can change them, so the Host checks the structure before attaching and refuses to attach when it does not match.

## Lifecycle

`detached → attaching → attached → draining → detaching → detached`

Draining closes admission for new external turns, forks, steering and queue submissions. Approvals, cancellation, history reads and native GPT requests continue. The Host waits for foreground turns, background shell tasks, subagents and requests already in progress. The existing successful-turn queue processing remains active. Canceling a drain reopens admission. Explicit stop cancels external work and releases adapter processes; it does not signal Desktop or its backend.

The native app's ordinary quit waits for this drain. Losing the native app's control pipe forces cleanup so an orphaned Host does not keep the integration active. A crashed Host is reported in the menu and can be restarted with “接入 Codex App”. If Desktop itself exits or replaces the local backend, the attachment restores itself; the user can attach again after Desktop is ready.

## How each feature is implemented

| Surface | Implementation |
| --- | --- |
| Models, effort, hidden/family filters | `native-picker`, original model/config responses plus local external projection |
| Native Cloud/GPT and SSH routing | Other connection instances remain unchanged |
| Permissions and Plan | Existing request decoding, native permission/Plan synchronization |
| Streaming and reasoning | Existing Claude SDK adapter and Codex projector |
| Native app tools and Computer Use | Borrowed signed backend, ephemeral tool contexts, native elicitations and `turn_ended` |
| Child tasks, steering and queues | Existing session/child projection and thread queue |
| History, titles, archive and memory | Same mapping store and Claude transcript/native memory adapters |
| Quota | Read from the native authenticated usage response for the menu bar only; the Desktop's usage menu stays native |
| Remote lifecycle and macOS broker | Existing remote lifecycle; shipped only as the npm `@claude-in-codex/cli` Remote Host, whose Shim also manages the broker (`--claude-in-codex-broker`) |

External catalog entries are added only to the local connection. Native cloud membership and filters are left to the original connection and renderer. Detach invalidates local model/config queries and the exact `rate-limit-status` query, restoring their native values without page reload or persistent app changes.

The usage hook only touches successful JSON GET responses for `/backend-api/wham/usage`: Host reads the Codex quota from them for the menu bar and sets `ambient_usage.default.profile_subtext` to "Claude Connected", the line under the account name in the sidebar footer. Quota rows and per-Model limits stay native. The native network implementation retains authentication, workspace routing and TLS. A 1.5-second fallback returns the original response when Host does not answer. Attach refreshes the usage query so the subtext appears without a reload.

## Menu and package

The native AppKit app starts as a menu bar accessory (`LSUIElement`) without a Dock icon; it switches to the regular activation policy while its main window or About panel is open, so the Dock icon appears with the first window and leaves with the last. An 18-point monochrome template mark draws the Claude cloud from `apps/macos/icon`, and its pixel eyes show the state: open eyes in a solid cloud when attached, closed eyes in an outlined cloud when detached, three dots while attaching or draining and `!` on error. The menu and the main window are described in the [README](../README.md#menu-and-main-window). The App icon comes from the Icon Composer document `apps/macos/icon/Claude.icon`: with Xcode, `actool` compiles it into `Assets.car` with its dark, tinted and clear appearances; without Xcode the build falls back to an icns made from `AppIcon-1024.png`.

The package contains the Swift executable, a Node.js 22 or 24 runtime, the bundled Host and the reviewed harness plugins. `build.json` records the version, source revision and digest, Node version and build time. Rebuilding a running bundle is refused. The official App is neither edited nor re-signed. Builds are signed with a Developer ID certificate when the keychain has one and ad hoc otherwise, and released builds are also notarized, see [release.md](release.md).
