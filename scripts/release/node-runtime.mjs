import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import path from "node:path";

export async function sha256File(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

export async function verifyNodeArchive(archivePath, expectedSha256) {
  const actual = await sha256File(archivePath);
  if (actual !== expectedSha256) {
    throw new Error(
      `Node.js archive SHA-256 mismatch for '${path.basename(archivePath)}': expected ${expectedSha256}, got ${actual}`,
    );
  }
  return actual;
}
