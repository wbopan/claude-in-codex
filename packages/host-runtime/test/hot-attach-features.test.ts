import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { tempDir } from "../../../tests/helpers/temp-dir.js";
import { HotAttachController } from "../src/hot-attach/controller.js";
import { FeatureHealth, codexPluginEnabled } from "../src/hot-attach/features.js";
import type { HotAttachSession } from "../src/hot-attach/session.js";
import type { DesktopToolServerStatus } from "../src/official-desktop-tools.js";

const PLUGIN_ON = '[plugins."unified-computer-use@openai-bundled"]\nenabled = true\n';

let directory: string;
let codexHome: string;
let dataDirectory: string;
let environment: NodeJS.ProcessEnv;
beforeEach(async () => {
  directory = await tempDir("claude-in-codex-feature-health-");
  codexHome = path.join(directory, "codex");
  await mkdir(path.join(codexHome, "memories"), { recursive: true });
  await writeFile(path.join(codexHome, "memories", "memory_summary.md"), "Likes tea.\n");
  await writeFile(path.join(codexHome, "config.toml"), PLUGIN_ON);
  dataDirectory = path.join(directory, "data");
  environment = { CLAUDE_IN_CODEX_DATA_DIR: dataDirectory, CODEX_HOME: codexHome };
});

function session(servers: Record<string, DesktopToolServerStatus>) {
  const desktopToolServers = vi.fn(async () => new Map(Object.entries(servers)));
  const applyIdleRelease = vi.fn();
  const value = {
    attached: true,
    hello: { codexHome },
    host: { desktopToolServers, applyIdleRelease },
  } as unknown as HotAttachSession;
  return { value, desktopToolServers, applyIdleRelease };
}

const problems = (health: FeatureHealth) =>
  Object.fromEntries(health.status().map((feature) => [feature.id, feature.problem]));

describe("Codex plugin switch in config.toml", () => {
  it("reads the plugin table Codex writes", () => {
    expect(codexPluginEnabled(PLUGIN_ON, "unified-computer-use")).toBe(true);
    expect(codexPluginEnabled(PLUGIN_ON, "computer-use")).toBe(false);
    expect(
      codexPluginEnabled(
        '[plugins."unified-computer-use@openai-bundled"]\nenabled = false\n[other]\nenabled = true\n',
        "unified-computer-use",
      ),
    ).toBe(false);
    expect(
      codexPluginEnabled('[plugins."unified-computer-use@local"]\n', "unified-computer-use"),
    ).toBe(true);
    expect(codexPluginEnabled('model = "gpt"\n', "unified-computer-use")).toBe(false);
  });
});

describe("feature problems", () => {
  it("reports file problems while detached and only for enabled features", async () => {
    const health = new FeatureHealth({ environment });
    await health.refresh(undefined);
    expect(problems(health)).toEqual({
      codexAppTools: null,
      computerUse: null,
      codexMemory: null,
      claudeMemorySync: null,
      idleRelease: null,
    });

    await writeFile(path.join(codexHome, "config.toml"), "");
    await rm(path.join(codexHome, "memories", "memory_summary.md"));
    await mkdir(dataDirectory, { recursive: true });
    await writeFile(
      path.join(dataDirectory, "claude-memory-sync.json"),
      JSON.stringify({ at: "2026-09-23T00:00:00Z", written: 0, removed: 0, error: "EACCES" }),
    );
    await health.refresh(undefined);
    expect(problems(health)).toMatchObject({
      computerUse: "The Computer Use plugin is not enabled in Codex",
      codexMemory: "Codex has not written a memory summary yet",
      claudeMemorySync: "The last sync failed. The diagnostic log says why",
    });

    await writeFile(path.join(codexHome, "memories", "memory_summary.md"), "x".repeat(65 * 1024));
    await health.set("claudeMemorySync", false, undefined);
    expect(problems(health)).toMatchObject({
      codexMemory: "Codex's memory summary exceeds 64 KB, so only the first 64 KB is added",
      claudeMemorySync: null,
    });
  });

  it("lists the official servers while attached, at most once a minute unless deep", async () => {
    const changed = vi.fn();
    const health = new FeatureHealth({ environment, changed, log: () => {} });
    const attached = session({
      cua_repl: { tools: ["js", "turn_ended"], error: null },
    });
    await health.refresh(attached.value);
    await vi.waitFor(() =>
      expect(problems(health)).toMatchObject({
        codexAppTools: "The Codex App does not provide these tools",
        computerUse: "The Computer Use plugin does not provide the js tool",
      }),
    );
    expect(changed).toHaveBeenCalled();
    await health.refresh(attached.value);
    expect(attached.desktopToolServers).toHaveBeenCalledTimes(1);

    attached.desktopToolServers.mockResolvedValue(
      new Map([
        ["codex_app", { tools: null, error: "Codex app tools pipe closed" }],
        ["cua_repl", { tools: ["js", "js_reset"], error: null }],
      ]),
    );
    await health.refresh(attached.value, true);
    expect(attached.desktopToolServers).toHaveBeenCalledTimes(2);
    expect(problems(health)).toMatchObject({
      codexAppTools: "Codex App tools failed to load. The diagnostic log says why",
      computerUse: null,
    });
  });

  it("does not list servers when both tool features are off", async () => {
    await mkdir(dataDirectory, { recursive: true });
    await writeFile(
      path.join(dataDirectory, "features.json"),
      JSON.stringify({ codexAppTools: false, computerUse: false }),
    );
    const health = new FeatureHealth({ environment });
    const attached = session({});
    await health.refresh(attached.value, true);
    expect(attached.desktopToolServers).not.toHaveBeenCalled();
    expect(problems(health)).toMatchObject({ codexAppTools: null, computerUse: null });
  });

  it("applies idle release to the live Host", async () => {
    const health = new FeatureHealth({ environment });
    const attached = session({});
    await health.set("idleRelease", true, attached.value);
    expect(attached.applyIdleRelease).toHaveBeenCalledWith({ enabled: true, timeoutMinutes: 30 });
    await health.set("computerUse", false, attached.value);
    expect(health.status().find((feature) => feature.id === "computerUse")).toEqual({
      id: "computerUse",
      enabled: false,
      problem: null,
    });
  });

  it("stores the idle release choice as the switch plus its timeout", async () => {
    const health = new FeatureHealth({ environment });
    const attached = session({});
    const idleRelease = () => health.status().find((feature) => feature.id === "idleRelease");
    expect(idleRelease()).toEqual({
      id: "idleRelease",
      enabled: false,
      problem: null,
      timeoutMinutes: 30,
    });
    await health.setIdleRelease(15, attached.value);
    expect(attached.applyIdleRelease).toHaveBeenLastCalledWith({
      enabled: true,
      timeoutMinutes: 15,
    });
    expect(idleRelease()).toMatchObject({ enabled: true, timeoutMinutes: 15 });
    await health.setIdleRelease(0, attached.value);
    expect(attached.applyIdleRelease).toHaveBeenLastCalledWith({
      enabled: false,
      timeoutMinutes: 15,
    });
    expect(idleRelease()).toMatchObject({ enabled: false, timeoutMinutes: 15 });
  });
});

describe("menu bar controller features", () => {
  it("reports every feature while detached and persists a switch", async () => {
    const controller = new HotAttachController({
      appPath: path.join(directory, "Missing.app"),
      environment,
      hostRuntimeUrl: import.meta.url,
    });
    expect(controller.status().features).toEqual([
      { id: "codexAppTools", enabled: true, problem: null },
      { id: "computerUse", enabled: true, problem: null },
      { id: "codexMemory", enabled: true, problem: null },
      { id: "claudeMemorySync", enabled: true, problem: null },
      { id: "idleRelease", enabled: false, problem: null, timeoutMinutes: 30 },
    ]);
    await controller.setFeature("idleRelease", true);
    await controller.setFeature("codexAppTools", false);
    expect(
      JSON.parse(await readFile(path.join(dataDirectory, "features.json"), "utf8")),
    ).toMatchObject({ version: 1, idleRelease: true, codexAppTools: false });
    expect(
      controller
        .status()
        .features.filter((feature) => feature.enabled)
        .map((feature) => feature.id),
    ).toEqual(["computerUse", "codexMemory", "claudeMemorySync", "idleRelease"]);
    // A new controller starts from the file, before its first refresh.
    const next = new HotAttachController({
      appPath: path.join(directory, "Missing.app"),
      environment,
      hostRuntimeUrl: import.meta.url,
    });
    expect(next.status().features.at(-1)).toMatchObject({ id: "idleRelease", enabled: true });
  });
});
