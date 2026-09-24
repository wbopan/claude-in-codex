import { WORKSPACE_CONTRACT_VERSION } from "@claude-in-codex/shared-contracts";

export { CdpClient } from "./cdp-client.js";
export type { CdpClientOptions, CdpEventListener, CdpSocketFactory } from "./cdp-client.js";

export const packageMetadata = {
  name: "@claude-in-codex/desktop-control",
  contractVersion: WORKSPACE_CONTRACT_VERSION,
} as const;
