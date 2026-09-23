import { describe, expect, it } from "vitest";

import { storedThreadRecordV1Schema } from "../src/index.js";

describe("Thread records stored before the rename", () => {
  it("reads legacy route ids as current ones", () => {
    const shape = storedThreadRecordV1Schema.safeParse({ transportModelId: "codexhost/pi-native" });
    const issues = shape.success ? [] : shape.error.issues.map((issue) => issue.path.join("."));
    // The legacy value itself is valid; only the other required fields are missing here.
    expect(issues).not.toContain("transportModelId");
    const transportModelId = storedThreadRecordV1Schema.shape.transportModelId.parse(
      "codexhost/claude-code-native@claude-model-v1.b3B1cw",
    );
    expect(transportModelId).toBe("claude-in-codex/claude-code-native@claude-model-v1.b3B1cw");
  });
});
