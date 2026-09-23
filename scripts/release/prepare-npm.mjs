import { spawn, spawnSync } from "node:child_process";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { buildReleaseHostBundle } from "../../packages/host-runtime/scripts/build-release.mjs";
import {
  buildPreinstalledHarnessPlugins,
  preinstalledHarnessPluginPaths,
} from "./harness-plugins.mjs";
import { hostReleaseTarget, npmReleaseUsage, releaseTargetForHost } from "./targets.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");

export const NPM_PACKAGE_NAME = "@claude-in-codex/cli";
export const NPM_PLATFORM_PACKAGE_NAMES = Object.freeze({
  "macos-arm64": "@claude-in-codex/cli-darwin-arm64",
  "macos-x64": "@claude-in-codex/cli-darwin-x64",
  "linux-x64": "@claude-in-codex/cli-linux-x64",
  "linux-arm64": "@claude-in-codex/cli-linux-arm64",
});
export const NPM_RUNTIME_PLATFORM_PACKAGES = Object.freeze({
  "darwin-arm64": NPM_PLATFORM_PACKAGE_NAMES["macos-arm64"],
  "darwin-x64": NPM_PLATFORM_PACKAGE_NAMES["macos-x64"],
  "linux-x64": NPM_PLATFORM_PACKAGE_NAMES["linux-x64"],
  "linux-arm64": NPM_PLATFORM_PACKAGE_NAMES["linux-arm64"],
});
export const NPM_PACKAGE_DESCRIPTION =
  "Remote Host for Codex Desktop: run Claude Code as a first-class external harness on an SSH host.";

export function npmPlatformPackageName(target) {
  const packageName = NPM_PLATFORM_PACKAGE_NAMES[target.id];
  if (!packageName) throw new Error(`unsupported npm package target: ${target.id}`);
  return packageName;
}

/**
 * Every third-party package bundled into `app/host-runtime.mjs` or a preinstalled Harness plugin.
 * The build fails when a bundle audit reports a runtime package missing from this list, so the
 * notices always cover what the package actually ships.
 */
const runtimeLicenses = [
  {
    packageName: "@anthropic-ai/claude-agent-sdk",
    license: "SEE LICENSE IN README.md",
    source: "LICENSE.md",
    output: "Claude-Agent-SDK-LICENSE.md",
  },
  {
    packageName: "@hono/node-server",
    license: "MIT",
    source: "LICENSE",
    output: "hono-node-server-LICENSE.txt",
  },
  {
    packageName: "@modelcontextprotocol/sdk",
    license: "MIT",
    source: "LICENSE",
    output: "MCP-SDK-LICENSE.txt",
  },
  { packageName: "ajv", license: "MIT", source: "LICENSE", output: "ajv-LICENSE.txt" },
  {
    packageName: "ajv-formats",
    license: "MIT",
    source: "LICENSE",
    output: "ajv-formats-LICENSE.txt",
  },
  {
    packageName: "content-type",
    license: "MIT",
    source: "LICENSE",
    output: "content-type-LICENSE.txt",
  },
  { packageName: "diff", license: "BSD-3-Clause", source: "LICENSE", output: "diff-LICENSE.txt" },
  {
    packageName: "fast-deep-equal",
    license: "MIT",
    source: "LICENSE",
    output: "fast-deep-equal-LICENSE.txt",
  },
  {
    packageName: "fast-uri",
    license: "BSD-3-Clause",
    source: "LICENSE",
    output: "fast-uri-LICENSE.txt",
  },
  { packageName: "hono", license: "MIT", source: "LICENSE", output: "hono-LICENSE.txt" },
  {
    packageName: "json-schema-traverse",
    license: "MIT",
    source: "LICENSE",
    output: "json-schema-traverse-LICENSE.txt",
  },
  { packageName: "ws", license: "MIT", source: "LICENSE", output: "ws-LICENSE.txt" },
  { packageName: "zod", license: "MIT", source: "LICENSE", output: "zod-LICENSE.txt" },
  {
    packageName: "zod-to-json-schema",
    license: "ISC",
    source: "LICENSE",
    output: "zod-to-json-schema-LICENSE.txt",
  },
];

/** Fails when a bundle ships a runtime package whose license is not reviewed above. */
export function verifyShippedRuntimeLicenses(shippedPackages) {
  const reviewed = new Set(runtimeLicenses.map((dependency) => dependency.packageName));
  const unreviewed = [...new Set(shippedPackages)].filter((name) => !reviewed.has(name)).sort();
  if (unreviewed.length > 0) {
    throw new Error(`npm package ships runtime packages without notices: ${unreviewed.join(", ")}`);
  }
}

export function npmReleaseCommand(
  args,
  platform = process.platform,
  environment = process.env,
  nodePath = process.execPath,
) {
  if (platform !== "win32") return { command: "npm", args };
  const npmExecPath = environment.npm_execpath;
  if (!npmExecPath) {
    throw new Error("Windows release builds must be started through npm so npm_execpath is set");
  }
  return { command: nodePath, args: [npmExecPath, ...args] };
}

export function npmReleaseBuildCommands(
  target,
  platform = process.platform,
  environment = process.env,
  nodePath = process.execPath,
) {
  return [
    {
      label: "TypeScript build",
      ...npmReleaseCommand(["run", "build:typescript"], platform, environment, nodePath),
    },
    {
      label: "Rust release build",
      command: "cargo",
      args: [
        "build",
        "--release",
        "--locked",
        "--target",
        target.rustTarget,
        "--package",
        "claude-in-codex-shim",
        "--bin",
        "claude-in-codex-shim",
      ],
    },
  ];
}

export function npmPackCommand(
  platform = process.platform,
  environment = process.env,
  nodePath = process.execPath,
) {
  return npmReleaseCommand(["pack"], platform, environment, nodePath);
}

async function runCommand({ label, command, args }, cwd = repositoryRoot) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit", windowsHide: true });
    child.on("error", (error) => reject(new Error(`${label} could not start: ${error.message}`)));
    child.on("exit", (code, signal) => {
      if (code === 0) resolve();
      else
        reject(new Error(`${label} failed with ${signal ? `signal ${signal}` : `status ${code}`}`));
    });
  });
}

async function requireRegularFile(filePath, label) {
  const metadata = await lstat(filePath).catch((error) => {
    throw new Error(`${label} is unavailable: ${error.message}`);
  });
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`${label} is not a regular file: ${filePath}`);
  }
  return metadata;
}

async function copyReleaseFile(source, destination, label, executable = false) {
  await requireRegularFile(source, label);
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(source, destination);
  if (executable && process.platform !== "win32") await chmod(destination, 0o755);
}

function packageManifest(value, packageName) {
  if (
    typeof value !== "object" ||
    value === null ||
    typeof value.license !== "string" ||
    typeof value.version !== "string"
  ) {
    throw new Error(`runtime package '${packageName}' has invalid license metadata`);
  }
  return value;
}

export function npmPackageOs(target) {
  if (target.hostPlatform === "darwin") return ["darwin"];
  if (target.hostPlatform === "win32") return ["win32"];
  if (target.hostPlatform === "linux") return ["linux"];
  throw new Error(`unsupported npm package platform: ${target.hostPlatform}`);
}

export function npmPackageCpu(target) {
  const architecture = target.packageArchitecture ?? target.installerArchitecture;
  if (architecture === "arm64") return ["arm64"];
  if (architecture === "x64") return ["x64"];
  throw new Error(`unsupported npm package architecture: ${architecture}`);
}

export function expectedNpmPackagePaths(target) {
  return [
    "package.json",
    "README.md",
    `libexec/claude-in-codex-shim${target.executableSuffix}`,
    "app/host-runtime.mjs",
    ...preinstalledHarnessPluginPaths(),
    ...runtimeLicenses.map((dependency) => `licenses/${dependency.output}`),
    "licenses/opencodex-LICENSE.txt",
    "THIRD_PARTY_NOTICES.txt",
  ].sort();
}

export function createNpmPackageManifest({ version, target }) {
  return {
    name: npmPlatformPackageName(target),
    version,
    description: NPM_PACKAGE_DESCRIPTION,
    type: "module",
    files: ["libexec/**", "app/**", "licenses/**", "README.md", "THIRD_PARTY_NOTICES.txt"],
    engines: {
      node: ">=22",
    },
    os: npmPackageOs(target),
    cpu: npmPackageCpu(target),
    keywords: ["codex", "claude-in-codex", "claude-code", "agent", "harness", "ssh"],
    publishConfig: {
      access: "public",
    },
  };
}

export function createNpmBinLauncherSource({ version }) {
  return `#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const version = ${JSON.stringify(version)};
const userArguments = process.argv.slice(2);

function fail(message) {
  console.error(\`claude-in-codex: \${message}\`);
  process.exit(1);
}

if (
  userArguments.length === 1 &&
  (userArguments[0] === "--version" || userArguments[0] === "-v")
) {
  console.log(version);
  process.exit(0);
}
if (
  userArguments.length === 0 ||
  userArguments[0] === "--help" ||
  userArguments[0] === "-h"
) {
  console.log(
    [
      "usage:",
      "  claude-in-codex --version",
      "  claude-in-codex remote install|start|stop|status|uninstall [options]",
      "  claude-in-codex broker install|status|stop|uninstall [--harness <id>]",
      "",
      "Installs and manages the Remote Host that Codex Desktop reaches over SSH on",
      "this machine. It runs on the current Node.js runtime with the packaged Host",
      "Runtime and Shim. The local Host is the macOS menu bar app, not this package.",
    ].join("\\n"),
  );
  process.exit(0);
}
if (userArguments[0] !== "remote" && userArguments[0] !== "broker") {
  fail(\`unknown command '\${userArguments[0]}'. Run 'claude-in-codex --help' for usage.\`);
}

const platformPackages = ${JSON.stringify(NPM_RUNTIME_PLATFORM_PACKAGES, null, 2)};
const platformKey = \`\${process.platform}-\${process.arch}\`;
const platformPackage = platformPackages[platformKey];
if (!platformPackage) fail(\`unsupported platform '\${platformKey}'\`);

const require = createRequire(import.meta.url);
let packageRoot;
try {
  packageRoot = path.dirname(require.resolve(\`\${platformPackage}/package.json\`));
} catch {
  // Local folder installs symlink packages into the source tree; Node realpaths
  // the entry script, so the sibling platform package drops off the resolution
  // chain. Fall back to the npm global layout derived from the bin symlink.
  packageRoot = null;
  if (process.argv[1]) {
    const prefix = path.dirname(path.dirname(path.resolve(process.argv[1])));
    const globalPackage = path.join(
      prefix,
      "lib",
      "node_modules",
      platformPackage,
      "package.json",
    );
    if (existsSync(globalPackage)) packageRoot = path.dirname(globalPackage);
  }
  if (!packageRoot) {
    fail(
      \`missing optional platform package '\${platformPackage}'. Reinstall ${NPM_PACKAGE_NAME} without --omit=optional.\`,
    );
  }
}

const shim = path.join(packageRoot, "libexec", "claude-in-codex-shim");
const hostRuntime = path.join(packageRoot, "app", "host-runtime.mjs");
for (const [label, filePath] of [
  ["shim", shim],
  ["host runtime", hostRuntime],
]) {
  if (!existsSync(filePath)) fail(\`missing \${label}: \${filePath}\`);
}

function run(command, arguments_, options, next) {
  const child = spawn(command, arguments_, { env: process.env, windowsHide: true, ...options });
  child.on("error", (error) => fail(error.message));
  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    if (code === 0 && next) {
      next();
      return;
    }
    process.exit(code ?? 1);
  });
}

// The Shim manages the per-Harness native broker LaunchAgent (macOS only).
function runBroker(brokerArguments, stdio = "inherit") {
  run(
    shim,
    [
      "--claude-in-codex-broker",
      ...brokerArguments,
      "--node",
      process.execPath,
      "--host-runtime",
      hostRuntime,
    ],
    { stdio },
  );
}

if (userArguments[0] === "broker") {
  runBroker(userArguments.slice(1));
} else {
  const remoteArguments = userArguments.slice(1);
  const brokerCommand =
    process.platform === "darwin" &&
    ["install", "status", "uninstall"].includes(remoteArguments[0])
      ? remoteArguments[0]
      : null;
  run(
    process.execPath,
    [
      hostRuntime,
      "--claude-in-codex-remote",
      ...remoteArguments,
      "--node",
      process.execPath,
      "--shim",
      shim,
      "--host-runtime",
      hostRuntime,
    ],
    { stdio: "inherit" },
    brokerCommand
      ? () =>
          // remote status is a stable JSON stdout surface. Keep the broker's
          // human-readable status beside it on stderr instead of corrupting JSON.
          runBroker(
            [brokerCommand],
            brokerCommand === "status" ? ["inherit", process.stderr, "inherit"] : "inherit",
          )
      : undefined,
  );
}
`;
}

export function createNpmReadme({ version, target }) {
  const packageName = npmPlatformPackageName(target);
  return `# ${packageName}

${NPM_PACKAGE_DESCRIPTION}

> Internal platform package for \`${NPM_PACKAGE_NAME}\`, built for \`${target.id}\`.

## Install

\`\`\`bash
npm install -g ${NPM_PACKAGE_NAME}@${version}
\`\`\`

Do not install this package directly. npm selects it through the optional dependencies of \`${NPM_PACKAGE_NAME}\`.

This package is platform-specific (\`os=${npmPackageOs(target).join(",")}\`, \`cpu=${npmPackageCpu(target).join(",")}\`).

## Usage

\`\`\`bash
claude-in-codex --version
claude-in-codex remote install
claude-in-codex remote start
claude-in-codex remote stop
claude-in-codex remote status
claude-in-codex remote uninstall
claude-in-codex broker status
\`\`\`

The package ships the Host Runtime bundle (\`app/host-runtime.mjs\`), the preinstalled Harness plugins and the Rust Shim (\`libexec/claude-in-codex-shim\`). \`remote install\` copies the Shim into \`~/.claude-in-codex/remote/bin/codex\` and adds an SSH-guarded block to the login profile, so Codex Desktop's SSH connection reaches the Remote Host while local shells keep the stock Codex CLI.

## Requirements

- Node.js 22 or 24 (Node 20 and older are not supported)
- The official Codex CLI installed on this machine
- Claude Code installed when using the Claude Code adapter

## Notes

- This npm package does **not** embed a private Node.js runtime; the current Node.js executable runs the Host Runtime.
- On macOS, \`remote install\` manages the current-user Aqua Harness broker through the Shim; it never asks for a Keychain password or copies Claude credentials.
- The local Host is the macOS menu bar app; this package provides only the Remote Host.
`;
}

export async function writeThirdPartyNotices(
  root,
  packageRoot,
  heading = "claude-in-codex npm package third-party notices",
) {
  const licensesDirectory = path.join(packageRoot, "licenses");
  await mkdir(licensesDirectory, { recursive: true });
  const notices = [heading, ""];
  for (const dependency of runtimeLicenses) {
    const dependencyRoot = path.join(root, "node_modules", dependency.packageName);
    const manifest = packageManifest(
      JSON.parse(await readFile(path.join(dependencyRoot, "package.json"), "utf8")),
      dependency.packageName,
    );
    if (manifest.license !== dependency.license) {
      throw new Error(
        `unexpected license metadata for runtime package '${dependency.packageName}'`,
      );
    }
    await copyReleaseFile(
      path.join(dependencyRoot, dependency.source),
      path.join(licensesDirectory, dependency.output),
      `${dependency.packageName} license`,
    );
    notices.push(
      `${dependency.packageName} ${manifest.version}`,
      `License: ${dependency.license}`,
      `License text: licenses/${dependency.output}`,
      "",
    );
  }
  await copyReleaseFile(
    path.join(root, "third-party", "opencodex.LICENSE"),
    path.join(licensesDirectory, "opencodex-LICENSE.txt"),
    "opencodex native profile license",
  );
  notices.push(
    "opencodex native profiles (2d4d7a22381a2e497c2442902104619e25f937c7)",
    "License: MIT",
    "License text: licenses/opencodex-LICENSE.txt",
    "",
  );
  await writeFile(
    path.join(packageRoot, "THIRD_PARTY_NOTICES.txt"),
    `${notices.join("\n").trimEnd()}\n`,
    "utf8",
  );
}

async function walkFiles(root, current = root) {
  const entries = await readdir(current, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(current, entry.name);
    const relative = path.relative(root, absolute).split(path.sep).join("/");
    const metadata = await lstat(absolute);
    if (metadata.isSymbolicLink()) {
      throw new Error(`npm package contains a symbolic link: ${relative}`);
    }
    if (metadata.isDirectory()) files.push(...(await walkFiles(root, absolute)));
    else if (metadata.isFile()) files.push({ absolute, relative });
    else throw new Error(`npm package contains a non-file: ${relative}`);
  }
  return files;
}

export async function validateNpmPackage({ packageRoot, target, root }) {
  const expected = expectedNpmPackagePaths(target);
  const files = await walkFiles(packageRoot);
  const actual = files.map((file) => file.relative).sort();
  const missing = expected.filter((relative) => !actual.includes(relative));
  const extra = actual.filter((relative) => !expected.includes(relative));
  if (missing.length > 0) {
    throw new Error(`npm package is missing files: ${missing.join(", ")}`);
  }
  if (extra.length > 0) {
    throw new Error(`npm package contains non-allowlist files: ${extra.join(", ")}`);
  }

  for (const file of files.filter((entry) => /\.(?:js|md|mjs|txt)$/u.test(entry.relative))) {
    const text = await readFile(file.absolute, "utf8");
    const forbiddenReferences = [root];
    if (file.relative !== "package.json" && text.includes("runtime/node")) {
      throw new Error(`npm package must not embed a private Node runtime: ${file.relative}`);
    }
    if (forbiddenReferences.some((reference) => text.includes(reference))) {
      throw new Error(`npm package file contains a forbidden reference: ${file.relative}`);
    }
  }

  const manifest = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
  const expectedName = npmPlatformPackageName(target);
  if (manifest.name !== expectedName) {
    throw new Error(`npm package name must be ${expectedName}`);
  }
  if (manifest.bin !== undefined) {
    throw new Error("npm platform package must not expose a bin entry");
  }
  if (manifest.private === true) {
    throw new Error("npm package must not be private");
  }
  return actual;
}

export function parseNpmReleaseArguments(
  arguments_,
  { hostPlatform = process.platform, hostArch = process.arch } = {},
) {
  let targetName;
  let version;
  let pack = false;
  let skipBuild = false;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--help" || argument === "-h") return { help: true };
    if (argument === "--pack") {
      pack = true;
      continue;
    }
    if (argument === "--skip-build") {
      skipBuild = true;
      continue;
    }
    if (argument === "--target") {
      if (targetName !== undefined) throw new Error("--target may only be provided once");
      targetName = arguments_[index + 1];
      if (!targetName) throw new Error("--target requires a value");
      index += 1;
      continue;
    }
    if (argument.startsWith("--target=")) {
      if (targetName !== undefined) throw new Error("--target may only be provided once");
      targetName = argument.slice("--target=".length);
      if (!targetName) throw new Error("--target requires a value");
      continue;
    }
    if (argument === "--version") {
      if (version !== undefined) throw new Error("--version may only be provided once");
      version = arguments_[index + 1];
      if (!version) throw new Error("--version requires a value");
      index += 1;
      continue;
    }
    if (argument.startsWith("--version=")) {
      if (version !== undefined) throw new Error("--version may only be provided once");
      version = argument.slice("--version=".length);
      if (!version) throw new Error("--version requires a value");
      continue;
    }
    throw new Error(`unknown npm release option: ${argument}`);
  }

  const target =
    targetName === undefined
      ? hostReleaseTarget(hostPlatform, hostArch)
      : releaseTargetForHost(targetName, hostPlatform);
  return { help: false, target, version, pack, skipBuild };
}

export async function resolveNpmPackageVersion(root, explicitVersion) {
  if (explicitVersion) {
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(explicitVersion)) {
      throw new Error(`npm package version '${explicitVersion}' is not valid semver`);
    }
    return explicitVersion;
  }
  const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  if (typeof manifest.version !== "string" || manifest.version.length === 0) {
    throw new Error("root package.json must define a release version");
  }
  if (manifest.version === "0.0.0") {
    throw new Error(
      "root package.json is still 0.0.0; pass --version <semver> for the npm package channel",
    );
  }
  return manifest.version;
}

export async function prepareNpmPackage({
  target,
  version,
  root = repositoryRoot,
  skipBuild = false,
}) {
  if (target.hostPlatform !== process.platform) {
    throw new Error(
      `npm release target '${target.id}' requires host platform '${target.hostPlatform}', current host is '${process.platform}'`,
    );
  }

  if (!skipBuild) {
    for (const command of npmReleaseBuildCommands(target)) await runCommand(command, root);
  }

  const packageVersion = await resolveNpmPackageVersion(root, version);
  const outputRoot = path.join(root, "build", "npm", packageVersion, target.id);
  const packageRoot = path.join(outputRoot, "package");
  await rm(packageRoot, { recursive: true, force: true });
  await mkdir(packageRoot, { recursive: true });

  const rustOutput = path.join(root, "target", target.rustTarget, "release");
  await copyReleaseFile(
    path.join(rustOutput, `claude-in-codex-shim${target.executableSuffix}`),
    path.join(packageRoot, "libexec", `claude-in-codex-shim${target.executableSuffix}`),
    "npm Shim",
    true,
  );
  const hostBundle = await buildReleaseHostBundle({
    repositoryRoot: root,
    outputPath: path.join(packageRoot, "app", "host-runtime.mjs"),
  });
  const pluginBundles = await buildPreinstalledHarnessPlugins({
    repositoryRoot: root,
    outputDirectory: path.join(packageRoot, "app", "plugins"),
  });
  verifyShippedRuntimeLicenses([
    ...hostBundle.runtimePackages,
    ...pluginBundles.flatMap((plugin) => plugin.runtimePackages),
  ]);
  await writeFile(
    path.join(packageRoot, "package.json"),
    `${JSON.stringify(createNpmPackageManifest({ version: packageVersion, target }), null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    path.join(packageRoot, "README.md"),
    createNpmReadme({ version: packageVersion, target }),
    "utf8",
  );
  await writeThirdPartyNotices(root, packageRoot);
  await validateNpmPackage({ packageRoot, target, root });

  return { version: packageVersion, outputRoot, packageRoot, target };
}

export function npmTarballFileName({ version, target }) {
  return `claude-in-codex-cli-${version}-${target.id}.tgz`;
}

export async function packNpmPackage({ packageRoot, outputRoot, version, target }) {
  const packCommand = npmPackCommand();
  const result = spawnSync(
    packCommand.command,
    [...packCommand.args, "--pack-destination", outputRoot],
    {
      cwd: packageRoot,
      encoding: "utf8",
      windowsHide: true,
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `npm pack failed with status ${result.status}: ${(result.stderr || result.stdout).trim()}`,
    );
  }
  const packedName = result.stdout.trim().split(/\r?\n/u).filter(Boolean).at(-1);
  if (!packedName) throw new Error("npm pack did not report an output tarball");
  const packedPath = path.join(outputRoot, packedName);
  if (version === undefined || target === undefined) return packedPath;

  const renamedPath = path.join(outputRoot, npmTarballFileName({ version, target }));
  if (path.resolve(packedPath) !== path.resolve(renamedPath)) {
    await rm(renamedPath, { force: true });
    await rename(packedPath, renamedPath);
  }
  return renamedPath;
}

export async function runNpmReleaseCli(arguments_) {
  const parsed = parseNpmReleaseArguments(arguments_);
  if (parsed.help) {
    console.log(npmReleaseUsage());
    return;
  }
  const prepared = await prepareNpmPackage({
    target: parsed.target,
    version: parsed.version,
    skipBuild: parsed.skipBuild,
  });
  console.log(`package=${prepared.packageRoot}`);
  console.log(`version=${prepared.version}`);
  console.log(`target=${prepared.target.id}`);
  if (parsed.pack) {
    const tarball = await packNpmPackage({
      packageRoot: prepared.packageRoot,
      outputRoot: prepared.outputRoot,
      version: prepared.version,
      target: prepared.target,
    });
    console.log(`tarball=${tarball}`);
  } else {
    console.log(
      [
        "next:",
        `  npm run release:npm -- --version ${prepared.version} --pack`,
        `  npm run release:npm:meta -- --version ${prepared.version} --pack`,
      ].join("\n"),
    );
  }
}

const invoked = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invoked === import.meta.url) {
  runNpmReleaseCli(process.argv.slice(2)).catch((error) => {
    console.error(`claude-in-codex npm release: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  });
}
