import path from "node:path";
import { homedir } from "node:os";

import { AppServerHost, officialEnvironment } from "./app-server-host.js";
import { SingleNativeCodexAccount } from "./account/codex-account-control.js";
import { OfficialRuntimeScope } from "./codex-runtime/official-runtime-scope.js";
import { createOwnedUnixBackend } from "./codex-runtime/owned-official-backends.js";
import { installedHarnessPluginOptions } from "./installed-harness-plugins.js";
import { createProductionExternalThreadStore } from "./external-thread-repository.js";
import {
  createRemoteAppServerWebSocketListener,
  isRemoteUnixListenerInvocation,
  officialListenerArgumentsForRemoteListener,
  prepareRemoteAppServerSocketDirectory,
  remoteAppServerSocketPath,
  remoteUnixListenerUrl,
} from "./remote-app-server.js";
import { remoteOfficialAppServerSocketPath } from "./remote-official-app-server.js";

const STOCK_CODEX_PATH_ENV = "CLAUDE_IN_CODEX_STOCK_CODEX_PATH";
const DEFAULT_AGENT_ENV = "CLAUDE_IN_CODEX_DEFAULT_AGENT";
export const MANAGED_REMOTE_APP_SERVER_PROCESS_TITLE = "claude-in-codex remote app-server listener";

export function createRemoteOfficialAppServerPlan(
  arguments_: readonly string[],
  desktopControlSocketPath: string,
  token?: string,
): {
  socketPath: string;
  listenerArguments: string[];
} {
  const socketPath = remoteOfficialAppServerSocketPath(desktopControlSocketPath, token);
  return {
    socketPath,
    listenerArguments: officialListenerArgumentsForRemoteListener(arguments_, socketPath),
  };
}

function requiredRuntimeConfiguration(environment: NodeJS.ProcessEnv): {
  stockCodexPath: string;
  defaultAgent: "codex";
} {
  const stockCodexPath = environment[STOCK_CODEX_PATH_ENV];
  if (!stockCodexPath) throw new Error(`${STOCK_CODEX_PATH_ENV} is required`);
  const defaultAgent = environment[DEFAULT_AGENT_ENV];
  if (defaultAgent !== "codex") {
    throw new Error(`${DEFAULT_AGENT_ENV} must be 'codex'`);
  }
  return { stockCodexPath, defaultAgent };
}

export async function runHostRuntime(input: {
  arguments: string[];
  environment: NodeJS.ProcessEnv;
  hostRuntimeUrl?: string;
}): Promise<number> {
  const { stockCodexPath, defaultAgent } = requiredRuntimeConfiguration(input.environment);
  // The Host Runtime serves only the SSH-managed remote listener. Every other app-server
  // invocation stays on the stock Codex CLI; the Shim never routes one here.
  if (!isRemoteUnixListenerInvocation(input.arguments)) {
    throw new Error("The Host Runtime serves only the managed remote app-server listener");
  }
  if (process.platform === "win32") {
    throw new Error("Remote Unix app-server listener is unavailable on Windows");
  }
  const listenUrl = remoteUnixListenerUrl(input.arguments);
  if (!listenUrl) throw new Error("Remote app-server listener URL is unavailable");
  const remoteEnvironment = input.environment;
  const socketPath = remoteAppServerSocketPath(remoteEnvironment, listenUrl);
  const officialPlan = createRemoteOfficialAppServerPlan(input.arguments, socketPath);
  const officialRuntimeScope = new OfficialRuntimeScope({
    permanentHome: path.resolve(remoteEnvironment.CODEX_HOME ?? path.join(homedir(), ".codex")),
    diagnosticOutput: process.stderr,
    createBackend: () =>
      createOwnedUnixBackend({
        stockCodexPath,
        arguments: officialPlan.listenerArguments,
        socketPath: officialPlan.socketPath,
        environment: officialEnvironment(remoteEnvironment),
        diagnosticOutput: process.stderr,
      }),
  });
  const accountControl = new SingleNativeCodexAccount(() => ({
    version: 2,
    currentAccountId: "remote-native",
    phase: officialRuntimeScope.gate.phase,
    revision: officialRuntimeScope.gate.revision,
    accounts: [{ accountId: "remote-native", label: "Remote native Codex Account" }],
  }));
  const mappingStore = createProductionExternalThreadStore(remoteEnvironment);
  await mappingStore.initialize();
  const listener = createRemoteAppServerWebSocketListener({
    socketPath,
    diagnosticOutput: process.stderr,
    createSession: ({ input: desktopInput, output: desktopOutput, diagnosticOutput }) => {
      return new AppServerHost({
        stockCodexPath,
        arguments: [],
        defaultAgent,
        environment: remoteEnvironment,
        desktopInput,
        desktopOutput,
        diagnosticOutput,
        ...installedHarnessPluginOptions(remoteEnvironment, true, input.hostRuntimeUrl),
        mappingStore,
        closeMappingStoreOnExit: false,
        officialRuntimeScope,
        accountControl,
      });
    },
  });

  let stopping = false;
  const officialState: { unexpectedExit: Error | null } = { unexpectedExit: null };
  const stop = (): void => {
    stopping = true;
    void listener.close();
  };
  try {
    await prepareRemoteAppServerSocketDirectory(socketPath);
    await officialRuntimeScope.start().catch(() => {
      officialRuntimeScope.gate.unavailable();
    });
    await listener.listen();
    void officialRuntimeScope.failure().then((result) => {
      if (!stopping) officialState.unexpectedExit = result;
      // Keep remote external Harness sessions alive when only native Codex fails.
    });
    process.title = MANAGED_REMOTE_APP_SERVER_PROCESS_TITLE;
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    await listener.closed;
    return officialState.unexpectedExit ? 1 : 0;
  } finally {
    stopping = true;
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    try {
      await listener.close();
    } finally {
      try {
        await officialRuntimeScope.close();
      } finally {
        await mappingStore.close();
      }
    }
  }
}
