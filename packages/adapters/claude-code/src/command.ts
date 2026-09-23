import { execFile } from "node:child_process";
import path from "node:path";

import {
  resolveHarnessExecutable,
  targetPath,
  VERSION_MANAGER_ROOTS,
  withNodeRuntimeOnPath,
  type HarnessDiscoveryDependencies,
  type HarnessDiscoverySpec,
} from "@claude-in-codex/harness-discovery";

export { withNodeRuntimeOnPath } from "@claude-in-codex/harness-discovery";

export class ClaudeCodeExecutableError extends Error {
  readonly code = "CLAUDE_NOT_FOUND";
}

const CLAUDE_NPM_PACKAGE_BIN = "node_modules/@anthropic-ai/claude-code/bin";

export const claudeCodeDiscoverySpec: HarnessDiscoverySpec = {
  id: "claude-code",
  command: "claude",
  commandEnvironmentVariable: "CLAUDE_IN_CODEX_CLAUDE_COMMAND",
  installRoots: {
    posix: [
      "~/.npm-global/bin",
      "~/.local/bin",
      "~/.claude/local",
      VERSION_MANAGER_ROOTS,
      "/opt/homebrew/bin",
      "/usr/local/bin",
    ],
    windows: [
      `\${APPDATA}/npm/${CLAUDE_NPM_PACKAGE_BIN}`,
      "${APPDATA}/npm",
      "~/.local/bin",
      VERSION_MANAGER_ROOTS,
    ],
  },
  // Prefer Claude Code's native binary over the npm CMD shim beside it: the
  // shim spawns an extra cmd.exe and loses signal handling.
  runnableCandidate: (candidate, { platform, isExecutable }) => {
    const pathFlavor = targetPath(platform);
    if (platform !== "win32" || pathFlavor.basename(candidate).toLowerCase() !== "claude.cmd") {
      return candidate;
    }
    const native = pathFlavor.join(
      pathFlavor.dirname(candidate),
      ...CLAUDE_NPM_PACKAGE_BIN.split("/"),
      "claude.exe",
    );
    return isExecutable(native) ? native : undefined;
  },
};

export function resolveClaudeCodeExecutable(
  input: {
    command?: string;
    environment?: NodeJS.ProcessEnv;
    homeDirectory?: string;
    platform?: NodeJS.Platform;
  } = {},
  dependencies: HarnessDiscoveryDependencies = {},
): string {
  const platform = input.platform ?? process.platform;
  const resolution = resolveHarnessExecutable(
    claudeCodeDiscoverySpec,
    {
      ...(input.command ? { command: input.command } : {}),
      environment: input.environment ?? process.env,
      ...(input.homeDirectory ? { homeDirectory: input.homeDirectory } : {}),
      platform,
    },
    dependencies,
  );
  if (!resolution) throw new ClaudeCodeExecutableError("Claude Code is not installed");
  return targetPath(platform).isAbsolute(resolution.executable)
    ? resolution.executable
    : path.resolve(resolution.executable);
}

/** Reads `claude --version`, e.g. "2.1.279" from "2.1.279 (Claude Code)". Null on any failure. */
export function readClaudeCodeVersion(
  executable: string,
  environment: NodeJS.ProcessEnv,
  timeoutMs = 5_000,
): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      executable,
      ["--version"],
      {
        env: withNodeRuntimeOnPath({ ...environment }),
        timeout: timeoutMs,
        maxBuffer: 64 * 1024,
        encoding: "utf8",
      },
      (error, stdout) => {
        const line = error ? "" : (stdout.trim().split("\n")[0] ?? "");
        resolve(line.replace(/\s*\(Claude Code\)$/u, "").trim() || null);
      },
    );
  });
}
