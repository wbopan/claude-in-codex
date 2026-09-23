/// <reference types="node" />
import os from "node:os";
import path from "node:path";

import { APP_NAME, APP_SLUG, DATA_DIRECTORY_ENV } from "./app-identity.js";

type Platform = NodeJS.Platform;

function homeDirectory(environment: NodeJS.ProcessEnv): string {
  return environment.HOME || os.homedir();
}

/**
 * The per-user data folder when no override is set: `~/Library/Application Support/Claude in
 * Codex` on macOS, `$XDG_DATA_HOME/claude-in-codex` (default `~/.local/share`) elsewhere.
 */
export function platformDataDirectory(
  environment: NodeJS.ProcessEnv = process.env,
  platform: Platform = process.platform,
): string {
  const home = homeDirectory(environment);
  if (platform === "darwin") return path.join(home, "Library", "Application Support", APP_NAME);
  const dataHome =
    environment.XDG_DATA_HOME && path.isAbsolute(environment.XDG_DATA_HOME)
      ? environment.XDG_DATA_HOME
      : path.join(home, ".local", "share");
  return path.join(dataHome, APP_SLUG);
}

/** The data folder in use: `CLAUDE_IN_CODEX_DATA_DIR`, then legacy `CODEXHOST_DATA_DIR`, then the platform folder. */
export function dataDirectory(
  environment: NodeJS.ProcessEnv = process.env,
  platform: Platform = process.platform,
): string {
  const explicit = environment[DATA_DIRECTORY_ENV] ?? environment.CODEXHOST_DATA_DIR;
  return explicit ? path.resolve(explicit) : platformDataDirectory(environment, platform);
}

/** `~/Library/Logs/Claude in Codex` on macOS, `<data folder>/logs` elsewhere. */
export function logDirectory(
  environment: NodeJS.ProcessEnv = process.env,
  platform: Platform = process.platform,
): string {
  if (platform === "darwin")
    return path.join(homeDirectory(environment), "Library", "Logs", APP_NAME);
  return path.join(dataDirectory(environment, platform), "logs");
}

/** The home-directory data folder used before the rename. */
export function legacyDataDirectory(environment: NodeJS.ProcessEnv = process.env): string {
  return path.join(homeDirectory(environment), ".codexhost");
}
