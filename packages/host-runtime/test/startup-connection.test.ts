import { execFileSync } from "node:child_process";
import type * as childProcess from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isDesktopStdioInvocation } from "../src/remote-app-server.js";
import {
  desktopOfficialListenerArguments,
  prepareStartupConnection,
  startupRequest,
  stockDesktopCli,
} from "../src/startup-connection.js";

vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof childProcess>()),
  execFileSync: vi.fn(),
}));
let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "startup-test-"));
  vi.mocked(execFileSync).mockReset();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

describe("Desktop CLI routing", () => {
  it.each([
    ["app-server"],
    ["-c", "features.code_mode_host=true", "app-server", "--analytics-default-enabled"],
    ["app-server", "--listen", "stdio://", "-c", "plugins.x.enabled=true"],
  ])("routes Desktop stdio arguments %j", (...args) => {
    expect(isDesktopStdioInvocation(args)).toBe(true);
  });
  it.each([
    ["--version"],
    ["exec", "app-server"],
    ["app-server", "--help"],
    ["app-server", "generate-json-schema"],
    ["app-server", "--listen", "unix:///tmp/server.sock"],
    ["app-server", "--listen=ws://localhost:1234"],
    ["app-server", "--listen"],
    ["-c", "app-server"],
    ["app-server", "--config"],
  ])("delegates other CLI arguments %j", (...args) => {
    expect(isDesktopStdioInvocation(args)).toBe(false);
  });
});

it("resolves both old and new signed-app CLI layouts", async () => {
  const old = path.join(directory, "Contents/Resources/codex");
  await mkdir(path.dirname(old), { recursive: true });
  await writeFile(old, "");
  expect(await stockDesktopCli(directory)).toBe(old);
  const current = path.join(
    directory,
    "Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex",
  );
  await mkdir(path.dirname(current), { recursive: true });
  await writeFile(current, "");
  expect(await stockDesktopCli(directory)).toBe(current);
});

it("verifies the official bundle and quotes an executable per-launch override", async () => {
  const stock = path.join(directory, "Contents/Resources/codex");
  await mkdir(path.dirname(stock), { recursive: true });
  await writeFile(stock, "");
  const data = path.join(directory, "user data");
  const source = path.join(directory, "it's $not `shell`.mjs");
  const plan = await prepareStartupConnection(
    { CLAUDE_IN_CODEX_DESKTOP_APP: directory, CLAUDE_IN_CODEX_DATA_DIR: data },
    pathToFileURL(source).href,
  );
  expect(execFileSync).toHaveBeenCalledWith(
    "/usr/bin/codesign",
    expect.arrayContaining(["--verify", directory]),
    expect.anything(),
  );
  expect(await readFile(plan.cliPath, "utf8")).toContain("it'\\''s $not `shell`.mjs'");
  expect((await stat(plan.cliPath)).mode & 0o777).toBe(0o700);
  vi.mocked(execFileSync).mockImplementation(() => {
    throw new Error("invalid signature");
  });
  await expect(
    prepareStartupConnection(
      { CLAUDE_IN_CODEX_DESKTOP_APP: directory },
      pathToFileURL(source).href,
    ),
  ).rejects.toThrow("invalid signature");
});

it("authenticates status requests over the local socket and closes the connection", async () => {
  const token = "a".repeat(64),
    socket = path.join(directory, "control.sock");
  await writeFile(
    path.join(directory, "startup-session.json"),
    JSON.stringify({ socket, token, pid: 123 }),
    { mode: 0o600 },
  );
  const received: unknown[] = [];
  const server = createServer((client) => {
    client.once("data", (chunk) => {
      received.push(JSON.parse(chunk.toString()));
      client.end(
        JSON.stringify({ status: { connectionMode: "startup", pid: 123, phase: "attached" } }) +
          "\n",
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  try {
    const result = await startupRequest({ CLAUDE_IN_CODEX_DATA_DIR: directory }, "status");
    expect(result.phase).toBe("attached");
    expect(received).toEqual([{ command: "status", token }]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it.each([
  ["-c", "features.code_mode_host=true", "app-server", "--analytics-default-enabled"],
  ["app-server", "--listen", "stdio://"],
  ["app-server", "--listen=stdio://", "-c", "plugins.x.enabled=true"],
  ["app-server", "-c", "--listen=stdio://"],
])(
  "gives Desktop tool clients a private listener while preserving config arguments %j",
  (...args) => {
    const result = desktopOfficialListenerArguments(args, "/tmp/test/official.sock");
    expect(result.slice(-2)).toEqual(["--listen", "unix:///tmp/test/official.sock"]);
    expect(result).toContain("app-server");
    if (args.includes("-c"))
      expect(result.slice(result.indexOf("-c"), result.indexOf("-c") + 2)).toEqual(
        args.slice(args.indexOf("-c"), args.indexOf("-c") + 2),
      );
    expect(result.filter((value) => value === "--listen")).toHaveLength(1);
  },
);
