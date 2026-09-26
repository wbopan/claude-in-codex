import { describe, expect, it, vi } from "vitest";

import { withSystemProxyEnvironment } from "../src/system-proxy-environment.js";

const scutilOutput = `<dictionary> {
  ExceptionsList : <array> {
    0 : 10.0.0.0/8
    1 : *.local
    2 : <local>
    3 : localhost
  }
  HTTPEnable : 1
  HTTPPort : 7890
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 7890
  HTTPSProxy : 127.0.0.1
  ProxyAutoConfigEnable : 0
  SOCKSEnable : 1
  SOCKSPort : 7891
  SOCKSProxy : ::1
}
`;

describe("System proxy environment", () => {
  it("fills missing proxy variables from the macOS system proxy", async () => {
    const result = await withSystemProxyEnvironment(
      { HOME: "/Users/example" },
      { platform: "darwin", readScutilProxy: async () => scutilOutput },
    );

    expect(result).toMatchObject({
      HOME: "/Users/example",
      HTTP_PROXY: "http://127.0.0.1:7890",
      http_proxy: "http://127.0.0.1:7890",
      HTTPS_PROXY: "http://127.0.0.1:7890",
      https_proxy: "http://127.0.0.1:7890",
      ALL_PROXY: "socks5://[::1]:7891",
      all_proxy: "socks5://[::1]:7891",
      NO_PROXY: "10.0.0.0/8,.local,localhost,127.0.0.1,::1",
      no_proxy: "10.0.0.0/8,.local,localhost,127.0.0.1,::1",
      NODE_USE_ENV_PROXY: "1",
    });
  });

  it("keeps explicit proxy variables and merges an explicit NO_PROXY", async () => {
    const result = await withSystemProxyEnvironment(
      { https_proxy: "http://explicit:3128", NO_PROXY: "corp.example" },
      { platform: "darwin", readScutilProxy: async () => scutilOutput },
    );

    expect(result).toMatchObject({
      HTTPS_PROXY: "http://explicit:3128",
      https_proxy: "http://explicit:3128",
      HTTP_PROXY: "http://127.0.0.1:7890",
      NO_PROXY: "corp.example,10.0.0.0/8,.local,localhost,127.0.0.1,::1",
    });
  });

  it("does not read the system proxy when every variable is explicit", async () => {
    const readScutilProxy = vi.fn(async () => scutilOutput);
    const environment = { HTTP_PROXY: "", HTTPS_PROXY: "", ALL_PROXY: "" };

    const result = await withSystemProxyEnvironment(environment, {
      platform: "darwin",
      readScutilProxy,
    });

    expect(result).toBe(environment);
    expect(readScutilProxy).not.toHaveBeenCalled();
  });

  it("leaves the environment alone without a usable static proxy", async () => {
    const environment = { HOME: "/Users/example" };
    const deps = (output: string | null) => ({
      platform: "darwin" as const,
      readScutilProxy: async () => output,
    });

    expect(await withSystemProxyEnvironment(environment, deps(null))).toBe(environment);
    expect(
      await withSystemProxyEnvironment(environment, deps("<dictionary> {\n  HTTPEnable : 0\n}\n")),
    ).toBe(environment);
    expect(
      await withSystemProxyEnvironment(
        environment,
        deps(scutilOutput.replace("ProxyAutoConfigEnable : 0", "ProxyAutoConfigEnable : 1")),
      ),
    ).toBe(environment);
    expect(
      await withSystemProxyEnvironment(environment, {
        platform: "linux",
        readScutilProxy: async () => scutilOutput,
      }),
    ).toBe(environment);
  });
});
