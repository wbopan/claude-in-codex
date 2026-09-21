import path from "node:path";

import {
  startControllerAttachmentServer,
  type ControllerAttachmentServer,
  type StartControllerAttachmentServerOptions,
} from "./controller-attachment-server.js";

export interface DesktopControllerOptions {
  rendererCdpEndpoint: string;
  rendererPath: string;
  defaultAgent: "codex";
  attachmentPort: number;
  attachmentNonce: string;
}

export interface DesktopControllerReadiness {
  schemaVersion: 2;
  state: "compatible";
  issues: [];
}

export interface DesktopControllerDependencies {
  startAttachmentServer(
    options: StartControllerAttachmentServerOptions,
  ): Promise<ControllerAttachmentServer>;
  ready(readiness: DesktopControllerReadiness): void;
  sleep(milliseconds: number): Promise<void>;
  monitorIntervalMs: number;
}

const DESKTOP_CONTROLLER_READINESS_MAX_BYTES = 512;
const startupTraceStartedAt = Date.now();

function startupTrace(stage: string, detail?: unknown): void {
  if (process.env.CODEXHOST_STARTUP_TRACE !== "1") return;
  const suffix =
    detail === undefined ? "" : `: ${detail instanceof Error ? detail.message : String(detail)}`;
  console.error(
    `[codexhost startup +${Date.now() - startupTraceStartedAt}ms] controller: ${stage}${suffix}`,
  );
}

export function serializeDesktopControllerReadiness(readiness: DesktopControllerReadiness): string {
  if (
    readiness.schemaVersion !== 2 ||
    readiness.state !== "compatible" ||
    !Array.isArray(readiness.issues) ||
    readiness.issues.length !== 0 ||
    Object.keys(readiness).length !== 3
  ) {
    throw new Error("Desktop Controller readiness is invalid");
  }
  const line = JSON.stringify(readiness);
  if (Buffer.byteLength(line, "utf8") > DESKTOP_CONTROLLER_READINESS_MAX_BYTES) {
    throw new Error("Desktop Controller readiness exceeds its size limit");
  }
  return line;
}

const defaultDependencies: DesktopControllerDependencies = {
  startAttachmentServer: startControllerAttachmentServer,
  ready: (readiness) => {
    process.stdout.write(`${serializeDesktopControllerReadiness(readiness)}\n`);
  },
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  monitorIntervalMs: 500,
};

function rendererCdpEndpoint(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    !url.port ||
    url.username ||
    url.password ||
    (url.pathname !== "/" && url.pathname !== "") ||
    url.search ||
    url.hash
  ) {
    throw new Error("--renderer-cdp-endpoint must be a loopback HTTP origin with an explicit port");
  }
  return url.origin;
}

export function parseDesktopControllerArguments(
  arguments_: readonly string[],
): DesktopControllerOptions {
  let endpoint: string | undefined;
  let rendererPath: string | undefined;
  let defaultAgent: "codex" | undefined;
  let attachmentPort: number | undefined;
  let attachmentNonce: string | undefined;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    const value = arguments_[index + 1];
    if (argument === "--renderer-cdp-endpoint") {
      if (endpoint !== undefined) {
        throw new Error("--renderer-cdp-endpoint may only be provided once");
      }
      if (!value) throw new Error("--renderer-cdp-endpoint requires a value");
      endpoint = rendererCdpEndpoint(value);
      index += 1;
      continue;
    }
    if (argument === "--renderer") {
      if (rendererPath !== undefined) throw new Error("--renderer may only be provided once");
      if (!value) throw new Error("--renderer requires a value");
      if (!path.isAbsolute(value)) throw new Error("--renderer must be an absolute path");
      rendererPath = path.normalize(value);
      index += 1;
      continue;
    }
    if (argument === "--default-agent") {
      if (defaultAgent !== undefined) throw new Error("--default-agent may only be provided once");
      if (value !== "codex") {
        throw new Error("--default-agent must be 'codex'");
      }
      defaultAgent = value;
      index += 1;
      continue;
    }
    if (argument === "--attachment-port") {
      if (attachmentPort !== undefined) {
        throw new Error("--attachment-port may only be provided once");
      }
      const port = Number(value);
      if (!Number.isInteger(port) || port < 1 || port > 65_535) {
        throw new Error("--attachment-port must be a valid TCP port");
      }
      attachmentPort = port;
      index += 1;
      continue;
    }
    if (argument === "--attachment-nonce") {
      if (attachmentNonce !== undefined) {
        throw new Error("--attachment-nonce may only be provided once");
      }
      if (value === undefined || !/^[0-9a-f]{32}$/.test(value)) {
        throw new Error("--attachment-nonce must be 32 lowercase hexadecimal characters");
      }
      attachmentNonce = value;
      index += 1;
      continue;
    }
    throw new Error(`unknown Desktop Controller option: ${argument}`);
  }
  if (endpoint === undefined) throw new Error("--renderer-cdp-endpoint is required");
  if (rendererPath === undefined) throw new Error("--renderer is required");
  if (defaultAgent === undefined) throw new Error("--default-agent is required");
  if (attachmentPort === undefined) throw new Error("--attachment-port is required");
  if (attachmentNonce === undefined) throw new Error("--attachment-nonce is required");
  return {
    rendererCdpEndpoint: endpoint,
    rendererPath,
    defaultAgent,
    attachmentPort,
    attachmentNonce,
  };
}

/**
 * The Desktop Controller keeps the launcher contract (attachment server and readiness line) and
 * installs nothing into Desktop: this product drives Codex Desktop through native protocol seams.
 */
export async function runDesktopController(
  options: DesktopControllerOptions,
  signal: AbortSignal,
  dependencies: DesktopControllerDependencies = defaultDependencies,
): Promise<void> {
  startupTrace("initialization started");
  startupTrace("passive controller: no Renderer Session will be installed");
  const attachmentServer = await dependencies.startAttachmentServer({
    port: options.attachmentPort,
    nonce: options.attachmentNonce,
    attach: async () => undefined,
  });
  try {
    dependencies.ready({ schemaVersion: 2, state: "compatible", issues: [] });
    while (!signal.aborted) await dependencies.sleep(dependencies.monitorIntervalMs);
  } finally {
    await attachmentServer.close();
  }
}
