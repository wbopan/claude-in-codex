// Where released builds of the App live and how the App finds and trusts its updates.
// Every release on the repository carries the notarized zip and a signed appcast, and the App
// reads the appcast of the latest release.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export const repository = "wbopan/claude-in-codex";
export const releasesPage = `https://github.com/${repository}/releases`;
export const feedUrl = `${releasesPage}/latest/download/appcast.xml`;
// The EdDSA public key matching the private key that signs every update (Sparkle's
// generate_keys --account claude-in-codex). Rotating it strands every installed copy.
export const sparklePublicKey = "tswi3L13lRo5bdXpm/eSSPbCOh0rw0HOsGzpUhryySE=";
export const sparkleKeyAccount = "claude-in-codex";
export const minimumSystemVersion = "14.0";
// Seconds between automatic update checks.
export const updateCheckInterval = 21600;

export const sparkle = Object.freeze({
  version: "2.10.0",
  archive: "Sparkle-2.10.0.tar.xz",
  sha256: "c2bf58aa8387266ac179357b1415d6f2635f044da8be41042af32425dae6da0c",
});

async function sha256File(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

/// The unpacked Sparkle distribution (Sparkle.framework and bin/), downloaded once into the
/// repository's toolchain folder and checked against the pinned digest.
export async function ensureSparkle(root) {
  const toolchains = path.join(root, ".dev/toolchains");
  const directory = path.join(toolchains, `sparkle-${sparkle.version}`);
  if ((await lstat(path.join(directory, "Sparkle.framework")).catch(() => null))?.isDirectory())
    return directory;
  const downloads = path.join(toolchains, "downloads");
  await mkdir(downloads, { recursive: true });
  const archive = path.join(downloads, sparkle.archive);
  if (!(await lstat(archive).catch(() => null))?.isFile()) {
    const response = await fetch(
      `https://github.com/sparkle-project/Sparkle/releases/download/${sparkle.version}/${sparkle.archive}`,
    );
    if (!response.ok) throw new Error(`Sparkle download failed with HTTP ${response.status}`);
    const partial = `${archive}.download-${process.pid}`;
    await writeFile(partial, Buffer.from(await response.arrayBuffer()));
    await rename(partial, archive);
  }
  const digest = await sha256File(archive);
  if (digest !== sparkle.sha256) {
    await rm(archive, { force: true });
    throw new Error(
      `${sparkle.archive} SHA-256 mismatch: expected ${sparkle.sha256}, got ${digest}`,
    );
  }
  const staging = `${directory}.unpack-${process.pid}`;
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  execFileSync("/usr/bin/tar", ["-xf", archive, "-C", staging]);
  await rename(staging, directory);
  return directory;
}

/// The root package.json version, which names every release of the App.
export async function releaseVersion(root) {
  const { version } = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  if (!/^\d+\.\d+\.\d+$/.test(version ?? ""))
    throw new Error(`package.json version ${version} is not a plain major.minor.patch release`);
  return version;
}
