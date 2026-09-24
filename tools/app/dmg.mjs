// A drag-to-Applications disk image, built without Finder automation so it also works in CI.
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rename, rm, stat, symlink } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { releaseVersion } from "./distribution.mjs";

const root = path.resolve(import.meta.dirname, "../..");

export async function buildDiskImage({ app, output, signingIdentity }) {
  app = path.resolve(app);
  output = path.resolve(output);
  if (!app.endsWith(".app") || !(await stat(app)).isDirectory())
    throw new Error(`Expected an App bundle: ${app}`);
  if (!output.endsWith(".dmg")) throw new Error("Disk image output must end in .dmg");
  const run = (command, args) => execFileSync(command, args, { stdio: "inherit" });
  run("/usr/bin/codesign", ["--verify", "--deep", "--strict", app]);
  const layoutBuild = path.join(root, ".dev/dmg-layout");
  run("/usr/bin/xcrun", [
    "swift",
    "build",
    "--package-path",
    path.join(root, "tools/app/dmg-layout"),
    "--scratch-path",
    layoutBuild,
    "--configuration",
    "release",
    "--disable-automatic-resolution",
  ]);
  await mkdir(path.dirname(output), { recursive: true });
  const scratch = await mkdtemp(path.join(path.dirname(output), ".dmg-"));
  const mount = path.join(scratch, "volume");
  let mounted = false;
  try {
    const contents = path.join(scratch, "contents");
    const image = path.join(scratch, "installer.dmg");
    const writable = path.join(scratch, "writable.dmg");
    const appName = path.basename(app);
    await mkdir(contents);
    // ditto preserves framework symlinks, executable modes and the stapled App ticket.
    run("/usr/bin/ditto", [app, path.join(contents, appName)]);
    await symlink("/Applications", path.join(contents, "Applications"));
    run("/usr/bin/hdiutil", [
      "create",
      "-volname",
      appName.slice(0, -4),
      "-srcfolder",
      contents,
      "-fs",
      "HFS+",
      "-format",
      "UDRW",
      writable,
    ]);
    run("/usr/bin/hdiutil", ["attach", writable, "-nobrowse", "-mountpoint", mount]);
    mounted = true;
    run(path.join(layoutBuild, "release/dmg-layout"), [mount, appName]);
    run("/usr/bin/hdiutil", ["detach", mount]);
    mounted = false;
    run("/usr/bin/hdiutil", ["convert", writable, "-format", "UDZO", "-o", image]);
    run("/usr/bin/hdiutil", ["verify", image]);
    if (signingIdentity) {
      run("/usr/bin/codesign", ["--timestamp", "--sign", signingIdentity, image]);
      run("/usr/bin/codesign", ["--verify", "--strict", image]);
    }
    // A failed build leaves an existing image intact.
    await rename(image, output);
    return output;
  } finally {
    // Never remove a staging directory while a writable volume is still mounted beneath it.
    // If detach fails, leave the staging files for recovery instead of deleting their contents.
    if (mounted) run("/usr/bin/hdiutil", ["detach", mount]);
    await rm(scratch, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    if (process.platform !== "darwin") throw new Error("Disk images require macOS");
    const version = await releaseVersion(root);
    const arch = process.arch === "arm64" ? "arm64" : "x86_64";
    const appName = process.env.CLAUDE_IN_CODEX_APP_NAME ?? "Claude in Codex";
    const output = await buildDiskImage({
      app: path.join(root, `.dev/app/${appName}.app`),
      output: path.join(root, "build/app-dmg", `Claude-in-Codex-${version}-${arch}.dmg`),
    });
    console.log(`Development disk image (not notarized): ${output}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
