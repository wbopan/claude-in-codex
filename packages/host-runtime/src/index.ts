import { packageMetadata as desktopControl } from "@codexhost/desktop-control";
import { packageMetadata as harnessAdapter } from "@codexhost/harness-adapter";
import { packageMetadata as harnessBroker } from "@codexhost/harness-broker";
import { packageMetadata as mappingStore } from "@codexhost/mapping-store";
import { packageMetadata as protocolCore } from "@codexhost/protocol-core";
import { packageMetadata as sharedContracts } from "@codexhost/shared-contracts";

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
export { startDesktopBackendProxy, spkiSha256Base64 } from "./desktop-backend-proxy.js";
export type { DesktopBackendProxy, DesktopBackendRewrite } from "./desktop-backend-proxy.js";
export {
  DesktopUsagePublisher,
  harnessUsageBuckets,
  harnessUsageRows,
} from "./desktop-usage-buckets.js";
export type { HarnessUsageReport } from "./desktop-usage-buckets.js";
export type { CodexAccountControl } from "./account/codex-account-control.js";
export { OfficialRuntimeScope } from "./codex-runtime/official-runtime-scope.js";
export { CodexRuntime } from "./codex-runtime/codex-runtime.js";
export {
  createRemoteAppServerWebSocketListener,
  isRemoteUnixListenerInvocation,
  remoteAppServerSocketPath,
  remoteUnixListenerUrl,
  stdioArgumentsForRemoteListener,
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
  name: "@codexhost/host-runtime",
  dependencies: [
    protocolCore.name,
    desktopControl.name,
    harnessAdapter.name,
    harnessBroker.name,
    mappingStore.name,
    sharedContracts.name,
  ],
} as const;
