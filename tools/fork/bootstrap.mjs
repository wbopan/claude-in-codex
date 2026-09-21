import { execFileSync } from "node:child_process";
import { chmod, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import { sha256File, verifyNodeArchive } from "../../scripts/release/node-runtime.mjs";
import { hostReleaseTarget, NODE_DIST_BASE_URL } from "../../scripts/release/targets.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const target = hostReleaseTarget();
if (process.platform !== "darwin") throw new Error("Fork bootstrap currently supports macOS.");
const toolchains = path.join(root, ".codexhost/toolchains");
const downloads = path.join(toolchains, "downloads");
const cache = path.join(root, ".codexhost/release-cache/node");
await mkdir(downloads, { recursive: true });
await mkdir(cache, { recursive: true });

function run(command, args, env = process.env) {
  execFileSync(command, args, { cwd: root, env, stdio: "inherit" });
}

function download(url, destination) {
  run("curl", [
    "-fsSL",
    "--connect-timeout",
    "15",
    "--max-time",
    "300",
    "--retry",
    "2",
    url,
    "-o",
    destination,
  ]);
}

const archive = path.join(cache, target.nodeArchive);
try {
  await verifyNodeArchive(archive, target.nodeArchiveSha256);
} catch {
  download(`${NODE_DIST_BASE_URL}/${target.nodeArchive}`, archive);
  await verifyNodeArchive(archive, target.nodeArchiveSha256);
}
run("tar", ["-xzf", archive, "-C", toolchains]);

// Use Rust's distribution bucket directly when static.rust-lang.org is unreachable.
const rustBase = "https://static-rust-lang-org.s3.amazonaws.com";
const rustupUrl = `${rustBase}/rustup/dist/${target.rustTarget}/rustup-init`;
const installer = path.join(downloads, "rustup-init");
download(rustupUrl, installer);
download(`${rustupUrl}.sha256`, `${installer}.sha256`);
const expected = (await readFile(`${installer}.sha256`, "utf8")).trim().split(/\s+/u)[0];
if (!/^[a-f0-9]{64}$/u.test(expected) || (await sha256File(installer)) !== expected) {
  throw new Error("Rustup checksum mismatch");
}
await chmod(installer, 0o755);
const channel = (await readFile(path.join(root, "rust-toolchain.toml"), "utf8")).match(
  /^channel = "([^"]+)"$/mu,
)?.[1];
if (!channel) throw new Error("Missing pinned Rust toolchain");
run(
  installer,
  [
    "-y",
    "--no-modify-path",
    "--profile",
    "minimal",
    "--default-toolchain",
    channel,
    "--component",
    "clippy",
    "--component",
    "rustfmt",
  ],
  {
    ...process.env,
    CARGO_HOME: path.join(toolchains, "cargo"),
    RUSTUP_HOME: path.join(toolchains, "rustup"),
    RUSTUP_DIST_SERVER: rustBase,
    RUSTUP_UPDATE_ROOT: `${rustBase}/rustup`,
  },
);
console.log("Local toolchains ready. Run: bash tools/fork/with-toolchain.sh npm ci");
