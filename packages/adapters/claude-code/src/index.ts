import { packageMetadata as harnessAdapter } from "@claude-in-codex/harness-adapter";
import { WORKSPACE_CONTRACT_VERSION } from "@claude-in-codex/shared-contracts";

export { ClaudeCodeAdapter } from "./claude-code-adapter.js";
export type { ClaudeCodeAdapterOptions } from "./claude-code-adapter.js";

export const packageMetadata = {
  name: "@claude-in-codex/adapter-claude-code",
  contractVersion: WORKSPACE_CONTRACT_VERSION,
  adapterContract: harnessAdapter.name,
} as const;
