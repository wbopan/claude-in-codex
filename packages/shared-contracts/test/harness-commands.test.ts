import { describe, expect, it } from "vitest";

import {
  harnessCommandDescriptorSchema,
  threadCommandExecuteResultSchema,
} from "@claude-in-codex/shared-contracts";

describe("Harness Command runtime contracts", () => {
  it("round-trips a strict text command descriptor", () => {
    expect(
      harnessCommandDescriptorSchema.parse({
        id: "demo.echo",
        invocation: "/demo-echo",
        label: "Echo",
        argumentMode: "text",
      }),
    ).toEqual({
      id: "demo.echo",
      invocation: "/demo-echo",
      label: "Echo",
      argumentMode: "text",
    });
  });

  it("rejects command capability declarations", () => {
    expect(
      harnessCommandDescriptorSchema.safeParse({
        id: "demo.echo",
        invocation: "/demo-echo",
        label: "Echo",
        argumentMode: "text",
        acceptsImages: true,
      }).success,
    ).toBe(false);
  });

  it("keeps completion promises out of the RPC result", () => {
    expect(
      threadCommandExecuteResultSchema.safeParse({
        accepted: true,
        turnId: "turn-1",
        completion: Promise.resolve({ status: "succeeded" }),
      }).success,
    ).toBe(false);
  });
});
