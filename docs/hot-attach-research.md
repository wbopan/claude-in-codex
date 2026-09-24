# Codex Desktop Hot-Attach Research

2026-09-22, this Mac (macOS), Desktop `26.915.31945`.

Conclusion: the currently installed version supports attaching to the main process after launch. A revocable model list hook has been tested in practice,
including native menu updates, normal revocation, automatic revocation after the controller disconnects, and uninterrupted running of an existing GPT task.
A menu bar toggle can be designed on this basis. Full Claude routing is not yet wired into this prototype.

## Verification scope and results

The test used an independent APFS copy of the official Codex App, keeping the official signature. The test instance used its own `CODEX_HOME`,
SQLite, and Electron/Chromium profile. No shim was set at launch and no inspector arguments were passed.
The research script still launched the test instance, but the launch arguments only isolated the data directories. The attach entry point was established after launch.

| Check | Observed result |
| --- | --- |
| Activate the debug entry after a stock launch | `SIGUSR1` opens the main process inspector, `execArgv` is `[]` |
| Existing backend connection | Official `codex` PID `81854`, stdio connection |
| Add a model list entry | The native list gains `Hook Probe (temporary)`, no on-disk config changes |
| Update the UI without a reload | Only invalidates `['models', 'list', 'local']`, window navigation count is 0 |
| Explicit revocation | Original method descriptor restored, timer and global hook handle deleted, menu item disappears |
| Running GPT task | `inProgress` during both attach and revocation, then completed with continuous output 1–100 |
| Process continuity | Desktop `81817`, backend `81854`, and renderer `81859` all unchanged throughout the successful cycle |
| Controller lost | The lease is no longer renewed. After 3 seconds the main process automatically restores the method and model cache, and the menu item disappears |
| Reattach | After the inspector was closed, a new controller reactivated it and attached successfully |
| Original App integrity | The `app.asar` hashes of the original Codex App and the test copy match, and both pass codesign verification |

The 7 official model entries (including hidden ones) became 8. The 5 user-visible entries became 6.
The test entry only verifies the catalog and the UI. It provides no inference service, and it was not selected to start a task.

The `app.asar` SHA-256 checked so far:

```text
1f7939c1c781887c167043c4d1d307af3400d324685cfc315dfe2f80e634f483
```

The stable instance, PID `57509` with launch time `2026-09-22 15:24:57`, remained unchanged.
During early exploration, the test renderer was reloaded to obtain a test connection object. The final hook installation does not depend on that object.
The successful attach/revoke cycle separately recorded zero navigations and covered a real running task.

## Attach point

The existing launcher points `CODEX_CLI_PATH` at the shim. The shim sets up the Host communication chain and then `exec`s
the official CLI, which preserves the signed Desktop → official CLI process relationship.
The Host sits on the stdio between Desktop and the backend, and its current exit logic shuts down the backend. The launcher also
closes Desktop when the controller exits. This lifecycle cannot be used directly for a hot exit.

The hot-attach prototype uses the connection class that already exists in the main process. Among the exports of `.vite/build/src-*.js` in the module cache,
it locates the connection class by the shape of its methods `routeResponse`, `listModels`, and `getPendingRequestCount`,
without relying on minified class names or export aliases. It installs a restorable prototype wrapper on that class's `routeResponse`:

1. Only handle the `local` host.
2. Read the method that a response belongs to from Desktop's existing pending-request table.
3. Append the test entry only to successful `model/list` responses, copying the object and leaving the original response intact.
4. Pass all other messages straight to the original method.
5. On explicit revocation or lease expiry, restore the full property descriptor.
6. If another component replaced the method in the meantime, do not overwrite its implementation. Disable this layer's rewrite and report that restoration was incomplete.

The model list is cached in the renderer. The prototype reads the query client from the mounted React provider
and refreshes only the local model list. It does not rewrite renderer functions, the DOM, or React state.
This still depends on internal implementation details and needs maintenance for each Desktop version.

The main process holds a short lease. The controller renews it periodically. When the controller disappears, the main process's own timer restores
the method and calls the cache cleanup callback installed in advance. This way, exit recovery does not depend on the controller still being alive.

## Reproduction

Three source files and unit tests:

- `tools/probes/desktop-hot-attach.mjs`: a controller restricted to the isolated test instance. It verifies the PID/launch time,
  the private data directory, the absence of the shim, and the app archive hash, and refuses to act on any other process.
- `tools/probes/desktop-model-hook.mjs`: the hook and lease, serializable into the main process.
- `tools/probes/desktop-model-refresh.mjs`: a targeted cache refresh, serializable into the renderer.
- `tools/probes/desktop-model-hook.test.mjs`: 8 tests covering no rewriting of other routes, preservation of the original object,
  renderer/internal requests, descriptor restoration, the lease, a wrapper installed later, structural changes, and cleanup failure.

Run from the repository root:

```sh
npx vitest run --config tests/vitest.config.js tools/probes/desktop-model-hook.test.mjs
node tools/probes/desktop-hot-attach.mjs start
node tools/probes/desktop-hot-attach.mjs attach
```

Wait for the isolated window to finish launching before running `attach`. The controller keeps running and renews the lease every 1.5 seconds.
`Ctrl-C` revokes. If the controller is killed outright, revocation happens when the 5-second lease expires.
Open the native model picker to see the test entry. Do not select it to run a task.

```sh
node tools/probes/desktop-hot-attach.mjs status
node tools/probes/desktop-hot-attach.mjs detach
node tools/probes/desktop-hot-attach.mjs close-inspector
node tools/probes/desktop-hot-attach.mjs stop
```

`close-inspector` requires the hook to be revoked first. `stop` only quits the recorded test instance.
When the inspector is closed, `status` reports it as closed and does not reactivate it just to run the query.

The artifacts from this round's full test run are on this machine under `.codexhost/hot-attach-research/` and are not tracked in Git:

- `cycle-report.json`: evidence for the real GPT turn, attach/revoke, PIDs, prototype restoration, and navigation.
- `lost-controller-report.json`: recovery results after the controller disconnected.
- `inspector-close-report.json` / `cleanup-report.json`: debug port closure, test process cleanup, and stable instance continuity.
- `verified-attached.png` / `verified-detached.png`: screenshots of the real model menu, expanded.
- `make-cycle.mjs` / `cycle.js`: this round's continuous-task experiment against the captured test connection.

## Failure paths avoided

The first attempt used `Runtime.queryObjects` to find the connection instance, and the test instance PID `79876` crashed.
The system reported `EXC_BAD_ACCESS / SIGBUS`, with `v8::HeapProfiler::QueryObjects` in the stack.
System report: `~/Library/Logs/DiagnosticReports/ChatGPT-2026-09-22-154719.ips`.
The stable instance was unaffected. The final approach installs the hook through the exported prototype and no longer scans heap objects.
After the experiment, the isolated App and the three helper processes left over from the first crash were cleaned up by exact process identity,
debug port 9229 was closed, and the stable instance kept its original PID and launch time.

Checking `document.body.innerText` alone is not enough to confirm the menu's visual state. This version keeps the model text
in the model menu even when it is collapsed. The final screenshots were taken after expanding the menu with real pointer events and were checked visually by hand.

## Recommended design for the full product

We recommend a small menu bar helper with three entry points: Attach / Detach / Status. The user launches the official Codex App normally.
The helper identifies the version and the exact process identity, then attaches. Turning the toggle off restores the original behavior.
It does not modify the `.app`, does not re-sign, does not set a global `launchctl` environment, and does not take over launching the Codex App.

The protocol layer should be split into three components:

```text
Native Desktop connection
    ↕ minimal version adaptation and revocable hook
Local private IPC
    ↕
Claude protocol service (reuses the existing adapter / projector / thread store)
```

The attach and exit states should be `off → attaching → active → draining → off`.
After entering draining, new Claude requests are rejected, and running Claude tasks are either waited on or stopped, as the user chooses.
Then routing is revoked, temporary catalog entries and caches are cleared, and any inspector that we opened is closed.
Existing GPT tasks keep running over the official connection.

Next steps to verify and implement:

1. **Bidirectional Claude routing.** Attach a sidecar at the send/response dispatch boundary of the existing connection, handling request ID
   correlation, streaming notifications, approval callbacks, and disconnects. Keep the official pending requests intact and avoid a duplicate initialize.
   This round only verified response rewriting. It does not mean these features are implemented.
2. **Splitting the Host lifecycle.** The existing `AppServerHost` assumes it owns the transport/backend. The external model
   protocol service needs to be separated from the creation, initialization, and shutdown of the official backend.
3. **Native tool ownership.** The original official backend and the signed parent-child relationship are naturally preserved. The task ownership,
   turn metadata, and event attribution that Claude needs to call `codex_app` and `cua_repl` still need to be re-verified end to end.
4. **Wrapping up Claude state.** An active Claude session must not silently switch to GPT on revocation. Keep the history and the state
   needed for recovery. On a sudden loss of connection, report an explicit error. Do not drop requests or falsely report completion.
5. **Usage display.** The existing HTTPS usage proxy depends on a certificate pin argument passed at launch. Hot attach needs separate verification
   of a targeted extension to existing network responses, or the first version ships without the usage extension.
6. **Versions and permissions.** Testing only covered this build. New versions need their structure, signature, and inspector switch rechecked.
   Unrecognized versions keep the stock behavior. The inspector binds only to loopback. We record whether we opened it, and hand it back on exit.

The stable App still goes through the old launcher chain. A future migration to hot-attach mode first requires exiting the old chain and launching
the Codex App normally once. After that, toggling without a restart each time can be explored. The stable instance was not migrated this time.

References: [Electron fuses](https://www.electronjs.org/docs/latest/tutorial/fuses),
[Debugging the main process](https://www.electronjs.org/docs/latest/tutorial/debugging-main-process).
The feasibility assessment is based on tests of a local copy of the original Codex App. This is not a plugin interface that is officially promised to be stable.
