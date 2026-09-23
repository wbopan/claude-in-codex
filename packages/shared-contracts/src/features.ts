import { z } from "zod";

import {
  DEFAULT_IDLE_RELEASE_SETTINGS,
  IDLE_RELEASE_TIMEOUT_MINUTES_MAX,
  IDLE_RELEASE_TIMEOUT_MINUTES_MIN,
  type IdleReleaseSettings,
} from "./idle-release.js";

/** The switchable features, in the order status surfaces list them. */
export const FEATURE_IDS = [
  "codexAppTools",
  "computerUse",
  "codexMemory",
  "claudeMemorySync",
  "idleRelease",
] as const;
export const featureIdSchema = z.enum(FEATURE_IDS);
export type FeatureId = z.infer<typeof featureIdSchema>;

/** `features.json` in the Host data folder. */
export const FEATURES_FILE = "features.json";
/**
 * Idle release is a switch plus the timeout it uses when on; the Dashboard shows the pair as one
 * choice, never or a number of minutes.
 */
export const DEFAULT_FEATURE_SETTINGS = Object.freeze({
  version: 1,
  codexAppTools: true,
  computerUse: true,
  codexMemory: true,
  claudeMemorySync: true,
  idleRelease: DEFAULT_IDLE_RELEASE_SETTINGS.enabled,
  idleReleaseTimeoutMinutes: DEFAULT_IDLE_RELEASE_SETTINGS.timeoutMinutes,
} as const);

/** A missing or malformed key falls back to its default; other keys keep their values. */
export const featureSettingsSchema = z
  .object({
    version: z.literal(1).catch(1),
    ...(Object.fromEntries(
      FEATURE_IDS.map((id) => [id, z.boolean().catch(DEFAULT_FEATURE_SETTINGS[id])]),
    ) as Record<FeatureId, z.ZodCatch<z.ZodBoolean>>),
    idleReleaseTimeoutMinutes: z
      .number()
      .int()
      .min(IDLE_RELEASE_TIMEOUT_MINUTES_MIN)
      .max(IDLE_RELEASE_TIMEOUT_MINUTES_MAX)
      .catch(DEFAULT_FEATURE_SETTINGS.idleReleaseTimeoutMinutes),
  })
  .catch({ ...DEFAULT_FEATURE_SETTINGS });
export type FeatureSettings = z.infer<typeof featureSettingsSchema>;

export interface FeatureState {
  id: FeatureId;
  enabled: boolean;
}

/** Every feature with its value from `features.json`, the only source of truth. */
export function resolveFeatures(settings: FeatureSettings): FeatureState[] {
  return FEATURE_IDS.map((id) => ({ id, enabled: settings[id] }));
}

/** The idle release pair the Host applies, from the file's values. */
export function idleReleaseSettings(settings: FeatureSettings): IdleReleaseSettings {
  return { enabled: settings.idleRelease, timeoutMinutes: settings.idleReleaseTimeoutMinutes };
}

/** A Dashboard choice for idle release: 0 is never, otherwise the minutes idle before release. */
export const idleReleaseMinutesSchema = z.union([
  z.literal(0),
  z.number().int().min(IDLE_RELEASE_TIMEOUT_MINUTES_MIN).max(IDLE_RELEASE_TIMEOUT_MINUTES_MAX),
]);

/** The last mirror of Claude memory into Codex, written by whichever Host process ran it. */
export const MEMORY_SYNC_RESULT_FILE = "claude-memory-sync.json";
export const memorySyncResultSchema = z.object({
  at: z.string(),
  written: z.number().int().nonnegative(),
  removed: z.number().int().nonnegative(),
  error: z.string().nullable(),
});
export type MemorySyncResult = z.infer<typeof memorySyncResultSchema>;
