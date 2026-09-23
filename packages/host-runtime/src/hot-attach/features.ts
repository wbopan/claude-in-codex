import os from "node:os";
import path from "node:path";
import { readFile, stat } from "node:fs/promises";
import {
  idleReleaseSettings,
  resolveFeatures,
  type FeatureId,
  type FeatureSettings,
  type FeatureState,
} from "@claude-in-codex/shared-contracts";
import {
  readFeatureSettings,
  readFeatureSettingsSync,
  readMemorySyncResult,
  writeFeatureSetting,
  writeIdleReleaseMinutes,
} from "@claude-in-codex/shared-contracts/features-file";
import type { DesktopToolServerStatus } from "../official-desktop-tools.js";
import type { HotAttachSession } from "./session.js";

export interface FeatureReport extends FeatureState {
  /** A short sentence for the Dashboard when an enabled feature is not working. */
  problem: string | null;
  /** Idle release only: the minutes idle before release, kept while the switch is off. */
  timeoutMinutes?: number;
}

function reports(settings: FeatureSettings, problem: (state: FeatureState) => string | null) {
  return resolveFeatures(settings).map((state) => ({
    ...state,
    problem: problem(state),
    ...(state.id === "idleRelease" ? { timeoutMinutes: settings.idleReleaseTimeoutMinutes } : {}),
  }));
}

/** Listing the official servers opens an ephemeral native Thread; do it at most this often. */
const SERVER_LISTING_TTL_MS = 60_000;
const SERVER_LISTING_TIMEOUT_MS = 15_000;
/** Matches the cap of the Claude adapter's memory append. */
const MEMORY_SUMMARY_MAX_BYTES = 64 * 1024;
const COMPUTER_USE_PLUGIN = "unified-computer-use";
const COMPUTER_USE_TOOLS = ["js", "js_reset"];

type Servers = Map<string, DesktopToolServerStatus>;

/**
 * Whether `config.toml` enables a Codex plugin (`[plugins."<name>@<marketplace>"]`). A table
 * without `enabled` counts as enabled; a missing table does not. Not a TOML parser: only the
 * table headers and `enabled` lines Codex itself writes are read.
 */
export function codexPluginEnabled(config: string, name: string): boolean {
  let table: boolean | null = null;
  let enabled = false;
  const close = () => {
    if (table !== null) enabled ||= table;
  };
  for (const raw of config.split(/\r?\n/u)) {
    const line = raw.trim();
    if (line.startsWith("[")) {
      close();
      const header = /^\[\s*plugins\s*\.\s*"([^"]+)"\s*\]\s*(?:#.*)?$/u.exec(line);
      table = header?.[1]?.startsWith(`${name}@`) ? true : null;
      continue;
    }
    const value = /^enabled\s*=\s*(true|false)\s*(?:#.*)?$/u.exec(line);
    if (table !== null && value) table = value[1] === "true";
  }
  close();
  return enabled;
}

async function computerUsePluginEnabled(codexHome: string): Promise<boolean | null> {
  try {
    return codexPluginEnabled(
      await readFile(path.join(codexHome, "config.toml"), "utf8"),
      COMPUTER_USE_PLUGIN,
    );
  } catch {
    return null;
  }
}

async function memorySummaryProblem(codexHome: string): Promise<string | null> {
  const file = path.join(codexHome, "memories", "memory_summary.md");
  try {
    const metadata = await stat(file);
    if (metadata.size > MEMORY_SUMMARY_MAX_BYTES)
      return "Codex 的记忆摘要超过 64 KB，只会注入前 64 KB";
    if ((await readFile(file, "utf8")).trim().length === 0) return "Codex 的记忆摘要是空的";
    return null;
  } catch (error) {
    return (error as { code?: string }).code === "ENOENT"
      ? "Codex 还没有生成记忆摘要"
      : "无法读取 Codex 的记忆摘要";
  }
}

function codexAppToolsProblem(servers: Servers): string | null {
  const server = servers.get("codex_app");
  if (server?.error) return "Codex App 工具加载失败，查看诊断日志了解原因";
  return server?.tools?.length ? null : "Codex App 没有提供这组工具";
}

function computerUseProblem(servers: Servers | null, plugin: boolean | null): string | null {
  const server = servers?.get("cua_repl");
  if (!server && plugin === false) return "Codex 里没有启用 Computer Use 插件";
  if (!servers) return null;
  if (!server) return "Codex 没有加载 Computer Use 插件，重启 Codex App 后再试";
  if (server.error) return "Computer Use 工具加载失败，查看诊断日志了解原因";
  return COMPUTER_USE_TOOLS.every((tool) => server.tools?.includes(tool))
    ? null
    : "Computer Use 插件没有提供 js 工具";
}

/**
 * Feature switches with problem-only health. File checks run on every refresh; the official
 * server listing runs only while attached, at most once a minute, beside the status reply.
 */
export class FeatureHealth {
  #reports: FeatureReport[];
  #servers: { at: number; session: HotAttachSession; value: Servers | null } | undefined;
  #serversRead: Promise<void> | undefined;
  #logged = new Set<string>();

  constructor(
    private readonly options: {
      environment: NodeJS.ProcessEnv;
      changed?: () => void;
      log?: (message: string) => void;
    },
  ) {
    this.#reports = reports(readFeatureSettingsSync(options.environment), () => null);
  }

  status(): FeatureReport[] {
    return this.#reports.map((report) => ({ ...report }));
  }

  /** `deep` lists the official servers now, ignoring the cache. */
  async refresh(session: HotAttachSession | undefined, deep = false): Promise<void> {
    const environment = this.options.environment;
    const settings = await readFeatureSettings(environment);
    const enabled = (id: FeatureId) => settings[id];
    const attached = session?.attached === true;
    if (!attached || this.#servers?.session !== session) this.#servers = undefined;
    if (attached && (enabled("codexAppTools") || enabled("computerUse"))) {
      if (deep)
        await (this.#serversRead ?? Promise.resolve()).then(() => this.#readServers(session));
      else if (!this.#servers || Date.now() - this.#servers.at > SERVER_LISTING_TTL_MS)
        this.#serversRead ??= this.#readServers(session).finally(() => {
          this.#serversRead = undefined;
          // Recompute with the fresh listing; the cache keeps this from listing again.
          void this.refresh(session)
            .then(() => this.options.changed?.())
            .catch(() => {});
        });
    }
    const codexHome = path.resolve(
      session?.hello.codexHome ?? environment.CODEX_HOME ?? path.join(os.homedir(), ".codex"),
    );
    const servers = this.#servers?.value ?? null;
    const problems: Record<FeatureId, () => Promise<string | null>> = {
      codexAppTools: async () => (servers ? codexAppToolsProblem(servers) : null),
      computerUse: async () =>
        computerUseProblem(servers, await computerUsePluginEnabled(codexHome)),
      codexMemory: () => memorySummaryProblem(codexHome),
      claudeMemorySync: async () =>
        (await readMemorySyncResult(environment))?.error
          ? "上次同步失败，查看诊断日志了解原因"
          : null,
      idleRelease: async () => null,
    };
    const found = new Map<FeatureId, string | null>();
    for (const state of resolveFeatures(settings))
      found.set(state.id, state.enabled ? await problems[state.id]().catch(() => null) : null);
    this.#reports = reports(settings, (state) => found.get(state.id) ?? null);
  }

  /** Writes the switch and applies what can change without a new Claude Session. */
  async set(id: FeatureId, enabled: boolean, session: HotAttachSession | undefined): Promise<void> {
    const settings = await writeFeatureSetting(id, enabled, this.options.environment);
    if (id === "idleRelease") session?.host.applyIdleRelease(idleReleaseSettings(settings));
    // A server switched back on gets a fresh listing instead of a stale problem.
    if ((id === "codexAppTools" || id === "computerUse") && enabled) this.#servers = undefined;
    await this.refresh(session);
  }

  /** Writes the idle release choice (0 is never) and applies it to the live Host. */
  async setIdleRelease(minutes: number, session: HotAttachSession | undefined): Promise<void> {
    const settings = await writeIdleReleaseMinutes(minutes, this.options.environment);
    session?.host.applyIdleRelease(idleReleaseSettings(settings));
    await this.refresh(session);
  }

  async #readServers(session: HotAttachSession): Promise<void> {
    let value: Servers | null;
    let timer: NodeJS.Timeout | undefined;
    try {
      value = await Promise.race([
        session.host.desktopToolServers(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error("Official MCP listing timed out")),
            SERVER_LISTING_TIMEOUT_MS,
          );
        }),
      ]);
      for (const [name, server] of value)
        if (server.error) this.#log(`Official MCP '${name}' reports: ${server.error}`);
    } catch (error) {
      // Unknown is not a problem: the next listing tries again.
      value = null;
      this.#log(
        `Official MCP listing failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      clearTimeout(timer);
    }
    this.#servers = { at: Date.now(), session, value };
  }

  /** Each distinct message once per process, so a refresh loop does not flood the log. */
  #log(message: string): void {
    if (this.#logged.has(message)) return;
    this.#logged.add(message);
    (this.options.log ?? ((line) => process.stderr.write(`${line}\n`)))(message);
  }
}
