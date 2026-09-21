import { WORKSPACE_CONTRACT_VERSION } from "@codexhost/shared-contracts";

export {
  CdpClient,
  getCdpBrowserVersion,
  listCdpTargets,
  waitForRendererTarget,
} from "./cdp-client.js";
export type {
  CdpBrowserVersion,
  CdpClientOptions,
  CdpEventListener,
  CdpFetch,
  CdpFetchResponse,
  CdpSocketFactory,
  CdpTarget,
} from "./cdp-client.js";

export {
  parseDesktopControllerArguments,
  runDesktopController,
  serializeDesktopControllerReadiness,
} from "./production-controller.js";
export type {
  DesktopControllerDependencies,
  DesktopControllerOptions,
  DesktopControllerReadiness,
} from "./production-controller.js";

export const packageMetadata = {
  name: "@codexhost/desktop-control",
  contractVersion: WORKSPACE_CONTRACT_VERSION,
} as const;
