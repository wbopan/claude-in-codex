import { z } from "zod";

import { harnessModelRefSchema, harnessThinkingOptionIdSchema } from "./harness-models.js";
import { harnessPermissionModeIdSchema } from "./harness-permission-modes.js";
import { harnessPluginIdSchema } from "./harness-plugins.js";

/** Every Model route this App publishes starts with this prefix. */
export const ROUTE_PREFIX = "claude-in-codex/";
/** Prefix of the routes published before the rename; stored Threads and selections still carry it. */
export const LEGACY_ROUTE_PREFIX = "codexhost/";
export const HARNESS_PLUGIN_ROUTE_PREFIX = `${ROUTE_PREFIX}plugin-v1@`;

/** Rewrites a pre-rename route to the current prefix; every other value is returned unchanged. */
export function normalizeRouteId<T>(value: T): T {
  return (
    typeof value === "string" && value.startsWith(LEGACY_ROUTE_PREFIX)
      ? `${ROUTE_PREFIX}${value.slice(LEGACY_ROUTE_PREFIX.length)}`
      : value
  ) as T;
}
const MAX_ROUTE_LENGTH = 4096;

export const harnessPluginRouteSchema = z
  .object({
    harnessId: harnessPluginIdSchema,
    model: harnessModelRefSchema.optional(),
    thinkingOptionId: harnessThinkingOptionIdSchema.optional(),
    permissionModeId: harnessPermissionModeIdSchema.optional(),
  })
  .strict();
export type HarnessPluginRoute = z.infer<typeof harnessPluginRouteSchema>;

/** All identity fields are transport-safe ASCII; no Node.js Buffer dependency. */
export function encodeHarnessPluginRoute(route: HarnessPluginRoute): string {
  const parsed = harnessPluginRouteSchema.parse(route);
  const payload = [...JSON.stringify(parsed)]
    .map((character) => character.charCodeAt(0).toString(16).padStart(2, "0"))
    .join("");
  return `${HARNESS_PLUGIN_ROUTE_PREFIX}${payload}`;
}

/** null means another protocol, not an invalid or unavailable external Harness. */
export function decodeHarnessPluginRoute(input: unknown): HarnessPluginRoute | null {
  const value = normalizeRouteId(input);
  if (typeof value !== "string" || !value.startsWith(HARNESS_PLUGIN_ROUTE_PREFIX)) return null;
  const payload = value.slice(HARNESS_PLUGIN_ROUTE_PREFIX.length);
  if (value.length > MAX_ROUTE_LENGTH || !/^(?:[a-f0-9]{2})+$/u.test(payload)) {
    throw new Error("Invalid Harness plugin route");
  }
  try {
    const json = payload.replace(/[a-f0-9]{2}/gu, (byte) =>
      String.fromCharCode(Number.parseInt(byte, 16)),
    );
    const decoded = harnessPluginRouteSchema.parse(JSON.parse(json));
    if (encodeHarnessPluginRoute(decoded) !== value)
      throw new Error("Noncanonical Harness plugin route");
    return decoded;
  } catch {
    throw new Error("Invalid Harness plugin route");
  }
}
