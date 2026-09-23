import { describe, expect, it } from "vitest";

import {
  adoptLegacyEnvironment,
  decodeHarnessPluginRoute,
  encodeHarnessPluginRoute,
  isAppEnvironmentVariable,
  normalizeRouteId,
} from "../src/index.js";
import {
  dataDirectory,
  legacyDataDirectory,
  logDirectory,
  platformDataDirectory,
} from "../src/app-paths.js";

describe("names kept from before the rename", () => {
  it("rewrites only legacy route ids", () => {
    expect(normalizeRouteId("codexhost/claude-code-native@claude-model-v1.b3B1cw")).toBe(
      "claude-in-codex/claude-code-native@claude-model-v1.b3B1cw",
    );
    expect(normalizeRouteId("claude-in-codex/claude-code-native")).toBe(
      "claude-in-codex/claude-code-native",
    );
    expect(normalizeRouteId("gpt-5.5")).toBe("gpt-5.5");
    expect(normalizeRouteId(null)).toBeNull();
  });

  it("decodes a plugin route stored under the legacy prefix", () => {
    const current = encodeHarnessPluginRoute({ harnessId: "sample-agent" });
    const legacy = current.replace("claude-in-codex/", "codexhost/");
    expect(decodeHarnessPluginRoute(legacy)).toEqual({ harnessId: "sample-agent" });
  });

  it("adopts legacy variables without overriding current ones", () => {
    const environment: Record<string, string | undefined> = {
      CODEXHOST_DATA_DIR: "/legacy",
      CODEXHOST_CLAUDE_COMMAND: "/legacy/claude",
      CLAUDE_IN_CODEX_CLAUDE_COMMAND: "/current/claude",
    };
    adoptLegacyEnvironment(environment);
    expect(environment.CLAUDE_IN_CODEX_DATA_DIR).toBe("/legacy");
    expect(environment.CLAUDE_IN_CODEX_CLAUDE_COMMAND).toBe("/current/claude");
    expect(isAppEnvironmentVariable("CODEXHOST_CONTROL_NONCE")).toBe(true);
    expect(isAppEnvironmentVariable("CLAUDE_IN_CODEX_DATA_DIR")).toBe(true);
    expect(isAppEnvironmentVariable("CLAUDE_CODE_ENTRYPOINT")).toBe(false);
  });
});

describe("per-user folders", () => {
  it("follows macOS conventions", () => {
    const environment = { HOME: "/Users/example" };
    expect(platformDataDirectory(environment, "darwin")).toBe(
      "/Users/example/Library/Application Support/Claude in Codex",
    );
    expect(logDirectory(environment, "darwin")).toBe("/Users/example/Library/Logs/Claude in Codex");
    expect(legacyDataDirectory(environment)).toBe("/Users/example/.codexhost");
  });

  it("follows the XDG base directories elsewhere", () => {
    expect(platformDataDirectory({ HOME: "/home/example" }, "linux")).toBe(
      "/home/example/.local/share/claude-in-codex",
    );
    expect(platformDataDirectory({ HOME: "/home/example", XDG_DATA_HOME: "/data" }, "linux")).toBe(
      "/data/claude-in-codex",
    );
    expect(logDirectory({ HOME: "/home/example" }, "linux")).toBe(
      "/home/example/.local/share/claude-in-codex/logs",
    );
  });

  it("prefers the current override, then the legacy one", () => {
    const home = { HOME: "/Users/example" };
    expect(dataDirectory({ ...home, CODEXHOST_DATA_DIR: "/legacy" }, "darwin")).toBe("/legacy");
    expect(
      dataDirectory(
        { ...home, CODEXHOST_DATA_DIR: "/legacy", CLAUDE_IN_CODEX_DATA_DIR: "/current" },
        "darwin",
      ),
    ).toBe("/current");
    expect(dataDirectory(home, "darwin")).toBe(platformDataDirectory(home, "darwin"));
  });
});
