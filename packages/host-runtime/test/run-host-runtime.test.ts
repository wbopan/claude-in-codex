import { describe, expect, it } from "vitest";

import {
  createRemoteOfficialAppServerPlan,
  MANAGED_REMOTE_APP_SERVER_PROCESS_TITLE,
  runHostRuntime,
} from "../src/run-host-runtime.js";

describe("Host Runtime composition", () => {
  it("keeps the managed listener outside the official Desktop bootstrap kill selector", () => {
    const officialDesktopBootstrapKillSelector = /codex.*desktop-ssh-websocket-v0\.sock/;

    expect(MANAGED_REMOTE_APP_SERVER_PROCESS_TITLE).not.toMatch(
      officialDesktopBootstrapKillSelector,
    );
  });

  it("refuses every invocation other than the managed remote listener", async () => {
    const environment = {
      CLAUDE_IN_CODEX_STOCK_CODEX_PATH: "/opt/codex/bin/codex",
      CLAUDE_IN_CODEX_DEFAULT_AGENT: "codex",
    };
    for (const arguments_ of [["app-server"], ["app-server", "--stdio"], ["exec", "prompt"]]) {
      await expect(runHostRuntime({ arguments: arguments_, environment })).rejects.toThrow(
        "only the managed remote app-server listener",
      );
    }
  });

  it("shares one official listener across every remote Host session", () => {
    expect(
      createRemoteOfficialAppServerPlan(
        ["app-server", "--listen", "unix://", "--analytics-default-enabled"],
        "/Users/developer/.codex/app-server-control/app-server-control.sock",
        "fixture1234",
      ),
    ).toEqual({
      socketPath: "/Users/developer/.codex/app-server-control/.c-fixture1234.sock",
      listenerArguments: [
        "app-server",
        "--listen",
        "unix:///Users/developer/.codex/app-server-control/.c-fixture1234.sock",
        "--analytics-default-enabled",
      ],
    });
  });
});
