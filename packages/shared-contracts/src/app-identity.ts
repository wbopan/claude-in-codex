/** The product name shown to people and used for macOS per-user folders. */
export const APP_NAME = "Claude in Codex";
/** The lowercase name used for commands, packages and non-macOS folders. */
export const APP_SLUG = "claude-in-codex";

export const ENVIRONMENT_PREFIX = "CLAUDE_IN_CODEX_";
/** Prefix of the variables the Host used before the rename; still honoured and scrubbed. */
export const LEGACY_ENVIRONMENT_PREFIX = "CODEXHOST_";
export const DATA_DIRECTORY_ENV = "CLAUDE_IN_CODEX_DATA_DIR";
/** `modelProvider` of external Threads, and the one a Desktop may echo from a pre-rename Host. */
export const MODEL_PROVIDER = "claude-in-codex";
export const LEGACY_MODEL_PROVIDER = "codexhost";

/**
 * Copies every `CODEXHOST_*` variable to its `CLAUDE_IN_CODEX_*` name unless the new name is
 * already set. Shell profiles and scripts written before the rename keep working.
 */
export function adoptLegacyEnvironment(
  environment: Record<string, string | undefined>,
): Record<string, string | undefined> {
  for (const [key, value] of Object.entries(environment)) {
    if (!key.startsWith(LEGACY_ENVIRONMENT_PREFIX) || value === undefined) continue;
    const current = `${ENVIRONMENT_PREFIX}${key.slice(LEGACY_ENVIRONMENT_PREFIX.length)}`;
    environment[current] ??= value;
  }
  return environment;
}

/** Whether a variable belongs to this App under its current or its legacy prefix. */
export function isAppEnvironmentVariable(key: string): boolean {
  return key.startsWith(ENVIRONMENT_PREFIX) || key.startsWith(LEGACY_ENVIRONMENT_PREFIX);
}
