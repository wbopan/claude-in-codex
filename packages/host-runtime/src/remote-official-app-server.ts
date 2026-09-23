import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, rm } from "node:fs/promises";
import path from "node:path";
import type { Writable } from "node:stream";

import {
  OfficialProcessLifecycle,
  OfficialProcessStopTimeoutError,
} from "./official-process-lifecycle.js";

export interface RemoteOfficialAppServerExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
}

export interface RemoteOfficialAppServerListener {
  readonly processId?: number | undefined;
  readonly closed: Promise<RemoteOfficialAppServerExit>;
  listen(): Promise<void>;
  close(): Promise<void>;
}

interface UnixFileIdentity {
  dev: number;
  ino: number;
}

type WaitUntilReady = (
  socketPath: string,
  closed: Promise<RemoteOfficialAppServerExit>,
) => Promise<void>;

const DEFAULT_CLOSE_TIMEOUT_MS = 2_000;

export function remoteOfficialAppServerSocketPath(
  desktopControlSocketPath: string,
  token: string = randomUUID(),
): string {
  if (!path.posix.isAbsolute(desktopControlSocketPath)) {
    throw new Error("Desktop control socket path must be absolute");
  }
  if (!/^[A-Za-z0-9-]+$/u.test(token) || !/[A-Za-z0-9]/u.test(token)) {
    throw new Error("Shared official app-server socket token is invalid");
  }
  const compactToken = token.replaceAll("-", "").slice(0, 15);
  return path.posix.join(path.posix.dirname(desktopControlSocketPath), `.c-${compactToken}.sock`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function socketIdentity(socketPath: string): Promise<UnixFileIdentity | null> {
  const metadata = await lstat(socketPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (metadata === null) return null;
  if (!metadata.isSocket()) {
    throw new Error(`Shared official app-server path is not a socket: ${socketPath}`);
  }
  return { dev: metadata.dev, ino: metadata.ino };
}

function sameUnixFileIdentity(left: UnixFileIdentity, right: UnixFileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function waitForOfficialSocket(
  socketPath: string,
  closed: Promise<RemoteOfficialAppServerExit>,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  const state: { exit: RemoteOfficialAppServerExit | null } = { exit: null };
  void closed.then((value) => {
    state.exit = value;
  });
  while (Date.now() < deadline) {
    const exit = state.exit;
    if (exit) {
      throw new Error(
        exit.error
          ? `Shared official app-server failed: ${exit.error.message}`
          : `Shared official app-server exited before its socket was ready (code=${String(exit.code)}, signal=${String(exit.signal)})`,
      );
    }
    if ((await socketIdentity(socketPath)) !== null) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Shared official app-server socket was not ready after 10000ms: ${socketPath}`);
}

export function createRemoteOfficialAppServerListener(input: {
  stockCodexPath: string;
  arguments: string[];
  socketPath: string;
  environment: NodeJS.ProcessEnv;
  diagnosticOutput: Writable;
  spawnOfficial?: typeof spawn;
  waitUntilReady?: WaitUntilReady;
  closeTimeoutMs?: number;
}): RemoteOfficialAppServerListener {
  const spawnOfficial = input.spawnOfficial ?? spawn;
  const waitUntilReady = input.waitUntilReady ?? waitForOfficialSocket;
  const closeTimeoutMs = input.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS;
  const closed = Promise.withResolvers<RemoteOfficialAppServerExit>();
  let child: ChildProcess | null = null;
  let listening: Promise<void> | null = null;
  let closing: Promise<void> | null = null;
  let closeRequested = false;
  let exitResult: RemoteOfficialAppServerExit | null = null;
  let ownedSocketIdentity: UnixFileIdentity | null = null;
  let processLifecycle: OfficialProcessLifecycle | null = null;

  const settleExit = (result: RemoteOfficialAppServerExit): void => {
    if (exitResult !== null) return;
    exitResult = result;
    closed.resolve(result);
  };

  const terminate = async (): Promise<void> => {
    if (!processLifecycle) return;
    try {
      await processLifecycle.stop();
    } catch (error) {
      if (error instanceof OfficialProcessStopTimeoutError) {
        input.diagnosticOutput.write(
          `claude-in-codex shared official app-server exit unconfirmed: ${input.socketPath}\n`,
        );
      }
      throw error;
    }
  };

  const removeOwnedSocket = async (): Promise<void> => {
    if (ownedSocketIdentity === null) return;
    const current = await socketIdentity(input.socketPath).catch(() => null);
    if (current && sameUnixFileIdentity(current, ownedSocketIdentity)) {
      await rm(input.socketPath, { force: true });
    }
    ownedSocketIdentity = null;
  };

  return {
    get processId() {
      return child?.pid;
    },
    closed: closed.promise,
    listen() {
      if (listening) return listening;
      listening = (async () => {
        if (closeRequested) throw new Error("Shared official app-server is already closed");
        const spawned = spawnOfficial(input.stockCodexPath, input.arguments, {
          env: input.environment,
          stdio: ["ignore", "ignore", "pipe"],
          windowsHide: true,
        });
        child = spawned;
        processLifecycle = new OfficialProcessLifecycle(spawned, { timeoutMs: closeTimeoutMs });
        void processLifecycle.closed.then(settleExit);
        spawned.stderr?.pipe(input.diagnosticOutput, { end: false });
        try {
          await waitUntilReady(input.socketPath, closed.promise);
          ownedSocketIdentity = await socketIdentity(input.socketPath).catch(() => null);
        } catch (error) {
          let stopFailed = false;
          try {
            await terminate();
          } catch {
            stopFailed = true;
          }
          ownedSocketIdentity ??= await socketIdentity(input.socketPath).catch(() => null);
          // A live process may still own the socket after an unconfirmed exit.
          if (!stopFailed) await removeOwnedSocket();
          throw new Error(`Shared official app-server startup failed: ${errorMessage(error)}`);
        }
      })();
      return listening;
    },
    close() {
      if (closing) return closing;
      closeRequested = true;
      closing = (async () => {
        if (!child) {
          settleExit({ code: 0, signal: null });
          await removeOwnedSocket();
          return;
        }
        await terminate();
        await removeOwnedSocket();
      })();
      void closing.catch(() => {
        closing = null;
      });
      return closing;
    },
  };
}
