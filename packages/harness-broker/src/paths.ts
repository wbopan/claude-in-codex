import path from "node:path";
import { harnessPluginIdSchema } from "@claude-in-codex/shared-contracts";
import { platformDataDirectory } from "@claude-in-codex/shared-contracts/app-paths";

export const HARNESS_BROKER_DESCRIPTOR_ENV = "CLAUDE_IN_CODEX_CLAUDE_BROKER_DESCRIPTOR";
export const HARNESS_BROKER_DESCRIPTOR_FILE = "claude-code-broker-v1.json";
export const HARNESS_BROKER_SOCKET_FILE = "claude-code-broker-v1.sock";

export function defaultHarnessBrokerDirectory(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  if (environment.CLAUDE_IN_CODEX_HARNESS_BROKER_DIR) {
    if (!path.isAbsolute(environment.CLAUDE_IN_CODEX_HARNESS_BROKER_DIR)) {
      throw new Error("Harness broker directory must be absolute");
    }
    return environment.CLAUDE_IN_CODEX_HARNESS_BROKER_DIR;
  }
  // Independent of the data folder override: the Aqua LaunchAgent and every Host must agree on it.
  return path.join(platformDataDirectory(environment), "broker");
}

export function defaultHarnessBrokerDescriptorPath(
  environment: NodeJS.ProcessEnv = process.env,
  harnessId = "claude-code",
): string {
  harnessPluginIdSchema.parse(harnessId);
  if (harnessId !== "claude-code")
    return path.join(defaultHarnessBrokerDirectory(environment), `${harnessId}-broker-v1.json`);
  return (
    environment[HARNESS_BROKER_DESCRIPTOR_ENV] ??
    path.join(defaultHarnessBrokerDirectory(environment), HARNESS_BROKER_DESCRIPTOR_FILE)
  );
}

export function defaultHarnessBrokerSocketPath(
  environment: NodeJS.ProcessEnv = process.env,
  harnessId = "claude-code",
): string {
  harnessPluginIdSchema.parse(harnessId);
  if (harnessId !== "claude-code")
    return path.join(defaultHarnessBrokerDirectory(environment), `${harnessId}-broker-v1.sock`);
  return path.join(defaultHarnessBrokerDirectory(environment), HARNESS_BROKER_SOCKET_FILE);
}
