import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export async function inventory(root, directory = root) {
  const result = {};
  for (const name of (await readdir(directory)).sort()) {
    const file = path.join(directory, name);
    const relative = path.relative(root, file).split(path.sep).join("/");
    const stat = await lstat(file);
    if (stat.isSymbolicLink()) throw new Error(`Snapshot contains a symbolic link: ${relative}`);
    if (stat.isDirectory()) Object.assign(result, await inventory(root, file));
    else if (stat.isFile() && relative !== "fork-manifest.json") {
      result[relative] = {
        sha256: createHash("sha256")
          .update(await readFile(file))
          .digest("hex"),
        mode: stat.mode & 0o777,
      };
    } else if (!stat.isFile()) throw new Error(`Unexpected snapshot entry: ${relative}`);
  }
  return result;
}

export async function verifySnapshot(root) {
  const manifest = JSON.parse(await readFile(path.join(root, "fork-manifest.json"), "utf8"));
  if (manifest.schemaVersion !== 1 || !/^[a-f0-9]{40}$/u.test(manifest.commit)) {
    throw new Error("Invalid fork manifest");
  }
  if (manifest.platform !== process.platform || manifest.architecture !== process.arch) {
    throw new Error("Snapshot platform does not match this computer");
  }
  const actual = await inventory(root);
  if (JSON.stringify(actual) !== JSON.stringify(manifest.files)) {
    throw new Error("Snapshot files changed. Rebuild from the recorded commit before launching.");
  }
  for (const required of [
    "bin/codexhost",
    "libexec/codexhost-shim",
    "runtime/node",
    "app/host-runtime.mjs",
    "app/desktop-controller.mjs",
    "app/renderer-extension.js",
  ]) {
    if (!actual[required]) throw new Error(`Missing runtime file: ${required}`);
  }
  if (actual["app/codexhost-distribution.json"]) {
    throw new Error("Local snapshots must not enable the upstream installer updater.");
  }
  return manifest;
}

export function requireStoppedDesktop(processes) {
  if (
    processes
      .split("\n")
      .some(
        (line) =>
          /\/(?:ChatGPT|Codex)\.app\/Contents\/MacOS\/(?:ChatGPT|Codex)$/u.test(line.trim()) ||
          /\/codexhost(?:-shim)?$/u.test(line.trim()),
      )
  ) {
    throw new Error(
      "Codex Desktop or Host is still running. Save work and quit it normally before switching. No processes were stopped.",
    );
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== "--dry-run")) {
    throw new Error("Usage: Launch-Fork.command [--dry-run]");
  }
  const root = import.meta.dirname;
  const manifest = await verifySnapshot(root);
  if (manifest.debug) throw new Error("Use Launch-Debug.command for an isolated debug snapshot.");
  const executable = path.join(root, "bin/codexhost");
  if (args[0] === "--dry-run") {
    console.log(
      JSON.stringify(
        { commit: manifest.commit, command: [executable, "launch"], verified: true },
        null,
        2,
      ),
    );
    return;
  }
  requireStoppedDesktop(execFileSync("/bin/ps", ["-axo", "comm="], { encoding: "utf8" }));
  const env = { ...process.env };
  for (const key of ["CODEXHOST_HOST_NODE_PATH", "CODEXHOST_HOST_RUNTIME_PATH"]) delete env[key];
  const result = spawnSync(executable, ["launch"], { stdio: "inherit", env });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
