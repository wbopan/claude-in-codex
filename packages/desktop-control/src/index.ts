import { WORKSPACE_CONTRACT_VERSION } from "@claude-in-codex/shared-contracts";

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

export const packageMetadata = {
  name: "@claude-in-codex/desktop-control",
  contractVersion: WORKSPACE_CONTRACT_VERSION,
} as const;
