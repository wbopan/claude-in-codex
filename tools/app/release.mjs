// Builds, notarizes and packages a release of the App, and with --publish puts it on the
// repository's GitHub Releases, where the App's updater finds it.
//
//   node tools/app/release.mjs [--publish] [--allow-dirty]
//
// Notarization uses NOTARY_KEY_PATH, NOTARY_KEY_ID and NOTARY_ISSUER (an App Store Connect API
// key), else the notarytool keychain profile named by NOTARY_KEYCHAIN_PROFILE (default
// claude-in-codex-notary). Updates are signed with SPARKLE_PRIVATE_KEY, else the Sparkle key in the
// login keychain. Publishing uses GH_TOKEN or GITHUB_TOKEN, else the git credential for github.com.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { buildDiskImage } from "./dmg.mjs";
import { signingIdentity } from "./signing.mjs";

import {
  ensureSparkle,
  minimumSystemVersion,
  releaseVersion,
  releasesPage,
  repository,
  sparkleKeyAccount,
} from "./distribution.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const appName = "Claude in Codex";

function run(command, args, options = {}) {
  return execFileSync(command, args, { encoding: "utf8", ...options });
}

/// The notes under "## <version>" in docs/CHANGELOG.md, as Markdown.
export async function releaseNotes(version) {
  const changelog = await readFile(path.join(root, "docs", "CHANGELOG.md"), "utf8");
  const sections = changelog.split(/^## /m).slice(1);
  const section = sections.find((text) => text.split("\n", 1)[0].trim().split(/\s/)[0] === version);
  if (!section) throw new Error(`docs/CHANGELOG.md has no "## ${version}" section`);
  return section.slice(section.indexOf("\n") + 1).trim();
}

const escapeXml = (text) =>
  text.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c]);

/// A single-item Sparkle appcast for one signed archive.
export function appcast({ version, url, length, signature, notes, date = new Date() }) {
  return `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle">
  <channel>
    <title>${appName}</title>
    <link>${releasesPage}</link>
    <item>
      <title>${escapeXml(version)}</title>
      <pubDate>${date.toUTCString()}</pubDate>
      <sparkle:version>${escapeXml(version)}</sparkle:version>
      <sparkle:shortVersionString>${escapeXml(version)}</sparkle:shortVersionString>
      <sparkle:minimumSystemVersion>${minimumSystemVersion}</sparkle:minimumSystemVersion>
      <description sparkle:format="markdown"><![CDATA[${notes.replaceAll("]]>", "]]]]><![CDATA[>")}]]></description>
      <enclosure url="${escapeXml(url)}" length="${length}" type="application/octet-stream" sparkle:edSignature="${signature}"/>
    </item>
  </channel>
</rss>
`;
}

/// The EdDSA signature of file, from SPARKLE_PRIVATE_KEY or the login keychain, checked by verifying it.
export async function signUpdate(file, { privateKey = process.env.SPARKLE_PRIVATE_KEY } = {}) {
  const sparkle = await ensureSparkle(root);
  const tool = path.join(sparkle, "bin/sign_update");
  const scratch = await mkdtemp(path.join(os.tmpdir(), "claude-in-codex-sign-"));
  try {
    const keyArgs = privateKey
      ? ["--ed-key-file", path.join(scratch, "key")]
      : ["--account", sparkleKeyAccount];
    if (privateKey) await writeFile(keyArgs[1], privateKey.trim(), { mode: 0o600 });
    const signature = run(tool, [...keyArgs, "-p", file]).trim();
    if (!/^[A-Za-z0-9+/=]{80,}$/.test(signature)) throw new Error("sign_update gave no signature");
    run(tool, [...keyArgs, "--verify", file, signature]);
    return signature;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

function notaryArguments() {
  const { NOTARY_KEY_PATH: key, NOTARY_KEY_ID: keyId, NOTARY_ISSUER: issuer } = process.env;
  if (key || keyId || issuer) {
    if (!key || !keyId || !issuer)
      throw new Error("Set NOTARY_KEY_PATH, NOTARY_KEY_ID and NOTARY_ISSUER together");
    return ["--key", key, "--key-id", keyId, "--issuer", issuer];
  }
  return ["--keychain-profile", process.env.NOTARY_KEYCHAIN_PROFILE ?? "claude-in-codex-notary"];
}

export async function notarize(target, scratch) {
  const isDiskImage = target.endsWith(".dmg");
  const upload = isDiskImage ? target : path.join(scratch, "notarize.zip");
  if (!isDiskImage)
    run("/usr/bin/ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", target, upload]);
  console.log("Submitting to Apple's notary service…");
  const submitted = spawnSync(
    "/usr/bin/xcrun",
    ["notarytool", "submit", upload, "--wait", "--output-format", "json", ...notaryArguments()],
    { encoding: "utf8" },
  );
  let result = {};
  try {
    result = JSON.parse(submitted.stdout);
  } catch {
    // Reported below with notarytool's own output.
  }
  if (result.status !== "Accepted") {
    if (result.id)
      spawnSync("/usr/bin/xcrun", ["notarytool", "log", result.id, ...notaryArguments()], {
        stdio: "inherit",
      });
    throw new Error(
      `Notarization ${result.status ?? "failed"}: ${submitted.stderr || submitted.stdout}`.trim(),
    );
  }
  console.log(`Notarized (${result.id})`);
  run("/usr/bin/xcrun", ["stapler", "staple", target], { stdio: "inherit" });
  run("/usr/bin/xcrun", ["stapler", "validate", target], { stdio: "inherit" });
  const assessment = isDiskImage
    ? ["--type", "open", "--context", "context:primary-signature"]
    : ["--type", "execute"];
  run("/usr/sbin/spctl", ["--assess", ...assessment, "--verbose=2", target], {
    stdio: "inherit",
  });
}

function githubToken() {
  const fromEnvironment = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  if (fromEnvironment) return fromEnvironment;
  const credential = run("git", ["credential", "fill"], {
    input: "protocol=https\nhost=github.com\n\n",
  });
  const token = credential.match(/^password=(.+)$/m)?.[1];
  if (!token) throw new Error("No GitHub token: set GH_TOKEN");
  return token;
}

async function github(method, url, body, headers = {}) {
  const response = await fetch(url.startsWith("https:") ? url : `https://api.github.com${url}`, {
    method,
    headers: {
      authorization: `Bearer ${githubToken()}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      ...(body && !(body instanceof Uint8Array) ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    body: body instanceof Uint8Array ? body : body ? JSON.stringify(body) : undefined,
  });
  if (response.status === 404 && method === "GET") return null;
  if (!response.ok)
    throw new Error(`GitHub ${method} ${url} failed: ${response.status} ${await response.text()}`);
  return response.status === 204 ? null : response.json();
}

export function assetContentType(file) {
  switch (path.extname(file)) {
    case ".dmg":
      return "application/x-apple-diskimage";
    case ".zip":
      return "application/zip";
    case ".xml":
      return "application/xml";
    default:
      throw new Error(`Unknown release asset type: ${file}`);
  }
}

export function installationNotes(diskImage) {
  return `Download \`${path.basename(diskImage)}\`, open it and drag ${appName}.app into Applications. Eject the disk image, then open the App from Applications. If replacing an installed copy, quit it from its menu first and wait for its tasks to finish. Installed copies receive this update automatically; the ZIP is used by the updater.`;
}

/// Creates the release as a draft, attaches the DMG, archive and appcast, then publishes it as the
/// latest release, so the appcast the App reads never points at a missing archive.
async function publish({ version, notes, diskImage, files }) {
  const tag = `v${version}`;
  if (await github("GET", `/repos/${repository}/releases/tags/${tag}`))
    throw new Error(`${repository} already has a release ${tag}`);
  const release = await github("POST", `/repos/${repository}/releases`, {
    tag_name: tag,
    name: `${appName} ${version}`,
    body: `${notes}\n\n---\n\n${installationNotes(diskImage)}`,
    draft: true,
  });
  for (const file of files) {
    const name = path.basename(file);
    const type = assetContentType(file);
    await github(
      "POST",
      release.upload_url.replace(/\{.*\}$/, `?name=${encodeURIComponent(name)}`),
      new Uint8Array(await readFile(file)),
      { "content-type": type },
    );
    console.log(`Uploaded ${name}`);
  }
  const published = await github("PATCH", `/repos/${repository}/releases/${release.id}`, {
    draft: false,
    make_latest: "true",
  });
  console.log(published.html_url);
}

export async function main(argv) {
  const shouldPublish = argv.includes("--publish");
  if (
    !argv.includes("--allow-dirty") &&
    run("git", ["status", "--porcelain"], { cwd: root }).trim()
  )
    throw new Error("Commit or stash changes first, or pass --allow-dirty for a trial build");
  const version = await releaseVersion(root);
  const notes = await releaseNotes(version);
  const arch = process.arch === "arm64" ? "arm64" : "x86_64";
  const output = path.join(root, "build/app-release", version);
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });

  run(process.execPath, [path.join(root, "tools/app/build.mjs"), "--release"], {
    stdio: "inherit",
  });
  const app = path.join(root, `.dev/app/${appName}.app`);
  const diskImage = path.join(output, `Claude-in-Codex-${version}-${arch}.dmg`);
  const scratch = await mkdtemp(path.join(os.tmpdir(), "claude-in-codex-release-"));
  try {
    await notarize(app, scratch);
    const identity = signingIdentity();
    if (!identity?.name.startsWith("Developer ID Application:"))
      throw new Error("Release disk images need a Developer ID Application identity");
    await buildDiskImage({ app, output: diskImage, signingIdentity: identity.hash });
    await notarize(diskImage, scratch);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }

  const archiveName = `Claude-in-Codex-${version}-${arch}.zip`;
  const archive = path.join(output, archiveName);
  run("/usr/bin/ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", app, archive]);
  const signature = await signUpdate(archive);
  const feed = path.join(output, "appcast.xml");
  await writeFile(
    feed,
    appcast({
      version,
      url: `${releasesPage}/download/v${version}/${archiveName}`,
      length: (await stat(archive)).size,
      signature,
      notes,
    }),
  );
  console.log(`${diskImage}\n${archive}\n${feed}`);
  if (shouldPublish)
    await publish({ version, notes, diskImage, files: [diskImage, archive, feed] });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
  await main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
