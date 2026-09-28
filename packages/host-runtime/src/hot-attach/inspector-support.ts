import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";

// Electron's fuse wire: sentinel, version byte, length byte, ASCII states.
// EnableNodeCliInspectArguments is index 3 in V1. Disabled also removes the SIGUSR1
// handler, so sending that signal terminates Desktop instead of opening its inspector.
const sentinel = Buffer.from("dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX");
const unsupported =
  "This Codex App version disables the connection interface used for live attachment. Restart Codex to connect Claude at startup.";
const unverified =
  "Cannot verify that this Codex App supports safe attachment. No signal was sent to the Codex App.";

export class InspectorDisabledError extends Error {}

/** Read only, bounded memory, and require every architecture's fuse to be enabled. */
export async function assertInspectorSupport(appPath: string): Promise<void> {
  try {
    const directory = path.join(appPath, "Contents/Frameworks");
    const frameworks = (await readdir(directory)).filter((name) =>
      ["Electron Framework.framework", "Codex Framework.framework"].includes(name),
    );
    const [framework] = frameworks;
    if (frameworks.length !== 1 || !framework) throw new Error(unverified);
    const binary = path.join(directory, framework, framework.slice(0, -".framework".length));
    let pending: Buffer = Buffer.alloc(0);
    let found = false;
    for await (const chunk of createReadStream(binary)) {
      pending = Buffer.concat([pending, chunk as Buffer]);
      let offset: number;
      while ((offset = pending.indexOf(sentinel)) >= 0) {
        pending = pending.subarray(offset);
        const header = sentinel.length;
        if (pending.length < header + 2) break;
        const length = pending[header + 1];
        if (pending[header] !== 1 || length === undefined || length < 4)
          throw new Error(unverified);
        if (pending.length < header + 2 + length) break;
        const state = pending[header + 2 + 3];
        if (state === 48) throw new InspectorDisabledError(unsupported);
        if (state !== 49) throw new Error(unverified);
        found = true;
        pending = pending.subarray(header + 2 + length);
      }
      if (offset < 0) pending = pending.subarray(-(sentinel.length - 1));
    }
    if (!found || pending.includes(sentinel)) throw new Error(unverified);
  } catch (error) {
    if (error instanceof Error && error.message === unsupported) throw error;
    throw new Error(unverified, { cause: error });
  }
}
