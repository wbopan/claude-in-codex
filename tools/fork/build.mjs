import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  cp,
  lstat,
  mkdir,
  readFile,
  readlink,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { prepareReleasePayload } from "../../scripts/release/prepare-payload.mjs";
import { hostReleaseTarget } from "../../scripts/release/targets.mjs";
import { inventory, verifySnapshot } from "./launch.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const debug = process.argv[2] === "--debug";
if (process.argv.length !== (debug ? 3 : 2))
  throw new Error("Usage: node tools/fork/build.mjs [--debug]");
if (process.platform !== "darwin") throw new Error("Fork snapshots currently support macOS.");
if (!debug && git("status", "--porcelain"))
  throw new Error("Commit or stash source changes before building a snapshot.");
async function sourceDigest() {
  const files = execFileSync("git", ["ls-files", "-co", "--exclude-standard", "-z"], {
    cwd: root,
    encoding: "utf8",
  });
  const hash = createHash("sha256");
  for (const file of [...new Set(files.split("\0").filter(Boolean))].sort()) {
    const stat = await lstat(path.join(root, file)).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    hash.update(`${file}\0${stat?.mode ?? "deleted"}\0`);
    if (stat?.isSymbolicLink()) hash.update(await readlink(path.join(root, file)));
    else if (stat?.isFile()) hash.update(await readFile(path.join(root, file)));
    hash.update("\0");
  }
  return hash.digest("hex");
}
const commit = git("rev-parse", "HEAD");
const digest = debug ? await sourceDigest() : undefined;
const output = debug
  ? path.join(root, ".codexhost/debug-builds", `${Date.now()}-${digest.slice(0, 12)}`)
  : path.join(root, ".codexhost/builds", commit);
await mkdir(path.dirname(output), { recursive: true });
// An exclusive reservation prevents concurrent builders from touching shared release output.
const lock = path.join(root, ".codexhost/fork-build.lock");
await mkdir(lock);
let reserved = false;
try {
  await mkdir(output);
  reserved = true;
  const prepared = await prepareReleasePayload({ root, target: hostReleaseTarget() });
  if (
    git("rev-parse", "HEAD") !== commit ||
    (debug ? (await sourceDigest()) !== digest : git("status", "--porcelain"))
  ) {
    throw new Error("Source changed while building; no snapshot was published.");
  }
  await cp(prepared.payloadRoot, output, { recursive: true, force: false });
  await copyFile(path.join(root, "tools/fork/launch.mjs"), path.join(output, "launch.mjs"));
  const launcher = path.join(output, debug ? "Launch-Debug.command" : "Launch-Fork.command");
  if (debug) {
    await copyFile(path.join(root, "tools/fork/debug.mjs"), path.join(output, "debug.mjs"));
    await copyFile(
      path.join(root, "tools/fork/claude-desktop.mjs"),
      path.join(output, "claude-desktop.mjs"),
    );
  }
  await writeFile(
    launcher,
    debug
      ? '#!/bin/bash\nset -euo pipefail\nFORK_BUILD="$(cd "$(dirname "$0")" && pwd)"\nexec "$FORK_BUILD/runtime/node" "$FORK_BUILD/debug.mjs" start "$@"\n'
      : '#!/bin/bash\nset -euo pipefail\nFORK_BUILD="$(cd "$(dirname "$0")" && pwd)"\nexec "$FORK_BUILD/runtime/node" "$FORK_BUILD/launch.mjs" "$@"\n',
  );
  await chmod(launcher, 0o755);
  const manifest = {
    schemaVersion: 1,
    commit,
    provenance: "PROVENANCE.md",
    version: prepared.version,
    platform: process.platform,
    architecture: process.arch,
    node: process.version,
    rust: execFileSync("rustc", ["--version"], { encoding: "utf8" }).trim(),
    createdAt: new Date().toISOString(),
    ...(debug
      ? {
          debug: true,
          sourceDigest: digest,
          dirty: Boolean(git("status", "--porcelain")),
          repository: root,
        }
      : {}),
    files: await inventory(output),
  };
  await writeFile(
    path.join(output, "fork-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  await verifySnapshot(output);
  if (git("rev-parse", "HEAD") !== commit || (debug && (await sourceDigest()) !== digest)) {
    throw new Error("Source changed while publishing; no snapshot was published.");
  }
  const pointer = path.join(
    root,
    debug ? ".codexhost/latest-debug-build.txt" : ".codexhost/latest-build.txt",
  );
  await writeFile(`${pointer}.tmp`, `${output}\n`);
  await rename(`${pointer}.tmp`, pointer);
  console.log(
    `Verified snapshot: ${output}\n${debug ? "Launch independent debug instance" : "Launch after quitting Desktop"}: ${launcher}`,
  );
} catch (error) {
  if (reserved) await rm(output, { recursive: true, force: true });
  throw error;
} finally {
  await rm(lock, { recursive: true, force: true });
}
