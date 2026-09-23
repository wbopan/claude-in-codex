import { WORKSPACE_CONTRACT_VERSION } from "@claude-in-codex/shared-contracts";

export { MappingStore, MappingStoreError, mappingStoreOwnerIsLive } from "./mapping-store.js";
export type { MappingStoreErrorCode, MappingStoreOptions } from "./mapping-store.js";
export {
  delegationStatusSchema,
  storedDelegationRecordV1Schema,
  storedThreadRecordV1Schema,
  storedTurnMappingV1Schema,
} from "./records.js";
export type {
  CommitReadyThreadInput,
  CreateDelegationInput,
  CreateProvisionalThreadInput,
  DelegationStatus,
  FindRecentDelegationInput,
  RebindSubagentSessionInput,
  ReplaceReadySessionAfterLastTurnInput,
  ReplaceReadySessionInput,
  StoredDelegationRecordV1,
  StoredThreadRecordV1,
  StoredTurnMappingV1,
} from "./records.js";

export const packageMetadata = {
  name: "@claude-in-codex/mapping-store",
  contractVersion: WORKSPACE_CONTRACT_VERSION,
} as const;
