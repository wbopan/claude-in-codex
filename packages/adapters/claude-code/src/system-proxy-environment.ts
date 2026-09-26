import { execFile } from "node:child_process";

const SCUTIL = "/usr/sbin/scutil";
const SCUTIL_TIMEOUT_MS = 2_000;
const PROXY_PAIRS = [
  ["HTTP_PROXY", "http_proxy", "HTTP", "http"],
  ["HTTPS_PROXY", "https_proxy", "HTTPS", "http"],
  ["ALL_PROXY", "all_proxy", "SOCKS", "socks5"],
] as const;

interface SystemProxyDependencies {
  readonly platform?: NodeJS.Platform;
  readScutilProxy(): Promise<string | null>;
}

interface ParsedProxyDictionary {
  readonly values: ReadonlyMap<string, string>;
  readonly exceptions: readonly string[];
}

function parseScutilProxy(output: string): ParsedProxyDictionary {
  const values = new Map<string, string>();
  const exceptions: string[] = [];
  let inExceptions = false;
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (inExceptions) {
      if (trimmed === "}") {
        inExceptions = false;
        continue;
      }
      const entry = /^\d+ : (.+)$/u.exec(trimmed);
      if (entry?.[1]) exceptions.push(entry[1].trim());
      continue;
    }
    if (/^ExceptionsList : <array> \{$/u.test(trimmed)) {
      inExceptions = true;
      continue;
    }
    const pair = /^(\w+) : (.*)$/u.exec(trimmed);
    if (pair?.[1] && pair[2] !== undefined) values.set(pair[1], pair[2].trim());
  }
  return { values, exceptions };
}

function enabled(values: ReadonlyMap<string, string>, key: string): boolean {
  const value = Number(values.get(key));
  return Number.isInteger(value) && value !== 0;
}

function proxyUrl(
  values: ReadonlyMap<string, string>,
  prefix: string,
  scheme: string,
): string | undefined {
  if (!enabled(values, `${prefix}Enable`)) return undefined;
  const host = values.get(`${prefix}Proxy`)?.trim();
  const port = Number(values.get(`${prefix}Port`));
  if (!host || !Number.isInteger(port) || port < 1 || port > 65_535) return undefined;
  const authority = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `${scheme}://${authority}:${port}`;
}

function normalizeException(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "<local>") return undefined;
  return trimmed.startsWith("*.") ? trimmed.slice(1) : trimmed;
}

/**
 * GUI applications do not inherit proxy variables, and Claude Code ignores the
 * macOS system proxy unless it is exported. Mirrors the Rust shim's
 * `proxy_environment`: explicit variables always win, and missing ones are
 * filled from the static macOS proxy configuration. Read on every Claude Code
 * launch so a proxy switched on or off after Host startup takes effect.
 */
export async function withSystemProxyEnvironment(
  environment: NodeJS.ProcessEnv,
  dependencies?: SystemProxyDependencies,
): Promise<NodeJS.ProcessEnv> {
  const platform = dependencies?.platform ?? process.platform;
  if (platform !== "darwin") return environment;
  const missing = PROXY_PAIRS.some(
    ([upper, lower]) => environment[upper] === undefined && environment[lower] === undefined,
  );
  if (!missing) return environment;

  const output = await (dependencies?.readScutilProxy ?? readScutilProxy)();
  if (!output) return environment;
  const { values, exceptions } = parseScutilProxy(output);
  if (enabled(values, "ProxyAutoConfigEnable") || enabled(values, "ProxyAutoDiscoveryEnable")) {
    return environment;
  }

  const merged = { ...environment };
  let filled = false;
  for (const [upper, lower, prefix, scheme] of PROXY_PAIRS) {
    const explicit = merged[upper] ?? merged[lower];
    if (explicit !== undefined) {
      merged[upper] = explicit;
      merged[lower] = explicit;
      continue;
    }
    const system = proxyUrl(values, prefix, scheme);
    if (!system) continue;
    merged[upper] = system;
    merged[lower] = system;
    filled = true;
  }
  if (!filled) return environment;

  const seen = new Set<string>();
  const noProxy = [
    ...(merged.NO_PROXY ?? merged.no_proxy ?? "").split(","),
    ...exceptions.map((value) => normalizeException(value) ?? ""),
    "localhost",
    "127.0.0.1",
    "::1",
  ]
    .map((value) => value.trim())
    .filter((value) => {
      const key = value.toLowerCase();
      if (!value || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .join(",");
  merged.NO_PROXY = noProxy;
  merged.no_proxy = noProxy;
  merged.NODE_USE_ENV_PROXY ??= "1";
  return merged;
}

function readScutilProxy(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      SCUTIL,
      ["--proxy"],
      { encoding: "utf8", timeout: SCUTIL_TIMEOUT_MS, windowsHide: true },
      (error, stdout) => resolve(error ? null : stdout),
    );
  });
}
