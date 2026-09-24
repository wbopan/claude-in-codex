# Release runbook

Claude in Codex is released as a notarized zip on this repository's [GitHub Releases](https://github.com/wbopan/claude-in-codex/releases). Installed copies use [Sparkle](https://sparkle-project.org) to read `appcast.xml` from the latest release, and when they find a new version they download it, verify its signature and install it.

## How a release is made

`tools/app/release.mjs` (`npm run release:app`) does the following in order:

1. Checks that the working tree is clean, and reads the version from `package.json` and the matching section of `docs/CHANGELOG.md`.
2. Builds the App with `--release`. This requires a Developer ID Application certificate, turns on automatic update checks and bundles the Node.js license.
3. Submits the App for Apple notarization, waits for the result, staples the ticket into the App and runs a Gatekeeper assessment.
4. Zips it as `build/app-release/<version>/Claude-in-Codex-<version>-arm64.zip`, signs the zip with the Sparkle EdDSA key and writes an `appcast.xml` holding only this version.
5. With `--publish`, creates a draft release, uploads the zip and the appcast, then publishes the release and marks it as the latest. The App cannot see a draft, so the appcast never points at a missing file.

The feed URL is `https://github.com/wbopan/claude-in-codex/releases/latest/download/appcast.xml`, defined in `tools/app/distribution.mjs`.

## Releasing a version

1. Bump `version` in the root `package.json` (and the two matching lines at the top of `package-lock.json`), and add a `## <version>` section to `docs/CHANGELOG.md`. That section is shown in the App's update prompt and on the release page.
2. Commit and push to `main`.
3. Push the tag: `git tag v<version> && git push origin v<version>`. `.github/workflows/release.yml` builds, notarizes and publishes on a macOS 26 runner in about ten minutes, using the workflow's own `GITHUB_TOKEN` to create the release.

A release can also be made from a Mac with `npm run release:app -- --publish`. It reads the certificate and the Sparkle key from the login keychain, and the notary credentials as listed below. Without `--publish` it only produces the files, which is useful for checking them first. `--allow-dirty` allows a trial build from an uncommitted tree, but never publish with it.

## Credentials

| Credential | On a Mac | CI secret | Used for |
| --- | --- | --- | --- |
| Developer ID Application certificate and private key | Login keychain | `MACOS_CERTIFICATE_P12` (base64), `MACOS_CERTIFICATE_PASSWORD` | Code signing |
| App Store Connect API key | `NOTARY_KEY_PATH`, `NOTARY_KEY_ID` and `NOTARY_ISSUER`, or a keychain profile saved with `notarytool store-credentials claude-in-codex-notary` | `NOTARY_KEY_P8` (base64), `NOTARY_KEY_ID`, `NOTARY_ISSUER` | Notarization |
| Sparkle EdDSA private key | Login keychain, account `claude-in-codex` | `SPARKLE_PRIVATE_KEY` | Signing updates |
| Permission to create releases | The GitHub credential in `git credential`, or `GH_TOKEN` | None, the workflow's `GITHUB_TOKEN` | Publishing |

Current setup: CI notarizes with the existing "Talkie" App Store Connect team key, which has the Admin role. The Sparkle private key is backed up in the 1Password item "Claude in Codex Sparkle 更新签名私钥".

**Back up the Sparkle private key.** Installed copies accept only updates signed with this key, and its public key is written into every App's Info.plist. If the private key is lost, existing users can only update by downloading a new version by hand. To export a backup for a password manager:

```sh
.dev/toolchains/sparkle-2.10.0/bin/generate_keys --account claude-in-codex -x sparkle-private-key.txt
```

Restore it on another Mac with `-f sparkle-private-key.txt`, and delete the file once it is imported or stored.

To set or rotate CI secrets, run `node scripts/release/set-ci-secrets.mjs` with any of `--certificate`, `--notary-key … --notary-key-id … --notary-issuer …` and `--sparkle`. `--certificate` exports only the Developer ID identity and never the keychain's other identities, so macOS asks once for the keychain password. The script never prints a secret and needs `gh`, either on the PATH or in `.dev/toolchains/gh`.

## The former releases repository

While the source was private, 0.2.0 and 0.2.1 were published on [wbopan/claude-in-codex-releases](https://github.com/wbopan/claude-in-codex-releases), and those copies still read their appcast there. Its last release, 0.2.2, carries an appcast that points at the 0.2.2 zip on this repository. Copies that install it read their updates from here afterwards. The repository is archived and must stay available, not deleted, so that copies which have not updated yet can still find 0.2.2.

## When something goes wrong

- **Notarization is rejected:** the script prints the `notarytool log` output. The usual cause is an executable without the hardened runtime or a timestamp. Fix it and run again. Apple does not limit retries.
- **Publishing fails halfway:** a draft release is left behind. Delete the draft on GitHub and run again.
- **A released version is broken:** Sparkle never downgrades, so release a higher version with the fix. Until it is out, you can mark the previous release as Latest on GitHub, so copies that have not updated yet do not see the broken one.
- **Attaching fails after a Codex App update:** this is the most common reason to release. Release the fix quickly, and list the verified Codex App versions in the CHANGELOG.

## Testing an update locally

A whole update can be exercised without publishing, using a separately identified test copy whose feed points at your Mac:

```sh
export CLAUDE_IN_CODEX_BUNDLE_ID=ai.bytepioneer.claude-in-codex.test CLAUDE_IN_CODEX_APP_NAME='Claude in Codex Test'
export CLAUDE_IN_CODEX_FEED_URL=http://127.0.0.1:8765/appcast.xml
defaults write ai.bytepioneer.claude-in-codex.test AutoAttachAtLaunch -bool false
```

1. Run `node tools/app/build.mjs` and copy `.dev/app/Claude in Codex Test.app` somewhere else as the installed older version.
2. Temporarily raise the version in `package.json`, build again and zip the new build. Then restore the version.
3. Write an appcast for the zip with `signUpdate` and `appcast` exported by `tools/app/release.mjs`, put it next to the zip, and serve that folder with `python3 -m http.server 8765 --bind 127.0.0.1`.
4. Open the older copy, choose Check for Updates under Settings › Updates (设置 › 更新), install and relaunch, and confirm the new version number.

A test copy has an updater only when `CLAUDE_IN_CODEX_FEED_URL` is set, so it never reads the public feed.

Take care when the regular App is running: it may be hosting the very Claude Code Session doing the release work. Moving its bundle or sending it a quit request starts a drain that ends that Session. Check with `lsappinfo list`, which lists it reliably, before touching `/Applications/Claude in Codex.app`.
