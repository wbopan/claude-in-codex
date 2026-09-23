import { chmod, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  NPM_PACKAGE_DESCRIPTION,
  NPM_PACKAGE_NAME,
  NPM_PLATFORM_PACKAGE_NAMES,
  createNpmBinLauncherSource,
  packNpmPackage,
  resolveNpmPackageVersion,
} from "./prepare-npm.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");

export function expectedNpmMetaPackagePaths() {
  return ["README.md", "bin/claude-in-codex.js", "package.json"];
}

export function createNpmMetaPackageManifest({ version }) {
  return {
    name: NPM_PACKAGE_NAME,
    version,
    description: NPM_PACKAGE_DESCRIPTION,
    type: "module",
    bin: { "claude-in-codex": "bin/claude-in-codex.js" },
    files: ["bin/**", "README.md"],
    engines: { node: ">=22" },
    optionalDependencies: Object.fromEntries(
      Object.values(NPM_PLATFORM_PACKAGE_NAMES).map((packageName) => [packageName, version]),
    ),
    keywords: ["codex", "claude-in-codex", "claude-code", "agent", "harness"],
    publishConfig: { access: "public" },
  };
}

export function createNpmMetaReadme({ version }) {
  return `# ${NPM_PACKAGE_NAME}

${NPM_PACKAGE_DESCRIPTION}

## Install

\`\`\`bash
npm install -g ${NPM_PACKAGE_NAME}@${version}
\`\`\`

npm automatically installs the matching macOS or Linux platform package. Node.js 22 or 24 and the official Codex CLI are required on this machine.

## Usage

\`\`\`bash
claude-in-codex --version
claude-in-codex remote install
claude-in-codex remote status
claude-in-codex remote uninstall
\`\`\`

This package is the Remote Host: install it on the machine that Codex Desktop reaches over SSH. \`remote install\` routes Codex Desktop's managed SSH app-server listener to the Host Runtime while every other Codex CLI invocation keeps using the stock CLI. The local Host is the macOS menu bar app and is not part of this package.

On macOS, \`remote install\` installs a current-user Aqua Harness broker so Background SSH Hosts can use native Claude Code login without reading, copying, or unlocking Keychain credentials.

If installation used \`--omit=optional\`, reinstall without that option so npm can select the native package for the current architecture.
`;
}

async function walkFiles(root, current = root) {
  const entries = await readdir(current, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(current, entry.name);
    const relative = path.relative(root, absolute).split(path.sep).join("/");
    const metadata = await lstat(absolute);
    if (metadata.isSymbolicLink())
      throw new Error(`npm meta package contains a symlink: ${relative}`);
    if (metadata.isDirectory()) files.push(...(await walkFiles(root, absolute)));
    else if (metadata.isFile()) files.push(relative);
    else throw new Error(`npm meta package contains a non-file: ${relative}`);
  }
  return files;
}

export async function validateNpmMetaPackage({ packageRoot }) {
  const expected = expectedNpmMetaPackagePaths().sort();
  const actual = (await walkFiles(packageRoot)).sort();
  if (expected.join("\n") !== actual.join("\n")) {
    throw new Error(
      `npm meta package files differ: expected ${expected.join(", ")}; got ${actual.join(", ")}`,
    );
  }
  const manifest = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
  if (manifest.name !== NPM_PACKAGE_NAME)
    throw new Error(`npm meta package name must be ${NPM_PACKAGE_NAME}`);
  if (manifest.bin?.["claude-in-codex"] !== "bin/claude-in-codex.js") {
    throw new Error("npm meta package must expose bin/claude-in-codex.js");
  }
  if (manifest.os !== undefined || manifest.cpu !== undefined) {
    throw new Error("npm meta package must be architecture-neutral");
  }
  return actual;
}

export async function prepareNpmMetaPackage({ version, root = repositoryRoot }) {
  const packageVersion = await resolveNpmPackageVersion(root, version);
  const outputRoot = path.join(root, "build", "npm", packageVersion, "meta");
  const packageRoot = path.join(outputRoot, "package");
  await rm(packageRoot, { recursive: true, force: true });
  await mkdir(path.join(packageRoot, "bin"), { recursive: true });
  await writeFile(
    path.join(packageRoot, "bin", "claude-in-codex.js"),
    createNpmBinLauncherSource({ version: packageVersion }),
    "utf8",
  );
  await chmod(path.join(packageRoot, "bin", "claude-in-codex.js"), 0o755);
  await writeFile(
    path.join(packageRoot, "package.json"),
    `${JSON.stringify(createNpmMetaPackageManifest({ version: packageVersion }), null, 2)}\n`,
  );
  await writeFile(
    path.join(packageRoot, "README.md"),
    createNpmMetaReadme({ version: packageVersion }),
  );
  await validateNpmMetaPackage({ packageRoot });
  return { outputRoot, packageRoot, version: packageVersion };
}

export function npmMetaTarballFileName(version) {
  return `claude-in-codex-cli-${version}.tgz`;
}

export async function packNpmMetaPackage({ outputRoot, packageRoot, version }) {
  const packedPath = await packNpmPackage({ outputRoot, packageRoot });
  const expectedPath = path.join(outputRoot, npmMetaTarballFileName(version));
  if (path.resolve(packedPath) !== path.resolve(expectedPath)) {
    await rm(expectedPath, { force: true });
    await rename(packedPath, expectedPath);
  }
  return expectedPath;
}

export async function runNpmMetaReleaseCli(arguments_) {
  let version;
  let pack = false;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--pack") pack = true;
    else if (argument === "--version") version = arguments_[++index];
    else if (argument.startsWith("--version=")) version = argument.slice("--version=".length);
    else if (argument === "--help" || argument === "-h") {
      console.log("usage: npm run release:npm:meta -- --version <semver> [--pack]");
      return;
    } else throw new Error(`unknown npm meta release option: ${argument}`);
  }
  const prepared = await prepareNpmMetaPackage({ version });
  console.log(`package=${prepared.packageRoot}`);
  console.log(`version=${prepared.version}`);
  if (pack) {
    console.log(`tarball=${await packNpmMetaPackage(prepared)}`);
  }
}

const invoked = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invoked === import.meta.url) {
  runNpmMetaReleaseCli(process.argv.slice(2)).catch((error) => {
    console.error(
      `claude-in-codex npm meta release: ${error instanceof Error ? error.message : error}`,
    );
    process.exitCode = 1;
  });
}
