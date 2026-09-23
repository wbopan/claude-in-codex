/// <reference types="node" />
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { dataDirectory } from "./app-paths.js";
import {
  DEFAULT_FEATURE_SETTINGS,
  FEATURES_FILE,
  MEMORY_SYNC_RESULT_FILE,
  featureSettingsSchema,
  idleReleaseSettings,
  memorySyncResultSchema,
  resolveFeatures,
  type FeatureId,
  type FeatureSettings,
  type FeatureState,
  type MemorySyncResult,
} from "./features.js";
import type { IdleReleaseSettings } from "./idle-release.js";

export function featuresFilePath(environment: NodeJS.ProcessEnv = process.env): string {
  return path.join(dataDirectory(environment), FEATURES_FILE);
}

export function memorySyncResultPath(environment: NodeJS.ProcessEnv = process.env): string {
  return path.join(dataDirectory(environment), MEMORY_SYNC_RESULT_FILE);
}

function parseSettings(text: string | undefined): FeatureSettings {
  if (text === undefined) return { ...DEFAULT_FEATURE_SETTINGS };
  try {
    return featureSettingsSchema.parse(JSON.parse(text));
  } catch {
    return { ...DEFAULT_FEATURE_SETTINGS };
  }
}

/** The file's values; a missing or unreadable file means every default. */
export async function readFeatureSettings(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<FeatureSettings> {
  return parseSettings(
    await readFile(featuresFilePath(environment), "utf8").catch(() => undefined),
  );
}

export function readFeatureSettingsSync(
  environment: NodeJS.ProcessEnv = process.env,
): FeatureSettings {
  let text: string | undefined;
  try {
    text = readFileSync(featuresFilePath(environment), "utf8");
  } catch {
    text = undefined;
  }
  return parseSettings(text);
}

export async function readFeatures(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<FeatureState[]> {
  return resolveFeatures(await readFeatureSettings(environment));
}

/** Read at the point of use, so a changed switch applies without a restart. */
export async function featureEnabled(
  id: FeatureId,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  return (await readFeatureSettings(environment))[id];
}

export async function readIdleReleaseSettings(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<IdleReleaseSettings> {
  return idleReleaseSettings(await readFeatureSettings(environment));
}

async function writeAtomically(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

/** Writes one switch into the file, keeping the others. */
export async function writeFeatureSetting(
  id: FeatureId,
  enabled: boolean,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<FeatureSettings> {
  const settings = { ...(await readFeatureSettings(environment)), [id]: enabled };
  await writeAtomically(featuresFilePath(environment), settings);
  return settings;
}

/**
 * Writes the idle release choice: 0 turns the switch off and keeps the stored timeout, any other
 * number of minutes turns it on with that timeout.
 */
export async function writeIdleReleaseMinutes(
  minutes: number,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<FeatureSettings> {
  const stored = await readFeatureSettings(environment);
  const settings =
    minutes === 0
      ? { ...stored, idleRelease: false }
      : { ...stored, idleRelease: true, idleReleaseTimeoutMinutes: minutes };
  await writeAtomically(featuresFilePath(environment), settings);
  return settings;
}

export async function readMemorySyncResult(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<MemorySyncResult | null> {
  try {
    return memorySyncResultSchema.parse(
      JSON.parse(await readFile(memorySyncResultPath(environment), "utf8")),
    );
  } catch {
    return null;
  }
}

export async function writeMemorySyncResult(
  result: MemorySyncResult,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  await writeAtomically(memorySyncResultPath(environment), memorySyncResultSchema.parse(result));
}
