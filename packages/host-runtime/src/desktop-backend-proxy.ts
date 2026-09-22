import { createHash, createPrivateKey, createPublicKey, X509Certificate } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import https from "node:https";
import { isIP, type AddressInfo } from "node:net";
import path from "node:path";
import type { Duplex, Writable } from "node:stream";

/**
 * Loopback HTTPS reverse proxy that the Desktop reaches through
 * `workspaceRouting.backendOrigin`. Phase A forwards every request byte-for-byte to the
 * real backend; response rewrites plug into `rewrite` (Phase B: `/backend-api/wham/usage`).
 *
 * Handshake with the launcher: it generates `<CODEXHOST_DATA_DIR>/desktop-proxy/{cert,key}.pem`,
 * passes the SPKI pin to Chromium (`--ignore-certificate-errors-spki-list`) and publishes the
 * same pin as `CODEXHOST_DESKTOP_PROXY_SPKI`. The proxy only starts when the local key hashes to
 * that pin, so the Desktop is never routed to an origin it would refuse.
 */
export interface DesktopBackendProxy {
  /** `https://127.0.0.1:<port>` — what `account/read` publishes as `backendOrigin`. */
  readonly origin: string;
  /** False once the listener is gone; `account/read` then falls open to the real origin. */
  readonly active: boolean;
  close(): Promise<void>;
}

export interface DesktopRewriteRequest {
  method: string;
  path: string;
  /** The Desktop's UI language (`OAI-Language`, else the first `Accept-Language` tag), if any. */
  language: string | null;
}

export interface DesktopBackendRewrite {
  /** Selected requests are fetched uncompressed and buffered (up to `maxBytes`) for `rewrite`. */
  matches(request: { method: string; path: string }): boolean;
  /** Returns the replacement body, or null to send the original bytes. */
  rewrite(
    response: { status: number; headers: IncomingHttpHeaders; body: Buffer },
    request: DesktopRewriteRequest,
  ): Buffer | null | Promise<Buffer | null>;
  /** Larger bodies stream through untouched. Defaults to 256 KiB. */
  maxBytes?: number;
}

export interface DesktopBackendProxyOptions {
  environment: NodeJS.ProcessEnv;
  diagnosticOutput?: Writable;
  /** Defaults to `https://chatgpt.com`. */
  upstreamOrigin?: string;
  /** Test hook: trust anchors for the upstream TLS connection. */
  upstreamCertificateAuthority?: string | Buffer;
  rewrite?: DesktopBackendRewrite;
}

export const DESKTOP_PROXY_ENV = "CODEXHOST_DESKTOP_PROXY";
export const DESKTOP_PROXY_SPKI_ENV = "CODEXHOST_DESKTOP_PROXY_SPKI";
export const DESKTOP_PROXY_TRACE_ENV = "CODEXHOST_DESKTOP_PROXY_TRACE";
export const DESKTOP_PROXY_DIRECTORY = "desktop-proxy";
const DEFAULT_REWRITE_MAX_BYTES = 256 * 1024;
const DEFAULT_UPSTREAM_ORIGIN = "https://chatgpt.com";
const REQUEST_LOG_ROTATE_BYTES = 5 * 1024 * 1024;
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "transfer-encoding",
]);

export function spkiSha256Base64(privateKeyPem: string | Buffer): string {
  const spki = createPublicKey(privateKeyPem).export({ type: "spki", format: "der" });
  return createHash("sha256").update(spki).digest("base64");
}

export function desktopProxyDirectory(dataDirectory: string): string {
  return path.join(path.resolve(dataDirectory), DESKTOP_PROXY_DIRECTORY);
}

function requestLogEnabled(environment: NodeJS.ProcessEnv): boolean {
  return (
    environment.CODEXHOST_STARTUP_TRACE === "1" || environment[DESKTOP_PROXY_TRACE_ENV] === "1"
  );
}

/** Query and fragment never reach the log: they can carry tokens. */
function loggablePath(url: string | undefined): string {
  const raw = url ?? "";
  const end = Math.min(...[raw.indexOf("?"), raw.indexOf("#")].filter((i) => i >= 0), raw.length);
  return raw.slice(0, end);
}

class RequestLog {
  readonly #file: string | undefined;

  constructor(directory: string, environment: NodeJS.ProcessEnv) {
    this.#file = requestLogEnabled(environment)
      ? path.join(directory, "requests.jsonl")
      : undefined;
  }

  append(entry: Record<string, string | number | boolean | null>): void {
    if (!this.#file) return;
    try {
      try {
        if (statSync(this.#file).size >= REQUEST_LOG_ROTATE_BYTES)
          renameSync(this.#file, `${this.#file}.1`);
      } catch {
        // First entry, or rotation is unavailable; keep appending.
      }
      appendFileSync(
        this.#file,
        `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`,
        {
          mode: 0o600,
        },
      );
    } catch {
      // Logging is diagnostic only.
    }
  }
}

function requestLanguage(headers: IncomingHttpHeaders): string | null {
  const explicit = headers["oai-language"];
  if (typeof explicit === "string" && explicit.trim()) return explicit.trim();
  const accept = headers["accept-language"];
  const first = typeof accept === "string" ? accept.split(",")[0]?.split(";")[0]?.trim() : "";
  return first ? first : null;
}

function errorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string")
    return error.code;
  return error instanceof Error ? error.name : "unknown";
}

function forwardedRequestHeaders(
  headers: IncomingHttpHeaders,
  upstreamHost: string,
  upgrade: boolean,
): IncomingHttpHeaders {
  const forwarded: IncomingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (name === "host") continue;
    if (!upgrade && HOP_BY_HOP_HEADERS.has(name)) continue;
    forwarded[name] = value;
  }
  forwarded.host = upstreamHost;
  return forwarded;
}

function forwardedResponseHeaders(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const forwarded: IncomingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || HOP_BY_HOP_HEADERS.has(name)) continue;
    forwarded[name] = value;
  }
  return forwarded;
}

interface LoadedCredentials {
  cert: Buffer;
  key: Buffer;
}

function loadPinnedCredentials(
  directory: string,
  pin: string,
  diagnose: (message: string) => void,
): LoadedCredentials | null {
  let cert: Buffer;
  let key: Buffer;
  try {
    cert = readFileSync(path.join(directory, "cert.pem"));
    key = readFileSync(path.join(directory, "key.pem"));
  } catch (error) {
    diagnose(`desktop proxy credentials unavailable (${errorCode(error)}); routing stays native`);
    return null;
  }
  try {
    if (spkiSha256Base64(key) !== pin) {
      diagnose("desktop proxy key does not match the launcher pin; routing stays native");
      return null;
    }
    if (!new X509Certificate(cert).checkPrivateKey(createPrivateKey(key))) {
      diagnose("desktop proxy certificate does not match its key; routing stays native");
      return null;
    }
  } catch (error) {
    diagnose(`desktop proxy credentials unreadable (${errorCode(error)}); routing stays native`);
    return null;
  }
  return { cert, key };
}

/**
 * Resolves to null (and never throws) whenever the proxy must stay off: disabled by
 * `CODEXHOST_DESKTOP_PROXY=0`, no launcher pin, no data directory, unreadable or mismatched
 * credentials, or a listener that fails to bind. Callers then leave `account/read` untouched.
 */
export async function startDesktopBackendProxy(
  options: DesktopBackendProxyOptions,
): Promise<DesktopBackendProxy | null> {
  const { environment } = options;
  const diagnose = (message: string): void => {
    options.diagnosticOutput?.write(`[codexhost] ${message}\n`);
  };
  if (environment[DESKTOP_PROXY_ENV] === "0") return null;
  const pin = environment[DESKTOP_PROXY_SPKI_ENV];
  const dataDirectory = environment.CODEXHOST_DATA_DIR;
  if (!pin || !dataDirectory) return null;
  const directory = desktopProxyDirectory(dataDirectory);
  const credentials = loadPinnedCredentials(directory, pin, diagnose);
  if (!credentials) return null;

  const upstream = new URL(options.upstreamOrigin ?? DEFAULT_UPSTREAM_ORIGIN);
  const upstreamHost = upstream.host;
  const upstreamPort = upstream.port ? Number(upstream.port) : 443;
  // SNI carries the real backend name; TLS forbids it for a literal IP (tests).
  const upstreamServername = isIP(upstream.hostname) ? undefined : upstream.hostname;
  const agent = new https.Agent({
    keepAlive: true,
    ...(options.upstreamCertificateAuthority ? { ca: options.upstreamCertificateAuthority } : {}),
  });
  const log = new RequestLog(directory, environment);
  const rewrite = options.rewrite;
  const rewriteMaxBytes = rewrite?.maxBytes ?? DEFAULT_REWRITE_MAX_BYTES;

  const upstreamRequest = (
    request: IncomingMessage,
    headers: IncomingHttpHeaders,
  ): ReturnType<typeof https.request> =>
    https.request({
      host: upstream.hostname,
      port: upstreamPort,
      ...(upstreamServername ? { servername: upstreamServername } : {}),
      method: request.method,
      path: request.url,
      headers,
      agent,
    });

  const handleRequest = (request: IncomingMessage, response: ServerResponse): void => {
    const startedAt = Date.now();
    const method = request.method ?? "GET";
    const entry = { method, path: loggablePath(request.url) };
    const rewriting = rewrite?.matches({ method, path: entry.path }) === true;
    const rewriteRequest: DesktopRewriteRequest = {
      ...entry,
      language: requestLanguage(request.headers),
    };
    const headers = forwardedRequestHeaders(request.headers, upstreamHost, false);
    if (rewriting) headers["accept-encoding"] = "identity";
    let upstreamBytes = 0;
    const finish = (status: number | null, error?: unknown): void => {
      log.append({
        ...entry,
        status,
        durationMs: Date.now() - startedAt,
        upstreamBytes,
        upgraded: false,
        // The UI language is the one request detail a rewrite depends on; nothing else is kept.
        ...(rewriting ? { language: rewriteRequest.language } : {}),
        ...(error !== undefined ? { error: errorCode(error) } : {}),
      });
    };
    const proxied = upstreamRequest(request, headers);
    proxied.on("error", (error) => {
      if (response.headersSent) response.destroy();
      else {
        response.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
        response.end("codexhost desktop proxy: upstream unavailable");
      }
      finish(null, error);
    });
    proxied.on("response", (upstreamResponse) => {
      const status = upstreamResponse.statusCode ?? 502;
      const responseHeaders = forwardedResponseHeaders(upstreamResponse.headers);
      upstreamResponse.on("data", (chunk: Buffer) => {
        upstreamBytes += chunk.length;
      });
      upstreamResponse.on("error", (error) => {
        response.destroy();
        finish(status, error);
      });
      const stream = (): void => {
        response.writeHead(status, responseHeaders);
        upstreamResponse.pipe(response);
        upstreamResponse.on("end", () => finish(status));
      };
      const declaredLength = Number(upstreamResponse.headers["content-length"] ?? -1);
      if (!rewriting || !rewrite || declaredLength > rewriteMaxBytes) {
        stream();
        return;
      }
      const chunks: Buffer[] = [];
      let buffered = 0;
      let passedThrough = false;
      upstreamResponse.on("data", (chunk: Buffer) => {
        if (passedThrough) return;
        chunks.push(chunk);
        buffered += chunk.length;
        if (buffered > rewriteMaxBytes) {
          passedThrough = true;
          response.writeHead(status, responseHeaders);
          for (const held of chunks) response.write(held);
          upstreamResponse.pipe(response);
          upstreamResponse.on("end", () => finish(status));
        }
      });
      upstreamResponse.on("end", () => {
        if (passedThrough) return;
        const body = Buffer.concat(chunks);
        void Promise.resolve()
          .then(() =>
            rewrite.rewrite({ status, headers: upstreamResponse.headers, body }, rewriteRequest),
          )
          .catch(() => null)
          .then((rewritten) => {
            const payload = rewritten ?? body;
            const finalHeaders = { ...responseHeaders };
            if (rewritten) delete finalHeaders["content-encoding"];
            finalHeaders["content-length"] = String(payload.length);
            response.writeHead(status, finalHeaders);
            response.end(payload);
            finish(status);
          });
      });
    });
    request.on("error", () => proxied.destroy());
    response.on("close", () => {
      if (!response.writableFinished) proxied.destroy();
    });
    request.pipe(proxied);
  };

  const handleUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const startedAt = Date.now();
    const entry = { method: request.method ?? "GET", path: loggablePath(request.url) };
    const proxied = upstreamRequest(
      request,
      forwardedRequestHeaders(request.headers, upstreamHost, true),
    );
    const finish = (status: number | null, error?: unknown): void => {
      log.append({
        ...entry,
        status,
        durationMs: Date.now() - startedAt,
        upstreamBytes: 0,
        upgraded: status !== null && status < 300,
        ...(error !== undefined ? { error: errorCode(error) } : {}),
      });
    };
    proxied.on("error", (error) => {
      socket.destroy();
      finish(null, error);
    });
    proxied.on("response", (upstreamResponse) => {
      // The upstream declined to upgrade; relay its answer and close.
      const status = upstreamResponse.statusCode ?? 502;
      const lines = [`HTTP/1.1 ${status} ${upstreamResponse.statusMessage ?? ""}`];
      for (let i = 0; i < upstreamResponse.rawHeaders.length; i += 2)
        lines.push(`${upstreamResponse.rawHeaders[i]}: ${upstreamResponse.rawHeaders[i + 1]}`);
      socket.write(`${lines.join("\r\n")}\r\n\r\n`);
      upstreamResponse.pipe(socket);
      finish(status);
    });
    proxied.on("upgrade", (upstreamResponse, upstreamSocket, upstreamHead) => {
      const lines = [`HTTP/1.1 ${upstreamResponse.statusCode ?? 101} Switching Protocols`];
      for (let i = 0; i < upstreamResponse.rawHeaders.length; i += 2)
        lines.push(`${upstreamResponse.rawHeaders[i]}: ${upstreamResponse.rawHeaders[i + 1]}`);
      socket.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (upstreamHead.length > 0) socket.write(upstreamHead);
      if (head.length > 0) upstreamSocket.write(head);
      upstreamSocket.pipe(socket).pipe(upstreamSocket);
      socket.on("error", () => upstreamSocket.destroy());
      upstreamSocket.on("error", () => socket.destroy());
      finish(upstreamResponse.statusCode ?? 101);
    });
    socket.on("error", () => proxied.destroy());
    proxied.end();
  };

  const server = https.createServer(
    { cert: credentials.cert, key: credentials.key, ALPNProtocols: ["http/1.1"] },
    handleRequest,
  );
  server.on("upgrade", handleUpgrade);
  server.on("clientError", (error, socket) => {
    diagnose(`desktop proxy client error (${errorCode(error)})`);
    socket.destroy();
  });
  server.on("tlsClientError", (error) => {
    diagnose(`desktop proxy TLS client error (${errorCode(error)})`);
  });
  // Streaming responses (SSE, long tool turns) must never be cut by a server-side clock.
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;

  let listening = false;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    listening = true;
  } catch (error) {
    diagnose(`desktop proxy failed to listen (${errorCode(error)}); routing stays native`);
    agent.destroy();
    return null;
  }
  server.on("error", (error) => {
    listening = false;
    diagnose(`desktop proxy listener failed (${errorCode(error)}); routing falls open`);
  });
  server.on("close", () => {
    listening = false;
  });
  const { port } = server.address() as AddressInfo;
  const origin = `https://127.0.0.1:${port}`;
  diagnose(`desktop proxy listening on ${origin} for ${upstream.origin}`);
  return {
    origin,
    get active() {
      return listening;
    },
    async close() {
      listening = false;
      agent.destroy();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}
