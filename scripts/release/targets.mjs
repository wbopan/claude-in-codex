export const NODE_VERSION = "24.13.1";
export const NODE_DIST_BASE_URL = `https://nodejs.org/dist/v${NODE_VERSION}`;

export const RELEASE_TARGETS = Object.freeze({
  "macos-arm64": Object.freeze({
    id: "macos-arm64",
    hostPlatform: "darwin",
    rustTarget: "aarch64-apple-darwin",
    packageArchitecture: "arm64",
    executableSuffix: "",
    nodeArchive: `node-v${NODE_VERSION}-darwin-arm64.tar.gz`,
    nodeArchiveSha256: "8c039d59f2fec6195e4281ad5b0d02b9a940897b4df7b849c6fb48be6787bba6",
  }),
  "macos-x64": Object.freeze({
    id: "macos-x64",
    hostPlatform: "darwin",
    rustTarget: "x86_64-apple-darwin",
    packageArchitecture: "x64",
    executableSuffix: "",
    nodeArchive: `node-v${NODE_VERSION}-darwin-x64.tar.gz`,
    nodeArchiveSha256: "527f0578d9812e7dfa225121bda0b1546a6a0e4b5f556295fc8299c272de5fbf",
  }),
  "linux-x64": Object.freeze({
    id: "linux-x64",
    hostPlatform: "linux",
    rustTarget: "x86_64-unknown-linux-gnu",
    packageArchitecture: "x64",
    executableSuffix: "",
  }),
  "linux-arm64": Object.freeze({
    id: "linux-arm64",
    hostPlatform: "linux",
    rustTarget: "aarch64-unknown-linux-gnu",
    packageArchitecture: "arm64",
    executableSuffix: "",
  }),
});

export function supportedReleaseTargets() {
  return Object.keys(RELEASE_TARGETS);
}

export function releaseTarget(name) {
  if (!Object.hasOwn(RELEASE_TARGETS, name)) {
    throw new Error(
      `unknown release target '${name}'; expected one of: ${supportedReleaseTargets().join(", ")}`,
    );
  }
  return RELEASE_TARGETS[name];
}

export function releaseTargetForHost(name, hostPlatform = process.platform) {
  const target = releaseTarget(name);
  if (target.hostPlatform !== hostPlatform) {
    throw new Error(
      `release target '${name}' requires host platform '${target.hostPlatform}', current host is '${hostPlatform}'`,
    );
  }
  return target;
}

export function hostReleaseTargetId(platform = process.platform, arch = process.arch) {
  if (platform === "darwin" && arch === "arm64") return "macos-arm64";
  if (platform === "darwin" && arch === "x64") return "macos-x64";
  if (platform === "linux" && arch === "x64") return "linux-x64";
  if (platform === "linux" && arch === "arm64") return "linux-arm64";
  throw new Error(`unsupported npm release host: ${platform}/${arch}`);
}

export function hostReleaseTarget(platform = process.platform, arch = process.arch) {
  return releaseTarget(hostReleaseTargetId(platform, arch));
}

export function npmReleaseUsage() {
  return [
    "usage: npm run release:npm -- [--target <target>] [--version <semver>] [--pack] [--skip-build]",
    `targets: ${supportedReleaseTargets().join(", ")} (default: current host)`,
  ].join("\n");
}
