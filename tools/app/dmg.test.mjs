import { execFileSync } from "node:child_process";
import { cpSync, readFileSync, readlinkSync, writeFileSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildDiskImage } from "./dmg.mjs";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));

describe("DMG packaging", () => {
  let directory, app, output, staged;
  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "dmg-test-"));
    app = path.join(directory, "Claude in Codex.app");
    output = path.join(directory, "output", "installer.dmg");
    staged = null;
    await mkdir(path.join(app, "Contents"), { recursive: true });
    await writeFile(path.join(app, "Contents", "ticket"), "stapled ticket");
    vi.mocked(execFileSync)
      .mockReset()
      .mockImplementation((command, args) => {
        if (command === "/usr/bin/ditto") cpSync(args[0], args[1], { recursive: true });
        if (command === "/usr/bin/hdiutil" && args[0] === "create") {
          const source = args[args.indexOf("-srcfolder") + 1];
          staged = {
            applications: readlinkSync(path.join(source, "Applications")),
            ticket: readFileSync(
              path.join(source, path.basename(app), "Contents", "ticket"),
              "utf8",
            ),
            files: readdirSync(source),
          };
          writeFileSync(args.at(-1), "writable disk image");
        }
        if (command === "/usr/bin/hdiutil" && args[0] === "convert") {
          writeFileSync(args.at(-1), "complete disk image");
        }
      });
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("packages the copied App and an Applications shortcut without modifying the source", async () => {
    await buildDiskImage({ app, output });
    expect(staged.applications).toBe("/Applications");
    expect(staged.ticket).toBe("stapled ticket");
    expect(staged.files).toEqual(["Applications", "Claude in Codex.app"]);
    expect(execFileSync).toHaveBeenCalledWith(
      expect.stringContaining("release/dmg-layout"),
      [expect.stringContaining("volume"), "Claude in Codex.app"],
      expect.anything(),
    );
    expect(await readFile(output, "utf8")).toBe("complete disk image");
    expect(await readdir(path.dirname(output))).toEqual(["installer.dmg"]);
    expect(await readdir(app)).toEqual(["Contents"]);
    expect(execFileSync).not.toHaveBeenCalledWith(
      "/usr/bin/codesign",
      expect.arrayContaining(["--sign"]),
      expect.anything(),
    );
  });

  it("signs and verifies release disk images with the supplied identity", async () => {
    await buildDiskImage({ app, output, signingIdentity: "developer-id-hash" });
    expect(execFileSync).toHaveBeenCalledWith(
      "/usr/bin/codesign",
      ["--timestamp", "--sign", "developer-id-hash", expect.stringContaining("installer.dmg")],
      expect.anything(),
    );
    expect(execFileSync).toHaveBeenCalledWith(
      "/usr/bin/codesign",
      ["--verify", "--strict", expect.stringContaining("installer.dmg")],
      expect.anything(),
    );
  });

  it("preserves the previous image and removes staging when verification fails", async () => {
    await mkdir(path.dirname(output));
    await writeFile(output, "previous disk image");
    const normal = vi.mocked(execFileSync).getMockImplementation();
    vi.mocked(execFileSync).mockImplementation((command, args) => {
      if (command === "/usr/bin/hdiutil" && args[0] === "verify") throw new Error("corrupt image");
      return normal(command, args);
    });
    await expect(buildDiskImage({ app, output })).rejects.toThrow("corrupt image");
    expect(await readFile(output, "utf8")).toBe("previous disk image");
    expect(await readdir(path.dirname(output))).toEqual(["installer.dmg"]);
  });

  it("detaches the writable volume if layout generation fails", async () => {
    const normal = vi.mocked(execFileSync).getMockImplementation();
    vi.mocked(execFileSync).mockImplementation((command, args) => {
      if (command.endsWith("release/dmg-layout")) throw new Error("layout failed");
      return normal(command, args);
    });
    await expect(buildDiskImage({ app, output })).rejects.toThrow("layout failed");
    expect(execFileSync).toHaveBeenCalledWith(
      "/usr/bin/hdiutil",
      ["detach", expect.stringContaining("volume")],
      expect.anything(),
    );
    expect(await readdir(path.dirname(output))).toEqual([]);
  });

  it("rejects a missing App before creating an image", async () => {
    await expect(
      buildDiskImage({ app: path.join(directory, "Missing.app"), output }),
    ).rejects.toThrow();
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it("retains staging if the volume cannot detach, without replacing the previous image", async () => {
    await mkdir(path.dirname(output));
    await writeFile(output, "previous disk image");
    const normal = vi.mocked(execFileSync).getMockImplementation();
    vi.mocked(execFileSync).mockImplementation((command, args) => {
      if (command === "/usr/bin/hdiutil" && args[0] === "detach") throw new Error("volume busy");
      return normal(command, args);
    });
    await expect(buildDiskImage({ app, output })).rejects.toThrow("volume busy");
    expect(await readFile(output, "utf8")).toBe("previous disk image");
    expect((await readdir(path.dirname(output))).some((name) => name.startsWith(".dmg-"))).toBe(
      true,
    );
  });
});
