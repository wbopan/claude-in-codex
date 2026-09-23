/**
 * User-selected standing consent for native Computer Use app-access confirmations.
 *
 * Only a confirmation that explicitly permits a saved approval for one app is accepted. Device
 * verification, authentication, input forms and anything without persistent approval keep their
 * own prompt. Native app restrictions and OS permissions still apply after this answer.
 *
 * Enabled by `{ "version": 1, "appApprovals": "allow" }` in `<Claude config dir>/codex-desktop.json`.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import type { JsonObject } from "@claude-in-codex/shared-contracts";

const object = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const APP_ID = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+$/u;
const SCHEMA_KEYS = new Set(["type", "properties", "required", "$schema"]);

export function appConsentEnabled(environment: NodeJS.ProcessEnv): boolean {
  const directory = environment.CLAUDE_CONFIG_DIR || path.join(homedir(), ".claude");
  try {
    const policy: unknown = JSON.parse(
      readFileSync(path.join(directory, "codex-desktop.json"), "utf8"),
    );
    return object(policy) && policy.version === 1 && policy.appApprovals === "allow";
  } catch {
    return false;
  }
}

/** The app a standing consent may approve, or `null` when the request needs its own prompt. */
export function consentedApp(params: JsonObject, contextThreadId: string): string | null {
  if (
    params.serverName !== "cua_repl" ||
    params.threadId !== contextThreadId ||
    params.mode !== "form"
  )
    return null;
  const schema = params.requestedSchema;
  const meta = params._meta;
  if (!object(schema) || !object(meta)) return null;
  const emptyForm =
    schema.type === "object" &&
    object(schema.properties) &&
    Object.keys(schema.properties).length === 0 &&
    (schema.required === undefined ||
      schema.required === null ||
      (Array.isArray(schema.required) && schema.required.length === 0)) &&
    Object.keys(schema).every((key) => SCHEMA_KEYS.has(key));
  if (!emptyForm) return null;
  const toolParams = meta.tool_params;
  if (
    meta.connector_id !== "computer-use" ||
    meta.codex_approval_kind !== "mcp_tool_call" ||
    !Array.isArray(meta.persist) ||
    !meta.persist.includes("always") ||
    typeof meta.tool_name !== "string" ||
    !meta.tool_name ||
    !object(toolParams) ||
    Object.keys(toolParams).length !== 1
  )
    return null;
  const app = toolParams.app;
  return typeof app === "string" && APP_ID.test(app) ? app : null;
}
