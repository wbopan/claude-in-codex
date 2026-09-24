import { packageMetadata as desktopControl } from "@claude-in-codex/desktop-control";
import { packageMetadata as harnessAdapter } from "@claude-in-codex/harness-adapter";
import { packageMetadata as harnessBroker } from "@claude-in-codex/harness-broker";
import { packageMetadata as mappingStore } from "@claude-in-codex/mapping-store";
import { packageMetadata as protocolCore } from "@claude-in-codex/protocol-core";
import { packageMetadata as sharedContracts } from "@claude-in-codex/shared-contracts";

export { loadHarnessPlugins } from "./harness-plugin-loader.js";
export type {
  LoadHarnessPluginsOptions,
  HarnessPluginDiagnostic,
} from "./harness-plugin-loader.js";
export { HarnessPluginRegistry } from "./harness-plugin-registry.js";
export { installedHarnessPluginOptions } from "./installed-harness-plugins.js";
export {
  AppServerHost,
  classifyCreateRequestRoute,
  officialEnvironment,
} from "./app-server-host.js";
export type { AppServerHostOptions } from "./app-server-host.js";
export {
  DESKTOP_PROFILE_SUBTEXT,
  DesktopProfileSubtextPublisher,
  withProfileSubtext,
} from "./desktop-profile-subtext.js";
export type { CodexAccountControl } from "./account/codex-account-control.js";
export { OfficialRuntimeScope } from "./codex-runtime/official-runtime-scope.js";
export { CodexRuntime } from "./codex-runtime/codex-runtime.js";
export {
  createRemoteAppServerWebSocketListener,
  isRemoteUnixListenerInvocation,
  remoteAppServerSocketPath,
  remoteUnixListenerUrl,
} from "./remote-app-server.js";
export type {
  RemoteAppServerSession,
  RemoteAppServerSessionStreams,
  RemoteAppServerWebSocketListener,
} from "./remote-app-server.js";
export { runHostRuntime } from "./run-host-runtime.js";
export { runClaudeAquaHarnessBroker } from "./aqua-harness-broker.js";
export { runRemoteHostCli } from "./remote-host-cli.js";
export {
  inspectRemoteHostInstallation,
  installRemoteHost,
  uninstallRemoteHost,
} from "./remote-host-install.js";
export type {
  RemoteHostInstallationStatus,
  RemoteHostInstallOptions,
  RemoteHostManifestV1,
} from "./remote-host-install.js";
export {
  classifyRemoteHostProbeResponse,
  inspectRemoteHost,
  startRemoteHost,
  stopRemoteHost,
} from "./remote-host-lifecycle.js";
export type {
  RemoteHostLifecycleResult,
  RemoteHostRuntimeStatus,
  RemoteHostStatus,
} from "./remote-host-lifecycle.js";
export { classifyThreadPurpose, RequestRouteObservationTracker } from "./route-observation.js";
export type {
  CreateRequestRouteObservation,
  RequestRouteObservation,
  ThreadPurpose,
  TrackedCreateRouteObservation,
  TurnRequestRouteObservation,
} from "./route-observation.js";
export const packageMetadata = {
  name: "@claude-in-codex/host-runtime",
  dependencies: [
    protocolCore.name,
    desktopControl.name,
    harnessAdapter.name,
    harnessBroker.name,
    mappingStore.name,
    sharedContracts.name,
  ],
} as const;
