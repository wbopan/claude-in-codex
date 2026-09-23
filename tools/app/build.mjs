import { execFileSync } from "node:child_process";
import {
  appendFile,
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  rename,
  rm,
  writeFile,
  lstat,
  readlink,
  realpath,
} from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { buildReleaseHostBundle } from "../../packages/host-runtime/scripts/build-release.mjs";
import { buildPreinstalledHarnessPlugins } from "../../scripts/release/harness-plugins.mjs";
import { writeThirdPartyNotices } from "../../scripts/release/prepare-npm.mjs";
import {
  ensureSparkle,
  feedUrl,
  minimumSystemVersion,
  releaseVersion,
  sparkle as sparkleRelease,
  sparklePublicKey,
  updateCheckInterval,
} from "./distribution.mjs";

const root = path.resolve(import.meta.dirname, "../..");
if (process.platform !== "darwin") throw new Error("App builds require macOS");
// --release builds what tools/app/release.mjs ships: it requires a Developer ID identity and the
// Node license, and turns on automatic update checks. Development builds check only on request.
const release = process.argv.includes("--release");
// The App's identity; apps/macos/main.swift keeps the same defaults and reads the rest from Info.plist.
// CLAUDE_IN_CODEX_BUNDLE_ID with CLAUDE_IN_CODEX_APP_NAME builds a separately identified copy for development.
const defaultAppName = "Claude in Codex";
const defaultBundleIdentifier = "ai.bytepioneer.claude-in-codex";
const appName = process.env.CLAUDE_IN_CODEX_APP_NAME ?? defaultAppName;
const bundleIdentifier = process.env.CLAUDE_IN_CODEX_BUNDLE_ID ?? defaultBundleIdentifier;
const executableName = "ClaudeInCodex";
if ((appName === defaultAppName) !== (bundleIdentifier === defaultBundleIdentifier))
  throw new Error(
    "Override CLAUDE_IN_CODEX_BUNDLE_ID and CLAUDE_IN_CODEX_APP_NAME together for a test copy",
  );
if (!/^[\w .-]+$/.test(appName) || !/^[\w.-]+$/.test(bundleIdentifier))
  throw new Error(
    "Use plain letters, digits, spaces, dots and dashes in the App name and bundle identifier",
  );
// The default App reads the public appcast. A test copy updates only from
// CLAUDE_IN_CODEX_FEED_URL, e.g. a local feed for exercising an update end to end.
const updateFeed =
  appName === defaultAppName ? feedUrl : (process.env.CLAUDE_IN_CODEX_FEED_URL ?? null);
if (release && appName !== defaultAppName)
  throw new Error("Release builds use the default App identity");
const appVersion = await releaseVersion(root);
const publishedApp = path.join(root, `.dev/app/${appName}.app`);
const processes = execFileSync("/bin/ps", ["-axo", "comm="], { encoding: "utf8" }).split("\n");
if (processes.some((command) => command.trim().startsWith(`${publishedApp}/Contents/`)))
  throw new Error(`Quit this build of ${appName} before rebuilding its bundle`);
async function sourceDigest() {
  const files = execFileSync("git", ["ls-files", "-co", "--exclude-standard", "-z"], {
    cwd: root,
    encoding: "utf8",
  });
  const hash = createHash("sha256");
  for (const file of [...new Set(files.split("\0").filter(Boolean))].sort()) {
    const name = path.join(root, file);
    const stat = await lstat(name).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    hash.update(`${file}\0${stat?.mode ?? "deleted"}\0`);
    if (stat?.isSymbolicLink()) hash.update(await readlink(name));
    else if (stat?.isFile()) hash.update(await readFile(name));
    hash.update("\0");
  }
  return hash.digest("hex");
}
// The first Developer ID Application identity, else the first Apple Development one.
// CLAUDE_IN_CODEX_SIGNING_IDENTITY picks another by name or SHA-1 when several teams are present.
function signingIdentity() {
  const identities = [
    ...execFileSync("/usr/bin/security", ["find-identity", "-v", "-p", "codesigning"], {
      encoding: "utf8",
    }).matchAll(/^\s*\d+\) ([0-9A-F]{40}) "([^"]+)"$/gm),
  ].map(([, hash, name]) => ({ hash, name }));
  const wanted = process.env.CLAUDE_IN_CODEX_SIGNING_IDENTITY;
  if (wanted) {
    const chosen = identities.find(({ hash, name }) => hash === wanted || name === wanted);
    if (!chosen) throw new Error(`No valid code signing identity matches ${wanted}`);
    return chosen;
  }
  return (
    identities.find(({ name }) => name.startsWith("Developer ID Application:")) ??
    identities.find(({ name }) => name.startsWith("Apple Development:")) ??
    null
  );
}
const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const digest = await sourceDigest();
await mkdir(path.dirname(publishedApp), { recursive: true });
const lock = path.join(path.dirname(publishedApp), "build.lock");
await mkdir(lock);
const staging = await mkdtemp(path.join(path.dirname(publishedApp), "build-"));
try {
  const app = path.join(staging, `${appName}.app`);
  const contents = path.join(app, "Contents"),
    resources = path.join(contents, "Resources");
  await mkdir(path.join(contents, "MacOS"), { recursive: true });
  await mkdir(path.join(resources, "runtime"), { recursive: true });
  const node = await realpath(process.env.CLAUDE_IN_CODEX_NODE_BINARY ?? process.execPath);
  const version = execFileSync(node, ["--version"], { encoding: "utf8" }).trim();
  const [major, minor] = version.slice(1).split(".").map(Number);
  if (!(major === 24 || (major === 22 && minor >= 19)))
    throw new Error("Use Node 22.19+ or 24 to build the packaged runtime");
  await copyFile(node, path.join(resources, "runtime/node"));
  await chmod(path.join(resources, "runtime/node"), 0o755);
  await buildReleaseHostBundle({
    repositoryRoot: root,
    outputPath: path.join(resources, "host.mjs"),
  });
  await buildPreinstalledHarnessPlugins({
    repositoryRoot: root,
    outputDirectory: path.join(resources, "plugins"),
  });
  // Sparkle, trimmed to what a non-sandboxed App uses: the framework, Autoupdate and Updater.app.
  // The XPC services serve sandboxed Apps only; headers and modules are for compiling.
  const sparkle = await ensureSparkle(root);
  const frameworks = path.join(contents, "Frameworks");
  const framework = path.join(frameworks, "Sparkle.framework");
  await mkdir(frameworks, { recursive: true });
  execFileSync("/usr/bin/ditto", [path.join(sparkle, "Sparkle.framework"), framework]);
  for (const entry of ["XPCServices", "Headers", "PrivateHeaders", "Modules"])
    for (const name of [path.join(framework, entry), path.join(framework, "Versions/B", entry)])
      await rm(name, { recursive: true, force: true });
  const executable = path.join(contents, "MacOS", executableName);
  execFileSync(
    "/usr/bin/xcrun",
    [
      "swiftc",
      "-O",
      "-swift-version",
      "5",
      "-target",
      `${process.arch === "arm64" ? "arm64" : "x86_64"}-apple-macosx14.0`,
      "-framework",
      "AppKit",
      "-framework",
      "ServiceManagement",
      "-F",
      sparkle,
      "-framework",
      "Sparkle",
      "-Xlinker",
      "-rpath",
      "-Xlinker",
      "@executable_path/../Frameworks",
      path.join(root, "apps/macos/main.swift"),
      "-o",
      executable,
    ],
    { stdio: "inherit" },
  );
  const assets = path.join(root, ".dev/app/assets");
  execFileSync(executable, ["--render-assets", assets]);
  // Xcode's actool compiles the layered Icon Composer icon into Assets.car, which carries its dark,
  // tinted and clear appearances, plus Claude.icns for older systems. Without Xcode the App gets a
  // flat icns from the icon's pre-rendered PNG.
  const icon = path.join(root, "apps/macos/icon");
  let actool = null;
  try {
    actool = execFileSync("/usr/bin/xcrun", ["--find", "actool"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    // No Xcode: fall back to the pre-rendered icns below.
  }
  const iconFile = actool ? "Claude" : "AppIcon";
  if (actool) {
    execFileSync(
      actool,
      [
        path.join(icon, "Claude.icon"),
        "--compile",
        resources,
        "--platform",
        "macosx",
        "--target-device",
        "mac",
        "--minimum-deployment-target",
        "14.0",
        "--app-icon",
        "Claude",
        "--output-partial-info-plist",
        path.join(staging, "icon.plist"),
        "--errors",
        "--warnings",
        "--output-format",
        "human-readable-text",
      ],
      { stdio: "inherit" },
    );
    for (const file of ["Assets.car", "Claude.icns"])
      await lstat(path.join(resources, file)).catch(() => {
        throw new Error(`actool did not produce ${file} from Claude.icon`);
      });
  } else {
    const iconset = path.join(assets, "AppIcon.iconset");
    await mkdir(iconset, { recursive: true });
    for (const size of [16, 32, 128, 256, 512]) {
      for (const scale of [1, 2])
        execFileSync(
          "/usr/bin/sips",
          [
            "-z",
            String(size * scale),
            String(size * scale),
            path.join(icon, "AppIcon-1024.png"),
            "--out",
            path.join(iconset, `icon_${size}x${size}${scale === 2 ? "@2x" : ""}.png`),
          ],
          { stdio: "ignore" },
        );
    }
    execFileSync("/usr/bin/iconutil", [
      "-c",
      "icns",
      iconset,
      "-o",
      path.join(resources, "AppIcon.icns"),
    ]);
  }
  await writeFile(
    path.join(contents, "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${bundleIdentifier}</string>
<key>CFBundleName</key><string>${appName}</string>
<key>CFBundleDisplayName</key><string>${appName}</string>
<key>CFBundleExecutable</key><string>${executableName}</string>
<key>CFBundleDevelopmentRegion</key><string>zh_CN</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>${appVersion}</string>
<key>CFBundleVersion</key><string>${appVersion}</string>
<key>CFBundleIconFile</key><string>${iconFile}</string>
${actool ? "<key>CFBundleIconName</key><string>Claude</string>\n" : ""}<key>LSMinimumSystemVersion</key><string>${minimumSystemVersion}</string>
<key>LSUIElement</key><true/>
<key>NSHighResolutionCapable</key><true/>
${
  updateFeed
    ? `<key>SUFeedURL</key><string>${updateFeed}</string>
<key>SUPublicEDKey</key><string>${sparklePublicKey}</string>
<key>SUEnableAutomaticChecks</key>${release ? "<true/>" : "<false/>"}
<key>SUScheduledCheckInterval</key><integer>${updateCheckInterval}</integer>
`
    : ""
}</dict></plist>\n`,
  );
  // Notices for everything the App carries: the bundled npm packages, Node.js and Sparkle.
  await writeThirdPartyNotices(root, resources, "Claude in Codex third-party notices");
  const licenses = path.join(resources, "licenses");
  const nodeLicense = path.resolve(path.dirname(node), "../LICENSE");
  const notices = [];
  if (await lstat(nodeLicense).catch(() => null)) {
    await copyFile(nodeLicense, path.join(licenses, "Node.js-LICENSE.txt"));
    notices.push(
      `Node.js ${version}`,
      "License: MIT and bundled licenses",
      "License text: licenses/Node.js-LICENSE.txt",
      "",
    );
  } else if (release) {
    throw new Error(
      `No Node.js LICENSE next to ${node}; build releases with an official Node.js distribution`,
    );
  }
  await copyFile(path.join(sparkle, "LICENSE"), path.join(licenses, "Sparkle-LICENSE.txt"));
  notices.push(
    `Sparkle ${sparkleRelease.version}`,
    "License: MIT",
    "License text: licenses/Sparkle-LICENSE.txt",
    "",
  );
  await appendFile(
    path.join(resources, "THIRD_PARTY_NOTICES.txt"),
    `\n${notices.join("\n").trimEnd()}\n`,
  );
  await copyFile(path.join(root, "LICENSE"), path.join(resources, "LICENSE.txt"));
  if (
    (await sourceDigest()) !== digest ||
    execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim() !== revision
  )
    throw new Error("Source changed while building; the previous App is preserved");
  await writeFile(
    path.join(resources, "build.json"),
    JSON.stringify(
      {
        version: appVersion,
        revision,
        sourceDigest: digest,
        node: version,
        builtAt: new Date().toISOString(),
        mode: "hot-attach",
      },
      null,
      2,
    ),
  );
  // Inner code first, then the bundle, both under the hardened runtime. A certificate identity
  // makes the designated requirement name the team rather than one build's cdhash, so privacy
  // grants such as Accessibility survive rebuilds; an ad hoc build loses them on every rebuild.
  const identity = signingIdentity();
  if (release && !identity?.name.startsWith("Developer ID Application:"))
    throw new Error("Release builds need a Developer ID Application identity in the keychain");
  if (!identity)
    console.warn(
      "No Developer ID Application or Apple Development certificate in the keychain; signing ad hoc, so macOS privacy grants reset on every rebuild",
    );
  const sign = (target, entitlements) =>
    execFileSync(
      "/usr/bin/codesign",
      [
        "--force",
        "--options",
        "runtime",
        ...(identity?.name.startsWith("Developer ID Application:") ? ["--timestamp"] : []),
        ...(entitlements
          ? ["--entitlements", path.join(root, "apps/macos/entitlements", entitlements)]
          : []),
        "--sign",
        identity?.hash ?? "-",
        target,
      ],
      { stdio: "inherit" },
    );
  // Sparkle's helpers before the framework that contains them, as Sparkle documents.
  const sparkleVersion = path.join(framework, "Versions/B");
  sign(path.join(sparkleVersion, "Autoupdate"));
  sign(path.join(sparkleVersion, "Updater.app"));
  sign(framework);
  sign(path.join(resources, "runtime/node"), "node.plist");
  sign(app, "app.plist");
  execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", app], { stdio: "inherit" });
  const latestProcesses = execFileSync("/bin/ps", ["-axo", "comm="], { encoding: "utf8" }).split(
    "\n",
  );
  if (latestProcesses.some((command) => command.trim().startsWith(`${publishedApp}/Contents/`)))
    throw new Error(`${appName} started while building; quit it before publishing`);
  const previous = path.join(staging, "previous.app");
  let hadPrevious = false;
  try {
    await rename(publishedApp, previous);
    hadPrevious = true;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  try {
    await rename(app, publishedApp);
  } catch (error) {
    if (hadPrevious) await rename(previous, publishedApp);
    throw error;
  }
  console.log(publishedApp);
} finally {
  await rm(staging, { recursive: true, force: true });
  await rm(lock, { recursive: true, force: true });
}
