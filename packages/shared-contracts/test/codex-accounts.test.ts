import { describe, expect, it } from "vitest";

import { codexAccountListResultSchema, codexAccountUsageResultSchema } from "../src/index.js";

const baseSnapshot = {
  version: 2 as const,
  currentAccountId: "account-a",
  phase: "ready" as const,
  revision: 7,
  accounts: [{ accountId: "account-a", label: "Account A", email: "a@example.com" }],
};

describe("Codex Account contracts", () => {
  it("keeps a current-only snapshot and excludes credential locations", () => {
    expect(codexAccountListResultSchema.parse(baseSnapshot)).toEqual(baseSnapshot);
    expect(() =>
      codexAccountListResultSchema.parse({
        ...baseSnapshot,
        accounts: [{ ...baseSnapshot.accounts[0], codexHome: "/private/home" }],
      }),
    ).toThrow();
  });

  it("requires quota freshness and observation time", () => {
    expect(
      codexAccountUsageResultSchema.parse({
        accountId: "account-a",
        usage: null,
        freshness: "cached",
        observedAt: "2026-09-11T00:00:00.000Z",
      }),
    ).toMatchObject({ freshness: "cached" });
  });
});
