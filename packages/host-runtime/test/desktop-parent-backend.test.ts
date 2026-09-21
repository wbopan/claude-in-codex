import { spawn } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

// Like packaged Host, the child runs the compiled runtime. npm test builds it first.
it.skipIf(process.platform !== "darwin")(
  "confirms actual parent exit and removes its private bootstrap directory",
  async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "cxh-parent-test-"));
    const module = new URL("../dist/codex-runtime/desktop-parent-backend.js", import.meta.url).href;
    const childSource = `
    import { createDesktopParentBackend } from ${JSON.stringify(module)};
    const originalParent = process.ppid;
    const backend = createDesktopParentBackend({
      CODEXHOST_DESKTOP_PARENT_PID: String(originalParent),
      CODEXHOST_DESKTOP_PARENT_SOCKET: ${JSON.stringify(path.join(directory, "backend.sock"))},
      CODEXHOST_DESKTOP_PARENT_LAUNCH: ${JSON.stringify(path.join(directory, "launch.json"))},
    }, { arguments: [], environment: {} });
    try {
      await backend.stop();
      await backend.closed;
      console.log(JSON.stringify({ closed: true, originalParent }));
    } catch (error) { console.error(error); process.exitCode = 1; }
  `;
    const parentSource = `
    const {spawn} = require("node:child_process");
    spawn(process.execPath, ["--input-type=module", "-e", ${JSON.stringify(childSource)}], {stdio: ["ignore", "inherit", "inherit"]});
    setInterval(() => {}, 1000);
  `;
    const parent = spawn(process.execPath, ["-e", parentSource], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "";
    parent.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    parent.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    try {
      const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve, reject) => {
          parent.once("error", reject);
          parent.once("close", (code, signal) => resolve({ code, signal }));
        },
      );
      expect(stderr).toBe("");
      expect(exit.signal).toBe("SIGTERM");
      expect(JSON.parse(stdout)).toEqual({
        closed: true,
        originalParent: parent.pid,
      });
      await expect(stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      if (parent.exitCode === null && parent.signalCode === null) parent.kill("SIGKILL");
      await rm(directory, { recursive: true, force: true });
    }
  },
  15_000,
);
