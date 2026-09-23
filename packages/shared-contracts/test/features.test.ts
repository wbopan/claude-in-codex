import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_FEATURE_SETTINGS,
  featureSettingsSchema,
  resolveFeatures,
} from "../src/features.js";
import {
  featureEnabled,
  featuresFilePath,
  readFeatureSettings,
  readFeatureSettingsSync,
  readFeatures,
  readIdleReleaseSettings,
  readMemorySyncResult,
  writeFeatureSetting,
  writeIdleReleaseMinutes,
  writeMemorySyncResult,
} from "../src/features-file.js";
import { tempDir } from "../../../tests/helpers/temp-dir.js";

let directory: string;
let environment: NodeJS.ProcessEnv;
beforeEach(async () => {
  directory = await tempDir("claude-in-codex-features-");
  environment = { CLAUDE_IN_CODEX_DATA_DIR: path.join(directory, "data") };
});

describe("feature settings", () => {
  it("fills missing or malformed keys with their defaults", () => {
    expect(featureSettingsSchema.parse({})).toEqual(DEFAULT_FEATURE_SETTINGS);
    expect(featureSettingsSchema.parse(null)).toEqual(DEFAULT_FEATURE_SETTINGS);
    expect(
      featureSettingsSchema.parse({ version: 2, codexMemory: false, idleRelease: "yes", extra: 1 }),
    ).toEqual({ ...DEFAULT_FEATURE_SETTINGS, codexMemory: false });
  });

  it("reads defaults from a missing or corrupt file", async () => {
    await expect(readFeatureSettings(environment)).resolves.toEqual(DEFAULT_FEATURE_SETTINGS);
    await mkdir(path.dirname(featuresFilePath(environment)), { recursive: true });
    await writeFile(featuresFilePath(environment), "{not json");
    await expect(readFeatureSettings(environment)).resolves.toEqual(DEFAULT_FEATURE_SETTINGS);
    expect(readFeatureSettingsSync(environment)).toEqual(DEFAULT_FEATURE_SETTINGS);
  });

  it("writes one switch atomically and keeps the others", async () => {
    await writeFeatureSetting("idleRelease", true, environment);
    await writeFeatureSetting("computerUse", false, environment);
    expect(JSON.parse(await readFile(featuresFilePath(environment), "utf8"))).toEqual({
      ...DEFAULT_FEATURE_SETTINGS,
      idleRelease: true,
      computerUse: false,
    });
    expect(await readdir(path.dirname(featuresFilePath(environment)))).toEqual(["features.json"]);
    await expect(featureEnabled("idleRelease", environment)).resolves.toBe(true);
    await expect(featureEnabled("computerUse", environment)).resolves.toBe(false);
  });

  it("writes the idle release choice as the switch and its timeout", async () => {
    await writeIdleReleaseMinutes(15, environment);
    await expect(readIdleReleaseSettings(environment)).resolves.toEqual({
      enabled: true,
      timeoutMinutes: 15,
    });
    await writeIdleReleaseMinutes(0, environment);
    await expect(readIdleReleaseSettings(environment)).resolves.toEqual({
      enabled: false,
      timeoutMinutes: 15,
    });
    expect(featureSettingsSchema.parse({ idleReleaseTimeoutMinutes: 3 })).toMatchObject({
      idleReleaseTimeoutMinutes: 30,
    });
  });

  it("resolves every feature from the file alone, in the status order", () => {
    expect(resolveFeatures({ ...DEFAULT_FEATURE_SETTINGS, codexMemory: false })).toEqual([
      { id: "codexAppTools", enabled: true },
      { id: "computerUse", enabled: true },
      { id: "codexMemory", enabled: false },
      { id: "claudeMemorySync", enabled: true },
      { id: "idleRelease", enabled: false },
    ]);
  });

  it("reports the stored switches through readFeatures", async () => {
    await writeFeatureSetting("claudeMemorySync", false, environment);
    expect(
      (await readFeatures(environment)).filter((state) => !state.enabled).map((state) => state.id),
    ).toEqual(["claudeMemorySync", "idleRelease"]);
  });

  it("round-trips the last memory sync result", async () => {
    await expect(readMemorySyncResult(environment)).resolves.toBeNull();
    const result = { at: "2026-09-23T00:00:00.000Z", written: 2, removed: 1, error: null };
    await writeMemorySyncResult(result, environment);
    await expect(readMemorySyncResult(environment)).resolves.toEqual(result);
  });
});
