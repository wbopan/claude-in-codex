import { execFileSync } from "node:child_process";
import type * as childProcess from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HotAttachController } from "../src/hot-attach/controller.js";
import { assertInspectorSupport } from "../src/hot-attach/inspector-support.js";

vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof childProcess>()),
  execFileSync: vi.fn(),
}));

let directory: string;
beforeEach(async () => {
  vi.mocked(execFileSync).mockReset();
  directory = await mkdtemp(path.join(os.tmpdir(), "inspector-support-"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

const sentinel = Buffer.from("dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX");
function wire(states = "010111001", version = 1) {
  return Buffer.concat([sentinel, Buffer.from([version, states.length]), Buffer.from(states)]);
}
async function app(bytes: Buffer, name = "Codex Framework") {
  const framework = path.join(directory, "Contents/Frameworks", `${name}.framework`);
  await mkdir(framework, { recursive: true });
  await writeFile(path.join(framework, name), bytes);
  return directory;
}

describe("Desktop inspector capability", () => {
  it.each(["Codex Framework", "Electron Framework"])("allows enabled %s", async (name) => {
    await expect(assertInspectorSupport(await app(wire(), name))).resolves.toBeUndefined();
  });
  it("rejects the fuse wire from Codex 26.924.22138", async () => {
    await expect(assertInspectorSupport(await app(wire("010011001")))).rejects.toThrow(
      "disables the connection interface",
    );
  });
  it.each([
    Buffer.alloc(100),
    wire("010r11001"),
    wire("010?11001"),
    wire("010111001", 2),
    wire("010"),
    wire().subarray(0, -1),
    Buffer.concat([wire(), wire().subarray(0, -1)]),
  ])("rejects unrecognized or incomplete capabilities", async (bytes) => {
    await expect(assertInspectorSupport(await app(bytes))).rejects.toThrow("Cannot verify");
  });
  it("rejects an unreadable framework", async () => {
    await expect(assertInspectorSupport(directory)).rejects.toThrow("Cannot verify");
  });
  it("requires every architecture to enable inspection", async () => {
    const bytes = Buffer.concat([wire(), Buffer.alloc(100), wire("010011001")]);
    await expect(assertInspectorSupport(await app(bytes))).rejects.toThrow("disables");
  });
  it.each([10, sentinel.length + 1, sentinel.length + 5])(
    "reads a wire split across stream chunks at byte %i",
    async (split) => {
      // Larger than both Node 22 and 24's default file stream chunks.
      const bytes = Buffer.concat([Buffer.alloc(1024 * 1024 - split), wire()]);
      await expect(assertInspectorSupport(await app(bytes))).resolves.toBeUndefined();
    },
  );
});

describe("attachment signal safety", () => {
  function controller() {
    vi.mocked(execFileSync).mockImplementation((file) => {
      if (file === "/bin/ps")
        return `12345 Mon Sep 28 11:15:03 2026 ${directory}/Contents/MacOS/ChatGPT\n`;
      if (file === "/usr/bin/codesign") return "";
      if (file === "/usr/sbin/lsof") throw Object.assign(new Error("no listener"), { status: 1 });
      throw new Error(`Unexpected command: ${file}`);
    });
    return new HotAttachController({
      appPath: directory,
      environment: {},
      hostRuntimeUrl: import.meta.url,
    });
  }
  it.each([wire("010011001"), Buffer.alloc(100)])(
    "reports incompatibility without signaling Desktop or probing its port",
    async (bytes) => {
      await app(bytes);
      const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
      const fetch = vi.spyOn(globalThis, "fetch");
      const host = controller();
      await expect(host.attach()).rejects.toThrow();
      expect(host.status()).toMatchObject({ phase: "error", pid: 12345 });
      expect(kill).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    },
  );
  it("signals an enabled build only after rechecking process identity", async () => {
    await app(wire());
    const kill = vi.spyOn(process, "kill").mockImplementation(() => {
      throw new Error("stop at signal boundary");
    });
    await expect(controller().attach()).rejects.toThrow("stop at signal boundary");
    expect(kill).toHaveBeenCalledWith(12345, "SIGUSR1");
    expect(vi.mocked(execFileSync).mock.calls.filter(([file]) => file === "/bin/ps")).toHaveLength(
      2,
    );
  });
});
