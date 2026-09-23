import { lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { logDirectory, platformDataDirectory } from "@claude-in-codex/shared-contracts/app-paths";
import { beforeEach, describe, expect, it } from "vitest";

import { tempDir } from "../../../tests/helpers/temp-dir.js";
import { migrateLegacyDataDirectory } from "../src/hot-attach/legacy-data.js";

let home: string;
beforeEach(async () => {
  home = await tempDir("claude-in-codex-legacy-data-");
});

async function legacyFile(relative: string, contents = "{}\n"): Promise<void> {
  const file = path.join(home, ".codexhost", relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, contents, "utf8");
}

describe("data left in ~/.codexhost by the pre-rename App", () => {
  it("moves Host data and logs, drops launcher leftovers and keeps Remote installs", async () => {
    const environment = { HOME: home };
    await legacyFile("mapping-store/threads/a.json");
    await legacyFile("mapping-store/store.lock", JSON.stringify({ pid: 2_147_483_000 }));
    await legacyFile("native-picker-selection.json");
    await legacyFile("logs/menubar.log", "old log\n");
    await legacyFile("desktop-proxy/key.pem");
    await legacyFile("remote/manifest.json");

    const result = await migrateLegacyDataDirectory(environment);

    const target = platformDataDirectory(environment);
    expect(result?.moved.sort()).toEqual(["logs", "mapping-store", "native-picker-selection.json"]);
    expect(result?.kept).toEqual(["remote"]);
    await expect(readdir(path.join(target, "mapping-store", "threads"))).resolves.toEqual([
      "a.json",
    ]);
    await expect(
      readFile(path.join(logDirectory(environment), "codexhost-menubar.log"), "utf8"),
    ).resolves.toBe("old log\n");
    expect(await readdir(path.join(home, ".codexhost"))).toEqual(["remote"]);
  });

  it("removes ~/.codexhost once everything has moved and never overwrites newer data", async () => {
    const environment = { HOME: home };
    await legacyFile("native-picker-selection.json", "legacy\n");
    await mkdir(platformDataDirectory(environment), { recursive: true });
    await writeFile(
      path.join(platformDataDirectory(environment), "native-picker-selection.json"),
      "current\n",
    );
    const result = await migrateLegacyDataDirectory(environment);
    expect(result).toEqual({ moved: [], kept: ["native-picker-selection.json"] });
    await expect(
      readFile(
        path.join(platformDataDirectory(environment), "native-picker-selection.json"),
        "utf8",
      ),
    ).resolves.toBe("current\n");

    await rm(path.join(home, ".codexhost", "native-picker-selection.json"));
    await legacyFile("plugins/enabled.json");
    await migrateLegacyDataDirectory(environment);
    await expect(lstat(path.join(home, ".codexhost"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses while a legacy Host still owns the Mapping Store", async () => {
    await legacyFile(
      "mapping-store/store.lock",
      JSON.stringify({ pid: process.pid, executablePath: process.execPath }),
    );
    await expect(migrateLegacyDataDirectory({ HOME: home })).rejects.toThrow(
      "previous Codex Host is still running",
    );
    await expect(lstat(path.join(home, ".codexhost", "mapping-store"))).resolves.toBeTruthy();
  });

  it("does nothing without ~/.codexhost", async () => {
    await expect(migrateLegacyDataDirectory({ HOME: home })).resolves.toBeNull();
  });
});
