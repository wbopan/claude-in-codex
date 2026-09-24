// Writes the release workflow's credentials into the source repository's Actions secrets without
// printing any of them. Pass only the groups to set or rotate:
//
//   node scripts/release/set-ci-secrets.mjs --certificate
//   node scripts/release/set-ci-secrets.mjs --notary-key AuthKey_X.p8 --notary-key-id X --notary-issuer UUID
//   node scripts/release/set-ci-secrets.mjs --sparkle
//
// --certificate exports only the Developer ID Application identity (never the keychain's other
// identities), so macOS asks once for the keychain password. Uses gh from PATH or
// .dev/toolchains/gh, authenticated by GH_TOKEN or the git credential for github.com.
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import { ensureSparkle, sparkleKeyAccount } from "../../tools/app/distribution.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const sourceRepository = "wbopan/claude-in-codex";
const { values } = parseArgs({
  options: {
    certificate: { type: "boolean" },
    "notary-key": { type: "string" },
    "notary-key-id": { type: "string" },
    "notary-issuer": { type: "string" },
    sparkle: { type: "boolean" },
  },
});

const gh = ["gh", path.join(root, ".dev/toolchains/gh/bin/gh")].find((candidate) =>
  candidate === "gh"
    ? spawnSync("gh", ["--version"], { stdio: "ignore" }).status === 0
    : existsSync(candidate),
);
if (!gh) throw new Error("Install the GitHub CLI (gh) first");
const token =
  process.env.GH_TOKEN ??
  execFileSync("git", ["credential", "fill"], {
    input: "protocol=https\nhost=github.com\n\n",
    encoding: "utf8",
  }).match(/^password=(.+)$/m)?.[1];

function setSecret(name, value) {
  if (!value) throw new Error(`${name} is empty`);
  const result = spawnSync(gh, ["secret", "set", name, "--repo", sourceRepository], {
    input: value,
    env: { ...process.env, GH_TOKEN: token },
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(`Setting ${name} failed: ${result.stderr}`);
  console.log(`Set ${name}`);
}

// SecItemExport of the one identity whose certificate has the given SHA-1.
const exportIdentity = `
import CryptoKit
import Foundation
import Security
let arguments = CommandLine.arguments
let (wanted, output, passphrase) = (arguments[1], arguments[2], arguments[3])
var found: CFTypeRef?
let query: [String: Any] = [kSecClass as String: kSecClassIdentity, kSecMatchLimit as String: kSecMatchLimitAll, kSecReturnRef as String: true]
guard SecItemCopyMatching(query as CFDictionary, &found) == errSecSuccess, let identities = found as? [SecIdentity] else { exit(2) }
for identity in identities {
    var certificate: SecCertificate?
    guard SecIdentityCopyCertificate(identity, &certificate) == errSecSuccess, let certificate else { continue }
    let digest = Insecure.SHA1.hash(data: SecCertificateCopyData(certificate) as Data).map { String(format: "%02X", $0) }.joined()
    guard digest == wanted else { continue }
    var parameters = SecItemImportExportKeyParameters(version: UInt32(SEC_KEY_IMPORT_EXPORT_PARAMS_VERSION), flags: [], passphrase: Unmanaged.passUnretained(passphrase as CFString), alertTitle: nil, alertPrompt: nil, accessRef: nil, keyUsage: nil, keyAttributes: nil)
    var data: CFData?
    let status = SecItemExport(identity, .formatPKCS12, [], &parameters, &data)
    guard status == errSecSuccess, let data else { FileHandle.standardError.write("SecItemExport failed: \\(status)\\n".data(using: .utf8)!); exit(3) }
    try (data as Data).write(to: URL(fileURLWithPath: output))
    exit(0)
}
exit(4)
`;

const scratch = await mkdtemp(path.join(os.tmpdir(), "claude-in-codex-secrets-"));
try {
  if (values.certificate) {
    const identities = execFileSync(
      "/usr/bin/security",
      ["find-identity", "-v", "-p", "codesigning"],
      { encoding: "utf8" },
    );
    const hash = identities.match(/([0-9A-F]{40}) "Developer ID Application:/)?.[1];
    if (!hash) throw new Error("No Developer ID Application identity in the keychain");
    const script = path.join(scratch, "export.swift");
    const p12 = path.join(scratch, "identity.p12");
    const passphrase = randomBytes(24).toString("hex");
    await writeFile(script, exportIdentity);
    console.log("macOS will ask for the keychain password to export the Developer ID identity…");
    execFileSync("/usr/bin/xcrun", ["swift", script, hash, p12, passphrase], {
      stdio: ["ignore", "ignore", "inherit"],
    });
    setSecret("MACOS_CERTIFICATE_P12", (await readFile(p12)).toString("base64"));
    setSecret("MACOS_CERTIFICATE_PASSWORD", passphrase);
  }
  if (values["notary-key"] || values["notary-key-id"] || values["notary-issuer"]) {
    if (!values["notary-key"] || !values["notary-key-id"] || !values["notary-issuer"])
      throw new Error("Pass --notary-key, --notary-key-id and --notary-issuer together");
    setSecret("NOTARY_KEY_P8", (await readFile(values["notary-key"])).toString("base64"));
    setSecret("NOTARY_KEY_ID", values["notary-key-id"]);
    setSecret("NOTARY_ISSUER", values["notary-issuer"]);
  }
  if (values.sparkle) {
    const exported = path.join(scratch, "sparkle.txt");
    const sparkle = await ensureSparkle(root);
    execFileSync(
      path.join(sparkle, "bin/generate_keys"),
      ["--account", sparkleKeyAccount, "-x", exported],
      { stdio: "ignore" },
    );
    setSecret("SPARKLE_PRIVATE_KEY", (await readFile(exported, "utf8")).trim());
  }
} finally {
  await rm(scratch, { recursive: true, force: true });
}
