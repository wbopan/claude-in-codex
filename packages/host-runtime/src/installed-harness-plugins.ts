import path from "node:path";
import { fileURLToPath } from "node:url";

import { dataDirectory } from "@claude-in-codex/shared-contracts/app-paths";
import type { HarnessPluginContext } from "@claude-in-codex/harness-adapter/plugin";

export const HARNESS_PLUGIN_DIRECTORY_ENV = "CLAUDE_IN_CODEX_PLUGIN_DIRECTORY";

/** The distribution owns the sibling plugins directory; never search a project cwd. */
export function installedHarnessPluginOptions(
  environment: NodeJS.ProcessEnv,
  managedRemoteHost = false,
  hostRuntimeUrl: string = import.meta.url,
): { pluginRoots: readonly string[]; pluginContext: HarnessPluginContext } {
  return {
    pluginRoots: [
      path.join(path.dirname(fileURLToPath(hostRuntimeUrl)), "plugins"),
      environment[HARNESS_PLUGIN_DIRECTORY_ENV] ?? path.join(dataDirectory(environment), "plugins"),
    ],
    pluginContext: {
      environment,
      platform: process.platform,
      managedRemoteHost,
    },
  };
}
