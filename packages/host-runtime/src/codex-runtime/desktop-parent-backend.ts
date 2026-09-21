import { lstat, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRemoteOfficialAppServerConnection } from "../remote-official-connection.js";
import type { OwnedOfficialBackend } from "./official-runtime-owner.js";
import { officialLoopbackListenerArguments } from "../remote-app-server.js";

const execute = promisify(execFile);

/** The native launcher execs Codex in its Desktop-owned PID; Host is its protocol sidecar. */
export function createDesktopParentBackend(
  environment: NodeJS.ProcessEnv,
  launch: { arguments: readonly string[]; environment: NodeJS.ProcessEnv },
): OwnedOfficialBackend | undefined {
  const socketPath = environment.CODEXHOST_DESKTOP_PARENT_SOCKET;
  const parentPid = Number(environment.CODEXHOST_DESKTOP_PARENT_PID);
  const bootstrap = environment.CODEXHOST_DESKTOP_PARENT_LAUNCH;
  if (!socketPath && !environment.CODEXHOST_DESKTOP_PARENT_PID) return undefined;
  if (
    process.platform === "win32" ||
    !socketPath ||
    !path.isAbsolute(socketPath) ||
    !Number.isSafeInteger(parentPid) ||
    parentPid <= 1 ||
    parentPid !== process.ppid
  )
    throw new Error("Invalid Desktop-owned native backend");
  const closed = Promise.withResolvers<{ code: number | null; signal: NodeJS.Signals | null }>();
  let exited = false;
  let observing: Promise<boolean> | undefined;
  const hasNativeParent = (): Promise<boolean> => {
    if (exited) return Promise.resolve(false);
    if (observing) return observing;
    // Query the live relationship independently of Node version-specific ppid
    // property behavior. Never signal a reused PID after reparenting.
    const pending = execute("/bin/ps", ["-p", String(process.pid), "-o", "ppid="], {
      timeout: 1_000,
    }).then(({ stdout }) => {
      const current = Number(stdout.trim());
      if (!Number.isSafeInteger(current) || current <= 0)
        throw new Error("Native parent identity unavailable");
      if (current === parentPid) return true;
      exited = true;
      clearInterval(poll);
      closed.resolve({ code: null, signal: null });
      return false;
    });
    observing = pending;
    void pending
      .finally(() => {
        if (observing === pending) observing = undefined;
      })
      .catch(() => undefined);
    return pending;
  };
  const poll = setInterval(() => {
    void hasNativeParent().catch(() => undefined);
  }, 250);
  poll.unref();
  const signalParent = async (signal: NodeJS.Signals): Promise<void> => {
    if (!(await hasNativeParent())) return;
    try {
      process.kill(parentPid, signal);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
    }
  };
  return {
    processId: parentPid,
    closed: closed.promise,
    async start() {
      const directory = await lstat(path.dirname(socketPath));
      if (
        !directory.isDirectory() ||
        directory.uid !== process.getuid?.() ||
        (directory.mode & 0o077) !== 0
      )
        throw new Error("Native backend socket directory must be private and owned");
      if (bootstrap) {
        if (bootstrap !== path.join(path.dirname(socketPath), "launch.json"))
          throw new Error("Invalid native bootstrap path");
        const args = officialLoopbackListenerArguments(launch.arguments);
        args[args.indexOf("--listen") + 1] = `unix://${socketPath}`;
        await writeFile(
          `${bootstrap}.tmp`,
          JSON.stringify({ arguments: args, environment: launch.environment }),
          { mode: 0o600, flag: "wx" },
        );
        await rename(`${bootstrap}.tmp`, bootstrap);
      }
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline && !exited) {
        const socket = await lstat(socketPath).catch(() => null);
        if (socket?.isSocket() && socket.uid === process.getuid?.()) return;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error("Desktop-owned native backend did not start");
    },
    async connect() {
      if (!(await hasNativeParent())) throw new Error("Desktop-owned native backend exited");
      return createRemoteOfficialAppServerConnection(socketPath);
    },
    async stop() {
      await signalParent("SIGTERM");
      const timeout = setTimeout(() => {
        void signalParent("SIGKILL").catch(() => undefined);
      }, 5_000);
      let exitTimeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          closed.promise,
          new Promise<never>((_, reject) => {
            exitTimeout = setTimeout(
              () => reject(new Error("Native backend exit was not confirmed")),
              10_000,
            );
          }),
        ]);
        if (bootstrap) await rm(path.dirname(socketPath), { recursive: true, force: true });
      } finally {
        clearTimeout(timeout);
        clearTimeout(exitTimeout);
      }
    },
  };
}
