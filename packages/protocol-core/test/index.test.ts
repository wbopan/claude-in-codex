import { describe, expect, it } from "vitest";
import { packageMetadata } from "../src/index.js";

describe("protocol-core package", () => {
  it("declares only public Workspace dependencies", () => {
    expect(packageMetadata.dependencies).toEqual([
      "@claude-in-codex/harness-adapter",
      "@claude-in-codex/mapping-store",
    ]);
  });
});
