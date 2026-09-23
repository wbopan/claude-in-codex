// Installs the App built by tools/app/build.mjs into /Applications, replacing an earlier install
// only when it is not running. The replacement is staged next to the target and swapped in.
import { execFileSync } from "node:child_process";
import { lstat, rename, rm } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");
if (process.platform !== "darwin") throw new Error("App installs require macOS");
const appName = "Claude in Codex";
const built = path.join(root, `.dev/app/${appName}.app`);
// Development: install into another folder, e.g. to try the install without touching /Applications.
const applications = process.env.CLAUDE_IN_CODEX_APPLICATIONS_DIR ?? "/Applications";
const installed = path.join(applications, `${appName}.app`);

if (!(await lstat(built).catch(() => null))?.isDirectory())
  throw new Error(`Build the App first: npm run app:build (missing ${built})`);
execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", built], { stdio: "inherit" });

function runningFrom(app) {
  return execFileSync("/bin/ps", ["-axo", "comm="], { encoding: "utf8" })
    .split("\n")
    .some((command) => command.trim().startsWith(`${app}/Contents/`));
}
if (runningFrom(installed))
  throw new Error(`Quit ${appName} (waiting for its tasks) before installing a new build`);

const staging = `${installed}.installing-${process.pid}`;
const previous = `${installed}.previous-${process.pid}`;
try {
  execFileSync("/usr/bin/ditto", [built, staging]);
  execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", staging], {
    stdio: "inherit",
  });
  if (runningFrom(installed))
    throw new Error(`${appName} started while installing; nothing changed`);
  let hadPrevious = false;
  try {
    await rename(installed, previous);
    hadPrevious = true;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  try {
    await rename(staging, installed);
  } catch (error) {
    if (hadPrevious) await rename(previous, installed);
    throw error;
  }
  console.log(installed);
} finally {
  await rm(staging, { recursive: true, force: true });
  await rm(previous, { recursive: true, force: true });
}
