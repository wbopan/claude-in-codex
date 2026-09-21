import { describe, expect, it } from "vitest";
import { debugEnvironment } from "./debug.mjs";

describe("independent debug environment", () => {
  it("leaves native App Tools on by default and forwards only the explicit opt-out", () => {
    expect(debugEnvironment({}, "/private/debug").CODEXHOST_NATIVE_APP_TOOLS).toBeUndefined();
    expect(
      debugEnvironment({ CODEXHOST_NATIVE_APP_TOOLS: "1" }, "/private/debug")
        .CODEXHOST_NATIVE_APP_TOOLS,
    ).toBeUndefined();
    expect(
      debugEnvironment({ CODEXHOST_NATIVE_APP_TOOLS: "0" }, "/private/debug")
        .CODEXHOST_NATIVE_APP_TOOLS,
    ).toBe("0");
  });
  it("removes inherited task identity and state while retaining the real user home", () => {
    const env = debugEnvironment(
      {
        HOME: "/Users/example",
        PATH: "/usr/bin",
        CODEX_HOME: "/Users/example/.codex",
        CODEX_SQLITE_HOME: "/shared/database",
        CODEXHOST_RUNTIME_TOKEN: "stable-token",
        CODEXHOST_REMOTE_SSH_MANAGED: "1",
        CODEXHOST_HOST_RUNTIME_PATH: "/stable/host-runtime.mjs",
        CODEXHOST_PLUGIN_DIRECTORY: "/stable/plugins",
        CLAUDE_CODE_SESSION_ID: "stable-session",
        CLAUDE_CONFIG_DIR: "/Users/example/.claude",
        ELECTRON_RUN_AS_NODE: "1",
        NODE_OPTIONS: "--inspect=9229",
      },
      "/private/debug",
    );
    expect(env.HOME).toBe("/Users/example");
    expect(env.CODEX_HOME).toBe("/private/debug/codex");
    expect(env.CODEX_SQLITE_HOME).toBe(env.CODEX_HOME);
    expect(env.CLAUDE_CONFIG_DIR).toBe("/private/debug/claude");
    expect(env.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe("");
    expect(env.CODEXHOST_HARNESS_BROKER_DIR).toBe("/private/debug/broker");
    for (const name of [
      "CODEXHOST_RUNTIME_TOKEN",
      "CODEXHOST_REMOTE_SSH_MANAGED",
      "CODEXHOST_HOST_RUNTIME_PATH",
      "CODEXHOST_PLUGIN_DIRECTORY",
      "CLAUDE_CODE_SESSION_ID",
      "ELECTRON_RUN_AS_NODE",
      "NODE_OPTIONS",
    ]) {
      expect(env).not.toHaveProperty(name);
    }
  });

  it.each(["", "/Users/example/custom auth"])(
    "preserves the explicit credential store %j while isolating Claude state",
    (credentialStore) => {
      const env = debugEnvironment(
        { CLAUDE_SECURESTORAGE_CONFIG_DIR: credentialStore },
        "/private/debug",
      );
      expect(env.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe(credentialStore);
      expect(env.CLAUDE_CONFIG_DIR).toBe("/private/debug/claude");
    },
  );
});
