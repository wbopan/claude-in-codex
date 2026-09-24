import { execFileSync, spawnSync } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { notarize } from "./release.mjs";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn(), spawnSync: vi.fn() }));

describe("App and DMG notarization", () => {
  beforeEach(() => {
    vi.mocked(execFileSync).mockReset();
    vi.mocked(spawnSync)
      .mockReset()
      .mockReturnValue({
        status: 0,
        stdout: JSON.stringify({ id: "submission-id", status: "Accepted" }),
        stderr: "",
      });
  });

  it("uploads an App as ZIP but staples and assesses the App itself", async () => {
    await notarize("/build/Claude in Codex.app", "/scratch");
    expect(execFileSync).toHaveBeenCalledWith(
      "/usr/bin/ditto",
      [
        "-c",
        "-k",
        "--sequesterRsrc",
        "--keepParent",
        "/build/Claude in Codex.app",
        "/scratch/notarize.zip",
      ],
      expect.anything(),
    );
    expect(execFileSync).toHaveBeenCalledWith(
      "/usr/bin/xcrun",
      ["stapler", "staple", "/build/Claude in Codex.app"],
      expect.anything(),
    );
    expect(execFileSync).toHaveBeenCalledWith(
      "/usr/sbin/spctl",
      ["--assess", "--type", "execute", "--verbose=2", "/build/Claude in Codex.app"],
      expect.anything(),
    );
  });

  it("submits the signed DMG directly and assesses its primary signature after stapling", async () => {
    await notarize("/build/installer.dmg", "/scratch");
    expect(spawnSync).toHaveBeenCalledWith(
      "/usr/bin/xcrun",
      expect.arrayContaining(["notarytool", "submit", "/build/installer.dmg", "--wait"]),
      expect.anything(),
    );
    expect(execFileSync).not.toHaveBeenCalledWith(
      "/usr/bin/ditto",
      expect.anything(),
      expect.anything(),
    );
    expect(execFileSync).toHaveBeenCalledWith(
      "/usr/bin/xcrun",
      ["stapler", "staple", "/build/installer.dmg"],
      expect.anything(),
    );
    expect(execFileSync).toHaveBeenCalledWith(
      "/usr/bin/xcrun",
      ["stapler", "validate", "/build/installer.dmg"],
      expect.anything(),
    );
    expect(execFileSync).toHaveBeenCalledWith(
      "/usr/sbin/spctl",
      [
        "--assess",
        "--type",
        "open",
        "--context",
        "context:primary-signature",
        "--verbose=2",
        "/build/installer.dmg",
      ],
      expect.anything(),
    );
  });

  it("stops before stapling or publication when Apple rejects the DMG", async () => {
    vi.mocked(spawnSync).mockReturnValueOnce({
      status: 0,
      stdout: JSON.stringify({ id: "rejected-id", status: "Invalid" }),
      stderr: "",
    });
    await expect(notarize("/build/installer.dmg", "/scratch")).rejects.toThrow(
      "Notarization Invalid",
    );
    expect(spawnSync).toHaveBeenCalledWith(
      "/usr/bin/xcrun",
      expect.arrayContaining(["notarytool", "log", "rejected-id"]),
      expect.anything(),
    );
    expect(execFileSync).not.toHaveBeenCalled();
  });
});
