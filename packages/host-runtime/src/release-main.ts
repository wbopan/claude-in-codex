import { runHostRuntime } from "./run-host-runtime.js";
import { runRemoteHostCli } from "./remote-host-cli.js";
import { runClaudeAquaHarnessBroker } from "./aqua-harness-broker.js";

const arguments_ = process.argv.slice(2);
process.exitCode =
  arguments_[0] === "--codexhost-harness-broker"
    ? await runClaudeAquaHarnessBroker(process.env, arguments_[1] ?? "claude-code")
    : arguments_[0] === "--codexhost-remote"
      ? await runRemoteHostCli({ arguments: arguments_.slice(1), environment: process.env })
      : await runHostRuntime({
              arguments: arguments_,
              environment: process.env,
              hostRuntimeUrl: import.meta.url,
            });
