import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import type { Socket } from "node:net";
import type { JsonObject } from "@claude-in-codex/protocol-core";
import { AppServerHost } from "../app-server-host.js";
import { OfficialRuntimeScope } from "../codex-runtime/official-runtime-scope.js";
import { DesktopUsagePublisher, desktopUiLanguage } from "../desktop-usage-buckets.js";
import { codexUsageMeters, type UsageMeter } from "./usage-meters.js";
import { installedHarnessPluginOptions } from "../installed-harness-plugins.js";
import { BorrowedDesktopBackend } from "./borrowed-backend.js";
import {
  currentCodexAccountFromOfficialRead,
  SingleNativeCodexAccount,
} from "../account/codex-account-control.js";
import type { OfficialClientSession } from "../codex-runtime/official-runtime-owner.js";

export interface DesktopHello {
  type: "hello";
  token: string;
  pid: number;
  backendPid: number;
  codexHome: string;
  cliPath: string;
  appVersion: string;
}

export class HotAttachSession extends EventEmitter {
  readonly host: AppServerHost;
  readonly done: Promise<number>;
  readonly ready = Promise.withResolvers<void>();
  readonly detached = Promise.withResolvers<void>();
  readonly #input = new PassThrough();
  readonly #backend: BorrowedDesktopBackend;
  readonly #scope: OfficialRuntimeScope;
  readonly #usage: DesktopUsagePublisher;
  /** The Codex windows from the Desktop's latest `/wham/usage` poll. */
  codexUsage: { meters: UsageMeter[]; observedAt: string } | null = null;
  #closing: Promise<void> | undefined;
  #heartbeat: NodeJS.Timeout;
  #buffer = "";
  #pending = 0;
  readonly #requests = new Set<string>();
  #identityReader: OfficialClientSession | undefined;
  #refreshIdentity: () => Promise<unknown>;
  attached = false;

  constructor(
    readonly hello: DesktopHello,
    private readonly socket: Socket,
    input: {
      environment: NodeJS.ProcessEnv;
      hostRuntimeUrl: string;
      stockCodexPath: string;
    },
  ) {
    super();
    void this.ready.promise.catch(() => {});
    const send = (value: Record<string, unknown>): void => this.send(value);
    this.#backend = new BorrowedDesktopBackend(hello.backendPid, send);
    this.#scope = new OfficialRuntimeScope({
      permanentHome: hello.codexHome,
      diagnosticOutput: process.stderr,
      createBackend: () => this.#backend,
    });
    let current: ReturnType<typeof currentCodexAccountFromOfficialRead> = null;
    const snapshot = () => ({
      version: 2 as const,
      currentAccountId: current?.accountId ?? null,
      phase: this.#scope.gate.phase,
      revision: this.#scope.gate.revision,
      accounts: current ? [current] : [],
    });
    const accountControl = new SingleNativeCodexAccount(snapshot, async () => {
      if (!this.#identityReader) return snapshot();
      const response = await this.#scope.owner.controlRequest("account/read", {
        refreshToken: false,
      });
      if (response.error) throw new Error("Official Account read failed");
      current = currentCodexAccountFromOfficialRead(response.result);
      return snapshot();
    });
    this.#refreshIdentity = async () => {
      // The Desktop client must open first: it owns unsolicited native notifications.
      const reader = this.#scope.owner.attachManagement(async () => {});
      await reader.initialize({
        clientInfo: { name: "claude_in_codex_identity_reader", version: "1" },
        capabilities: { experimentalApi: true },
      });
      this.#identityReader = reader;
      await accountControl.refresh?.();
    };
    const output = new Writable({
      write: (chunk, _encoding, callback) => {
        try {
          this.#buffer += chunk.toString();
          let end: number;
          while ((end = this.#buffer.indexOf("\n")) >= 0) {
            const line = this.#buffer.slice(0, end);
            this.#buffer = this.#buffer.slice(end + 1);
            if (!line) continue;
            const message = JSON.parse(line);
            if (message.id !== undefined && !message.method)
              this.#requests.delete(String(message.id));
            if (message.id === "claude-in-codex:attach:init") {
              if (message.error) this.ready.reject(new Error(message.error.message));
              else this.send({ type: "activate" });
            } else this.send({ type: "desktop", message });
          }
          callback();
        } catch (error) {
          callback(error instanceof Error ? error : new Error(String(error)));
        }
      },
    });
    const environment = { ...input.environment, CODEX_HOME: hello.codexHome };
    this.#usage = new DesktopUsagePublisher({ language: desktopUiLanguage(environment) });
    this.host = new AppServerHost({
      stockCodexPath: input.stockCodexPath,
      arguments: [],
      defaultAgent: "codex",
      environment,
      desktopInput: this.#input,
      desktopOutput: output,
      desktopUsage: this.#usage,
      officialRuntimeScope: this.#scope,
      accountControl,
      ...installedHarnessPluginOptions(environment, false, input.hostRuntimeUrl),
    });
    this.done = this.host.run();
    void this.done.then(
      (code) => {
        if (!this.#closing) {
          this.ready.reject(new Error(`Host stopped unexpectedly (${code})`));
          socket.destroy();
        }
        this.emit("ended", code);
      },
      (error: unknown) => {
        this.ready.reject(error);
        this.emit("failed", error);
        socket.destroy();
      },
    );
    this.#input.write(
      JSON.stringify({
        id: "claude-in-codex:attach:init",
        method: "initialize",
        params: {
          clientInfo: { name: "claude_in_codex_hot_attach", version: "1" },
          capabilities: { experimentalApi: true },
        },
      }) + "\n",
    );
    this.#heartbeat = setInterval(() => {
      this.send({ type: "heartbeat", activeExternal: this.host.attachmentState().activeExternal });
      this.emit("state");
    }, 1000);
    socket.once("close", () => {
      this.detached.resolve();
      void this.close(false).catch((error: unknown) => this.emit("failed", error));
    });
  }

  send(value: Record<string, unknown>): void {
    if (this.socket.destroyed) return;
    if (this.socket.writableLength > 32 * 1024 * 1024) {
      this.socket.destroy();
      return;
    }
    this.socket.write(`${JSON.stringify(value)}\n`);
  }
  receive(value: Record<string, unknown>): void {
    if (value.type === "usage" && typeof value.body === "string") {
      try {
        const meters = codexUsageMeters(JSON.parse(value.body));
        if (meters.length > 0) this.codexUsage = { meters, observedAt: new Date().toISOString() };
      } catch {
        // Only the Desktop's own response shape is read; anything else keeps the last snapshot.
      }
      void this.#usage
        .rewrite({
          status: 200,
          headers: { "content-type": "application/json" },
          body: Buffer.from(value.body),
        })
        .then((body) =>
          this.send({ type: "usage", id: value.id, body: body?.toString("utf8") ?? null }),
        )
        .catch(() => this.send({ type: "usage", id: value.id, body: null }));
    } else if (value.type === "desktop") {
      const message = value.message as JsonObject;
      if (message.id !== undefined && typeof message.method === "string")
        this.#requests.add(String(message.id));
      this.#input.write(`${JSON.stringify(message)}\n`);
    } else if (value.type === "native" && typeof value.channel === "string")
      this.#backend.receive(value.channel, value.message as JsonObject);
    else if (value.type === "attached") {
      this.attached = true;
      this.ready.resolve();
      void this.#refreshIdentity().catch(() =>
        process.stderr.write("Codex Account identity could not be read\n"),
      );
      void this.#usage
        .warmup()
        .then(() => {
          if (this.attached && !this.#closing) this.send({ type: "usage-ready" });
        })
        .catch(() => {});
    } else if (value.type === "heartbeat") this.#pending = Number(value.pending) || 0;
    else if (value.type === "detached") {
      this.attached = false;
      this.detached.resolve();
    }
  }
  state() {
    return {
      ...this.host.attachmentState(),
      pending: this.#requests.size,
      desktopPending: this.#pending,
      attached: this.attached,
    };
  }
  close(notify = true): Promise<void> {
    return (this.#closing ??= (async () => {
      try {
        this.host.close();
        await this.done;
      } finally {
        let timer: NodeJS.Timeout | undefined;
        try {
          await this.#scope.close();
        } finally {
          try {
            this.#identityReader?.close();
            this.#usage.detach();
            if (notify) {
              this.send({ type: "detach", reason: "requested" });
              await Promise.race([
                this.detached.promise,
                new Promise<void>((resolve) => {
                  timer = setTimeout(resolve, 3000);
                }),
              ]);
            }
          } finally {
            clearTimeout(timer);
            clearInterval(this.#heartbeat);
            this.attached = false;
            this.socket.end();
          }
        }
      }
    })());
  }
}
