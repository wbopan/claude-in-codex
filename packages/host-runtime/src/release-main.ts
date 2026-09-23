import { adoptLegacyEnvironment } from "@claude-in-codex/shared-contracts";
import { runHostRuntime } from "./run-host-runtime.js";
import { runRemoteHostCli } from "./remote-host-cli.js";
import { runClaudeAquaHarnessBroker } from "./aqua-harness-broker.js";
import { runMenuBarHost } from "./hot-attach/main.js";

adoptLegacyEnvironment(process.env);
// LaunchAgents and scripts written before the rename pass the legacy `--codexhost-*` switches.
const arguments_ = process.argv
  .slice(2)
  .map((argument, index) =>
    index === 0 && argument.startsWith("--codexhost-")
      ? `--claude-in-codex-${argument.slice("--codexhost-".length)}`
      : argument,
  );
process.exitCode =
  arguments_[0] === "--claude-in-codex-menubar"
    ? await runMenuBarHost(process.env, import.meta.url)
    : arguments_[0] === "--claude-in-codex-harness-broker"
      ? await runClaudeAquaHarnessBroker(process.env, arguments_[1] ?? "claude-code")
      : arguments_[0] === "--claude-in-codex-remote"
        ? await runRemoteHostCli({ arguments: arguments_.slice(1), environment: process.env })
        : await runHostRuntime({
            arguments: arguments_,
            environment: process.env,
            hostRuntimeUrl: import.meta.url,
          });
