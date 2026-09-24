import { execFileSync } from "node:child_process";

// The first Developer ID Application identity, else the first Apple Development one.
// CLAUDE_IN_CODEX_SIGNING_IDENTITY picks another by name or SHA-1 when several teams are present.
export function signingIdentity() {
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
