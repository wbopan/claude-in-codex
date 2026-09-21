#!/usr/bin/env node
// Copies the launcher icon into the macOS packaging workspace.
// Usage: node assets.mjs --output <directory>

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const PNG_SOURCE = path.resolve(
  import.meta.dirname,
  "../../../crates/launcher/assets/codexhost.png",
);


function parseArguments(args) {
  const output = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--output") {
      output.push(args[i + 1]);
      i += 1;
    } else if (args[i].startsWith("--output=")) {
      output.push(args[i].slice("--output=".length));
    } else {
      throw new Error(`unknown asset option: ${args[i]}`);
    }
  }
  if (output.length !== 1) throw new Error("usage: node assets.mjs --output <directory>");
  return output[0];
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const output = parseArguments(process.argv.slice(2));
  await mkdir(output, { recursive: true });
  await writeFile(path.join(output, "codexhost-icon.png"), await readFile(PNG_SOURCE));
  console.log(`icon=${path.join(output, "codexhost-icon.png")}`);
}
