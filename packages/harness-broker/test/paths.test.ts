import { describe, expect, it } from "vitest";
import {
  defaultHarnessBrokerDescriptorPath,
  defaultHarnessBrokerSocketPath,
} from "../src/paths.js";

describe("instance broker paths", () => {
  it("isolates every harness socket and descriptor together", () => {
    const environment = {
      HOME: "/Users/example",
      CODEXHOST_HARNESS_BROKER_DIR: "/private/debug/broker",
    };
    for (const id of ["claude-code", "codebuddy"]) {
      expect(defaultHarnessBrokerDescriptorPath(environment, id)).toBe(
        `/private/debug/broker/${id}-broker-v1.json`,
      );
      expect(defaultHarnessBrokerSocketPath(environment, id)).toBe(
        `/private/debug/broker/${id}-broker-v1.sock`,
      );
    }
    expect(defaultHarnessBrokerSocketPath({ HOME: "/Users/example" })).toBe(
      "/Users/example/.codexhost/harness-broker/claude-code-broker-v1.sock",
    );
    expect(() =>
      defaultHarnessBrokerSocketPath({ CODEXHOST_HARNESS_BROKER_DIR: "relative" }),
    ).toThrow("absolute");
  });
});
