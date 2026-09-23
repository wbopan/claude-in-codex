import type { spawn } from "node:child_process";
import type { Writable } from "node:stream";

import { createRemoteOfficialAppServerListener } from "../remote-official-app-server.js";
import { createRemoteOfficialAppServerConnection } from "../remote-official-connection.js";
import type { OwnedOfficialBackend } from "./official-runtime-owner.js";

interface LaunchOptions {
  stockCodexPath: string;
  arguments: string[];
  environment: NodeJS.ProcessEnv;
}

/** Unix transport is distinct from deployment policy; account management remains
 * gated on its separately verified native process/storage capabilities. */
export function createOwnedUnixBackend(
  input: LaunchOptions & {
    diagnosticOutput: Writable;
    socketPath: string;
    spawnOfficial?: typeof spawn;
    closeTimeoutMs?: number;
  },
): OwnedOfficialBackend {
  const listener = createRemoteOfficialAppServerListener(input);
  let ready = false;
  return {
    get processId() {
      return listener.processId;
    },
    closed: listener.closed,
    async start() {
      await listener.listen();
      ready = true;
    },
    async connect() {
      if (!ready) throw new Error("Official listener is not ready");
      return createRemoteOfficialAppServerConnection(input.socketPath);
    },
    async stop() {
      ready = false;
      await listener.close();
    },
  };
}
