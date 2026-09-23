import { z } from "zod";

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
export const DEFAULT_FEATURE_SETTINGS = Object.freeze({
  version: 1,
  codexAppTools: true,
  computerUse: true,
  codexMemory: true,
  claudeMemorySync: true,
  idleRelease: false,
} as const);

/** A missing or malformed key falls back to its default; other keys keep their values. */
export const featureSettingsSchema = z
  .object({
    version: z.literal(1).catch(1),
    ...(Object.fromEntries(
      FEATURE_IDS.map((id) => [id, z.boolean().catch(DEFAULT_FEATURE_SETTINGS[id])]),
    ) as Record<FeatureId, z.ZodCatch<z.ZodBoolean>>),
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

/** The last mirror of Claude memory into Codex, written by whichever Host process ran it. */
export const MEMORY_SYNC_RESULT_FILE = "claude-memory-sync.json";
export const memorySyncResultSchema = z.object({
  at: z.string(),
  written: z.number().int().nonnegative(),
  removed: z.number().int().nonnegative(),
  error: z.string().nullable(),
});
export type MemorySyncResult = z.infer<typeof memorySyncResultSchema>;
