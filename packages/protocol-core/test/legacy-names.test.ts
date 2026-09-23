import type { JsonRpcRequest } from "@claude-in-codex/shared-contracts";
import { describe, expect, it } from "vitest";

import {
  CLAUDE_CODE_NATIVE_TRANSPORT_MODEL_ID,
  decodeClaudeTransportSelection,
  decodeCreateRoute,
  decodeThreadListRequest,
  encodeHostThreadListCursor,
} from "../src/index.js";

const legacyClaudeRoute = "codexhost/claude-code-native@claude-model-v1.default@acceptEdits";

describe("identifiers issued before the rename", () => {
  it("routes a legacy Claude Model id and stores the current one", () => {
    const request: JsonRpcRequest = {
      id: 1,
      method: "thread/start",
      params: { model: legacyClaudeRoute },
    };
    expect(decodeCreateRoute(request)).toMatchObject({
      harnessId: "claude-code",
      routeMode: "native",
      transportModelId: `${CLAUDE_CODE_NATIVE_TRANSPORT_MODEL_ID}@claude-model-v1.default@acceptEdits`,
      permissionModeId: "acceptEdits",
    });
    expect(decodeClaudeTransportSelection("codexhost/claude-code-native")).toEqual({});
  });

  it("resumes a thread/list page from a legacy Host cursor", () => {
    const query = { id: 1, method: "thread/list", params: { archived: false } };
    const first = decodeThreadListRequest(query);
    if (!first) throw new Error("Expected thread/list decoding");
    const cursor = encodeHostThreadListCursor({
      queryFingerprint: first.queryFingerprint,
      sortDirection: first.sortDirection,
      officialCursor: "official-next",
      officialDone: false,
      externalAnchor: null,
      externalDone: true,
    }).replace("claude-in-codex:", "codexhost:");
    const next = decodeThreadListRequest({ ...query, params: { archived: false, cursor } });
    expect(next).toMatchObject({
      supportsExternal: true,
      cursor: { officialCursor: "official-next" },
    });
  });
});
