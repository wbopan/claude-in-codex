import { describe, expect, it } from "vitest";

import {
  createRemoteOfficialAppServerPlan,
  MANAGED_REMOTE_APP_SERVER_PROCESS_TITLE,
} from "../src/run-host-runtime.js";

describe("Host Runtime composition", () => {
  it("keeps the managed listener outside the official Desktop bootstrap kill selector", () => {
    const officialDesktopBootstrapKillSelector = /codex.*desktop-ssh-websocket-v0\.sock/;

    expect(MANAGED_REMOTE_APP_SERVER_PROCESS_TITLE).not.toMatch(
      officialDesktopBootstrapKillSelector,
    );
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
