import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";

import {
  spkiSha256Base64,
  startDesktopBackendProxy,
  type DesktopBackendProxy,
} from "../src/desktop-backend-proxy.js";

interface Credentials {
  cert: string;
  key: string;
  pin: string;
}

function generateCredentials(directory: string): Credentials {
  const config = path.join(directory, "openssl.cnf");
  writeFileSync(
    config,
    [
      "[req]",
      "distinguished_name = dn",
      "x509_extensions = v3",
      "prompt = no",
      "[dn]",
      "CN = codexhost proxy test",
      "[v3]",
      "subjectAltName = IP:127.0.0.1,DNS:localhost",
      "basicConstraints = CA:TRUE",
      "",
    ].join("\n"),
  );
  const certPath = path.join(directory, "cert.pem");
  const keyPath = path.join(directory, "key.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:prime256v1",
      "-nodes",
      "-sha256",
      "-days",
      "2",
      "-config",
      config,
      "-keyout",
      keyPath,
      "-out",
      certPath,
    ],
    { stdio: "ignore" },
  );
  const key = readFileSync(keyPath, "utf8");
  return { cert: readFileSync(certPath, "utf8"), key, pin: spkiSha256Base64(key) };
}

interface Upstream {
  origin: string;
  port: number;
  server: https.Server;
  requests: { method: string; url: string; headers: IncomingHttpHeaders; body: Buffer }[];
  handler: (request: IncomingMessage, response: ServerResponse, body: Buffer) => void;
  close(): Promise<void>;
}

async function startUpstream(credentials: Credentials, port = 0): Promise<Upstream> {
  const upstream: Upstream = {
    origin: "",
    port: 0,
    server: https.createServer({ cert: credentials.cert, key: credentials.key }),
    requests: [],
    handler: (_request, response) => {
      response.writeHead(200, { "content-type": "application/json", "x-upstream": "yes" });
      response.end(JSON.stringify({ ok: true }));
    },
    close: () =>
      new Promise((resolve) => {
        upstream.server.close(() => resolve());
        upstream.server.closeAllConnections();
      }),
  };
  upstream.server.on("request", (request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks);
      upstream.requests.push({
        method: request.method ?? "",
        url: request.url ?? "",
        headers: request.headers,
        body,
      });
      upstream.handler(request, response, body);
    });
  });
  await new Promise<void>((resolve) => upstream.server.listen(port, "127.0.0.1", resolve));
  upstream.port = (upstream.server.address() as AddressInfo).port;
  upstream.origin = `https://127.0.0.1:${upstream.port}`;
  return upstream;
}

interface ClientResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
  chunks: Buffer[];
}

function request(
  credentials: Credentials,
  origin: string,
  input: {
    method?: string;
    path: string;
    headers?: Record<string, string>;
    body?: Buffer | Buffer[];
    onChunk?: (chunk: Buffer) => void;
  },
): Promise<ClientResponse> {
  const url = new URL(input.path, origin);
  return new Promise((resolve, reject) => {
    const client = https.request(
      {
        host: url.hostname,
        port: url.port,
        method: input.method ?? "GET",
        path: `${url.pathname}${url.search}`,
        headers: input.headers ?? {},
        ca: credentials.cert,
        servername: "localhost",
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => {
          chunks.push(chunk);
          input.onChunk?.(chunk);
        });
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks),
            chunks,
          }),
        );
        response.on("error", reject);
      },
    );
    client.on("error", reject);
    if (Array.isArray(input.body)) {
      for (const chunk of input.body) client.write(chunk);
      client.end();
    } else client.end(input.body);
  });
}

function environmentFor(
  dataDirectory: string,
  pin: string,
  extra: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  return { CODEXHOST_DATA_DIR: dataDirectory, CODEXHOST_DESKTOP_PROXY_SPKI: pin, ...extra };
}

describe("startDesktopBackendProxy", () => {
  let root: string;
  let credentials: Credentials;
  let dataDirectory: string;

  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), "codexhost-desktop-proxy-"));
    credentials = generateCredentials(root);
    dataDirectory = path.join(root, "data");
    const proxyDirectory = path.join(dataDirectory, "desktop-proxy");
    mkdirSync(proxyDirectory, { recursive: true });
    writeFileSync(path.join(proxyDirectory, "cert.pem"), credentials.cert);
    writeFileSync(path.join(proxyDirectory, "key.pem"), credentials.key, { mode: 0o600 });
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  async function startProxy(
    upstream: Upstream,
    extra: NodeJS.ProcessEnv = {},
    options: Partial<Parameters<typeof startDesktopBackendProxy>[0]> = {},
  ): Promise<{ proxy: DesktopBackendProxy; diagnostics: PassThrough }> {
    const diagnostics = new PassThrough();
    const proxy = await startDesktopBackendProxy({
      environment: environmentFor(dataDirectory, credentials.pin, extra),
      diagnosticOutput: diagnostics,
      upstreamOrigin: upstream.origin,
      upstreamCertificateAuthority: credentials.cert,
      ...options,
    });
    if (!proxy) throw new Error("proxy did not start");
    return { proxy, diagnostics };
  }

  it("stays off without a launcher pin, a data directory, or when disabled", async () => {
    const diagnostics = new PassThrough();
    await expect(
      startDesktopBackendProxy({ environment: { CODEXHOST_DATA_DIR: dataDirectory } }),
    ).resolves.toBeNull();
    await expect(
      startDesktopBackendProxy({ environment: { CODEXHOST_DESKTOP_PROXY_SPKI: credentials.pin } }),
    ).resolves.toBeNull();
    await expect(
      startDesktopBackendProxy({
        environment: environmentFor(dataDirectory, credentials.pin, {
          CODEXHOST_DESKTOP_PROXY: "0",
        }),
        diagnosticOutput: diagnostics,
      }),
    ).resolves.toBeNull();
    expect(diagnostics.read()).toBeNull();
  });

  it("stays off when the local key does not hash to the launcher pin or is missing", async () => {
    const diagnostics = new PassThrough();
    await expect(
      startDesktopBackendProxy({
        environment: environmentFor(dataDirectory, "AAAA"),
        diagnosticOutput: diagnostics,
      }),
    ).resolves.toBeNull();
    expect(String(diagnostics.read())).toContain("does not match the launcher pin");
    const empty = mkdtempSync(path.join(root, "empty-"));
    const missing = new PassThrough();
    await expect(
      startDesktopBackendProxy({
        environment: environmentFor(empty, credentials.pin),
        diagnosticOutput: missing,
      }),
    ).resolves.toBeNull();
    expect(String(missing.read())).toContain("credentials unavailable");
  });

  it("forwards requests byte-for-byte with only the host rewritten", async () => {
    const upstream = await startUpstream(credentials);
    const { proxy } = await startProxy(upstream);
    try {
      expect(proxy.origin).toMatch(/^https:\/\/127\.0\.0\.1:\d+$/);
      expect(proxy.active).toBe(true);
      const response = await request(credentials, proxy.origin, {
        method: "POST",
        path: "/backend-api/wham/usage?probe=1&x=y",
        headers: {
          authorization: "Bearer secret-token",
          "content-type": "application/json",
          "oai-client-version": "26.915",
        },
        body: Buffer.from('{"hello":"world"}'),
      });
      expect(response.status).toBe(200);
      expect(response.headers["x-upstream"]).toBe("yes");
      expect(response.body.toString()).toBe('{"ok":true}');
      expect(upstream.requests).toHaveLength(1);
      const seen = upstream.requests[0]!;
      expect(seen.method).toBe("POST");
      expect(seen.url).toBe("/backend-api/wham/usage?probe=1&x=y");
      expect(seen.headers.host).toBe(`127.0.0.1:${upstream.port}`);
      expect(seen.headers.authorization).toBe("Bearer secret-token");
      expect(seen.headers["oai-client-version"]).toBe("26.915");
      expect(seen.headers["accept-encoding"]).toBeUndefined();
      expect(seen.body.toString()).toBe('{"hello":"world"}');
    } finally {
      await proxy.close();
      await upstream.close();
    }
  });

  it("streams server-sent events before the upstream response finishes", async () => {
    const upstream = await startUpstream(credentials);
    const release = Promise.withResolvers<void>();
    upstream.handler = (_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write("data: first\n\n");
      void release.promise.then(() => response.end("data: last\n\n"));
    };
    const { proxy } = await startProxy(upstream);
    try {
      const first = Promise.withResolvers<string>();
      const pending = request(credentials, proxy.origin, {
        path: "/backend-api/stream",
        onChunk: (chunk) => first.resolve(chunk.toString()),
      });
      expect(await first.promise).toBe("data: first\n\n");
      release.resolve();
      const response = await pending;
      expect(response.body.toString()).toBe("data: first\n\ndata: last\n\n");
      expect(response.headers["transfer-encoding"]).toBe("chunked");
    } finally {
      await proxy.close();
      await upstream.close();
    }
  });

  it("relays chunked request bodies", async () => {
    const upstream = await startUpstream(credentials);
    upstream.handler = (_request, response, body) => {
      response.writeHead(200);
      response.end(body);
    };
    const { proxy } = await startProxy(upstream);
    try {
      const response = await request(credentials, proxy.origin, {
        method: "POST",
        path: "/backend-api/echo",
        headers: { "transfer-encoding": "chunked" },
        body: [Buffer.from("one,"), Buffer.from("two,"), Buffer.from("three")],
      });
      expect(response.body.toString()).toBe("one,two,three");
      expect(upstream.requests[0]!.headers["transfer-encoding"]).toBe("chunked");
    } finally {
      await proxy.close();
      await upstream.close();
    }
  });

  it("answers 502 while the upstream is down and recovers afterwards", async () => {
    const upstream = await startUpstream(credentials);
    const { proxy } = await startProxy(upstream);
    try {
      await upstream.close();
      const failed = await request(credentials, proxy.origin, { path: "/backend-api/wham/usage" });
      expect(failed.status).toBe(502);
      expect(proxy.active).toBe(true);
      await new Promise<void>((resolve) =>
        upstream.server.listen(upstream.port, "127.0.0.1", resolve),
      );
      const recovered = await request(credentials, proxy.origin, {
        path: "/backend-api/wham/usage",
      });
      expect(recovered.status).toBe(200);
    } finally {
      await proxy.close();
      await upstream.close();
    }
  });

  it("proxies WebSocket upgrades", async () => {
    const upstream = await startUpstream(credentials);
    const sockets = new WebSocketServer({ server: upstream.server });
    sockets.on("connection", (socket) => {
      socket.on("message", (data) => socket.send(`echo:${String(data)}`));
    });
    const { proxy } = await startProxy(upstream);
    try {
      const socket = new WebSocket(`${proxy.origin.replace("https", "wss")}/backend-api/ws`, {
        ca: credentials.cert,
        servername: "localhost",
      });
      await new Promise<void>((resolve, reject) => {
        socket.once("open", resolve);
        socket.once("error", reject);
      });
      const reply = new Promise<string>((resolve) =>
        socket.once("message", (d) => resolve(String(d))),
      );
      socket.send("ping");
      expect(await reply).toBe("echo:ping");
      socket.close();
    } finally {
      sockets.close();
      await proxy.close();
      await upstream.close();
    }
  });

  it("logs paths only, without queries, headers or bodies", async () => {
    const upstream = await startUpstream(credentials);
    const { proxy } = await startProxy(upstream, { CODEXHOST_DESKTOP_PROXY_TRACE: "1" });
    const logFile = path.join(dataDirectory, "desktop-proxy", "requests.jsonl");
    rmSync(logFile, { force: true });
    try {
      await request(credentials, proxy.origin, {
        method: "POST",
        path: "/backend-api/wham/usage?access_token=SECRET-QUERY#frag",
        headers: { authorization: "Bearer SECRET-HEADER" },
        body: Buffer.from("SECRET-BODY"),
      });
      const lines = readFileSync(logFile, "utf8").trim().split("\n");
      expect(lines).toHaveLength(1);
      const entry = JSON.parse(lines[0]!);
      expect(entry).toMatchObject({
        method: "POST",
        path: "/backend-api/wham/usage",
        status: 200,
        upgraded: false,
      });
      expect(typeof entry.durationMs).toBe("number");
      expect(entry.upstreamBytes).toBe('{"ok":true}'.length);
      expect(lines[0]).not.toMatch(/SECRET|authorization|\?/i);
      expect(statSync(logFile).mode & 0o777).toBe(0o600);
    } finally {
      await proxy.close();
      await upstream.close();
    }
  });

  it("does not log unless tracing is enabled", async () => {
    const upstream = await startUpstream(credentials);
    const { proxy } = await startProxy(upstream);
    const logFile = path.join(dataDirectory, "desktop-proxy", "requests.jsonl");
    rmSync(logFile, { force: true });
    try {
      await request(credentials, proxy.origin, { path: "/backend-api/wham/usage" });
      expect(() => statSync(logFile)).toThrow();
    } finally {
      await proxy.close();
      await upstream.close();
    }
  });

  it("rewrites only selected responses and fetches those uncompressed", async () => {
    const upstream = await startUpstream(credentials);
    upstream.handler = (request, response) => {
      response.writeHead(200, {
        "content-type": "application/json",
        "content-encoding": "identity",
      });
      response.end(JSON.stringify({ path: request.url, additional_rate_limits: [] }));
    };
    const rewrites: string[] = [];
    const { proxy } = await startProxy(
      upstream,
      {},
      {
        rewrite: {
          matches: ({ method, path: requestPath }) =>
            method === "GET" && requestPath === "/backend-api/wham/usage",
          rewrite: ({ status, headers, body }, request) => {
            rewrites.push(
              `${status} ${headers["content-type"]} ${request.language} ${request.path}`,
            );
            const parsed = JSON.parse(body.toString()) as { additional_rate_limits: unknown[] };
            if (parsed.additional_rate_limits.length > 0) return null;
            parsed.additional_rate_limits.push({ limit_name: "codexhost/claude-code-native" });
            return Buffer.from(JSON.stringify(parsed));
          },
        },
      },
    );
    try {
      const usage = await request(credentials, proxy.origin, {
        path: "/backend-api/wham/usage",
        headers: { "accept-encoding": "gzip, br", "accept-language": "zh-CN,zh;q=0.9" },
      });
      expect(usage.status).toBe(200);
      expect(JSON.parse(usage.body.toString())).toEqual({
        path: "/backend-api/wham/usage",
        additional_rate_limits: [{ limit_name: "codexhost/claude-code-native" }],
      });
      expect(usage.headers["content-length"]).toBe(String(usage.body.length));
      expect(usage.headers["content-encoding"]).toBeUndefined();
      expect(upstream.requests[0]!.headers["accept-encoding"]).toBe("identity");
      expect(rewrites).toEqual(["200 application/json zh-CN /backend-api/wham/usage"]);

      const other = await request(credentials, proxy.origin, {
        path: "/backend-api/other",
        headers: { "accept-encoding": "gzip, br" },
      });
      expect(JSON.parse(other.body.toString())).toEqual({
        path: "/backend-api/other",
        additional_rate_limits: [],
      });
      expect(upstream.requests[1]!.headers["accept-encoding"]).toBe("gzip, br");
      expect(rewrites).toHaveLength(1);
    } finally {
      await proxy.close();
      await upstream.close();
    }
  });

  it("sends the original bytes when the rewrite declines, throws, or the body is too large", async () => {
    const upstream = await startUpstream(credentials);
    let body = '{"additional_rate_limits":[{"limit_name":"existing"}]}';
    upstream.handler = (_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(body);
    };
    let mode: "decline" | "throw" = "decline";
    const { proxy } = await startProxy(
      upstream,
      {},
      {
        rewrite: {
          matches: () => true,
          maxBytes: 64,
          rewrite: () => {
            if (mode === "throw") throw new Error("boom");
            return null;
          },
        },
      },
    );
    try {
      const declined = await request(credentials, proxy.origin, {
        path: "/backend-api/wham/usage",
      });
      expect(declined.body.toString()).toBe(body);
      mode = "throw";
      const thrown = await request(credentials, proxy.origin, { path: "/backend-api/wham/usage" });
      expect(thrown.body.toString()).toBe(body);
      body = `{"padding":"${"x".repeat(200)}"}`;
      const large = await request(credentials, proxy.origin, { path: "/backend-api/wham/usage" });
      expect(large.body.toString()).toBe(body);
    } finally {
      await proxy.close();
      await upstream.close();
    }
  });

  it("reports inactive once closed", async () => {
    const upstream = await startUpstream(credentials);
    const { proxy, diagnostics } = await startProxy(upstream);
    expect(String(diagnostics.read())).toContain(`desktop proxy listening on ${proxy.origin}`);
    await proxy.close();
    expect(proxy.active).toBe(false);
    await expect(request(credentials, proxy.origin, { path: "/" })).rejects.toThrow();
    await upstream.close();
  });
});

// Keep the helper referenced for future permission-related assertions.
void chmodSync;
