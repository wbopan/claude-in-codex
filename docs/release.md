# 发布手册

Claude in Codex 以公证过的 zip 发布在公开仓库 [wbopan/claude-in-codex-releases](https://github.com/wbopan/claude-in-codex-releases)。源码仓库保持私有。已安装的 App 通过 [Sparkle](https://sparkle-project.org) 读取最新 Release 里的 `appcast.xml`，发现新版本后下载、校验签名并安装。

## 流程

`tools/app/release.mjs`（`npm run release:app`）依次完成：

1. 检查工作区干净，读取 `package.json` 的版本号和 `CHANGELOG.md` 中同名一节的说明。
2. 以 `--release` 构建 App：必须有 Developer ID Application 证书，打开自动检查更新，打包 Node.js 许可证。
3. 提交 Apple 公证并等待结果，把公证票据装订进 App，再用 Gatekeeper 评估一遍。
4. 打成 `build/app-release/<版本>/Claude-in-Codex-<版本>-arm64.zip`，用 Sparkle 私钥做 EdDSA 签名，生成只含这一版的 `appcast.xml`。
5. 带 `--publish` 时，在发布仓库先建草稿 Release，上传 zip 和 appcast，再发布并标为最新。草稿阶段 App 看不到它，所以 appcast 不会指向缺失的文件。

App 的 feed 地址固定为 `https://github.com/wbopan/claude-in-codex-releases/releases/latest/download/appcast.xml`，写在 `tools/app/distribution.mjs`。

## 发布一个版本

1. 修改根目录 `package.json` 的 `version`（同时更新 `package-lock.json` 顶部两处），在 `CHANGELOG.md` 加 `## <版本>` 一节。这一节会显示在 App 的更新提示和 Release 页面上。
2. 提交并推送到 main。
3. 推送 tag：`git tag v<版本> && git push origin v<版本>`。`.github/workflows/release.yml` 在 macOS 26 runner 上完成构建、公证和发布，约 10 分钟。

也可以在本机发布：`npm run release:app -- --publish`。本机发布从钥匙串读取证书和 Sparkle 私钥，公证凭据见下表。不带 `--publish` 只生成文件，适合先检查；`--allow-dirty` 允许在未提交的工作区试构建，但不要用它发布。

## 凭据

| 凭据 | 本机位置 | CI secret | 用途 |
| --- | --- | --- | --- |
| Developer ID Application 证书与私钥 | 登录钥匙串 | `MACOS_CERTIFICATE_P12`（base64）、`MACOS_CERTIFICATE_PASSWORD` | 代码签名 |
| App Store Connect API Key | `NOTARY_KEY_PATH`、`NOTARY_KEY_ID`、`NOTARY_ISSUER` 环境变量，或 `notarytool store-credentials claude-in-codex-notary` 保存的钥匙串配置 | `NOTARY_KEY_P8`（base64）、`NOTARY_KEY_ID`、`NOTARY_ISSUER` | 公证 |
| Sparkle EdDSA 私钥 | 登录钥匙串，账户名 `claude-in-codex` | `SPARKLE_PRIVATE_KEY` | 更新签名 |
| 发布仓库写权限 | `git credential` 中的 GitHub 凭据，或 `GH_TOKEN` | `RELEASES_TOKEN` | 创建 Release |

当前配置：CI 公证复用 App Store Connect 的 Talkie 团队 Key（Admin 权限）。`RELEASES_TOKEN` 是 GitHub 细粒度令牌「claude-in-codex release CI」，只能读写发布仓库的内容，不过期；要收回就在 GitHub 的 Fine-grained tokens 页面删除它。Sparkle 私钥备份在 1Password 条目「Claude in Codex Sparkle 更新签名私钥」。

**Sparkle 私钥必须备份。** 已安装的 App 只接受这把私钥签名的更新，公钥写在每个 App 的 Info.plist 里。私钥丢失后，现有用户只能手动下载新版本。导出备份并存进密码管理器：

```sh
.dev/toolchains/sparkle-2.10.0/bin/generate_keys --account claude-in-codex -x sparkle-private-key.txt
```

从备份恢复到另一台 Mac 用 `-f sparkle-private-key.txt`。导入或设置 secret 后删除这个文件。

设置或轮换 CI secret 用 `node scripts/release/set-ci-secrets.mjs`，按需传 `--certificate`、`--notary-key … --notary-key-id … --notary-issuer …`、`--sparkle`、`--releases-token`（从 `RELEASES_TOKEN` 环境变量读取）。`--certificate` 只导出 Developer ID 这一个身份，钥匙串里的其他证书不会带出去，系统会弹窗要求一次钥匙串密码。脚本不在终端打印任何密钥，需要 `gh`（PATH 中或 `.dev/toolchains/gh`）。

## 出错时

- **公证被拒**：脚本会打印 `notarytool log` 的结果，通常是某个可执行文件没有 hardened runtime 或时间戳。修复后重新运行即可，Apple 不限制重试。
- **发布中途失败**：发布仓库里会留下一个草稿 Release。在网页上删除草稿后重新运行。
- **发出的版本有问题**：Sparkle 不会降级，所以要发一个更高的修复版本。在修复版发布之前，可以在发布仓库把上一个 Release 设为 Latest，让还没更新的用户暂时看不到坏版本。
- **Codex App 更新后接入失败**：这是最常见的发布理由。修复兼容后尽快发版，并在 CHANGELOG 里写明已验证的 Codex App 版本。

## 在本机测试更新流程

不发布也能完整走一遍更新。用独立标识的测试副本，feed 指向本机：

```sh
export CLAUDE_IN_CODEX_BUNDLE_ID=ai.bytepioneer.claude-in-codex.test CLAUDE_IN_CODEX_APP_NAME='Claude in Codex Test'
export CLAUDE_IN_CODEX_FEED_URL=http://127.0.0.1:8765/appcast.xml
defaults write ai.bytepioneer.claude-in-codex.test AutoAttachAtLaunch -bool false
```

1. `node tools/app/build.mjs`，把 `.dev/app/Claude in Codex Test.app` 复制到别处作为「已安装」的旧版本。
2. 临时把 `package.json` 的版本改高，再构建一次，把新构建打成 zip。改回版本号。
3. 用 `tools/app/release.mjs` 导出的 `signUpdate` 和 `appcast` 为 zip 生成 appcast，和 zip 放在同一目录，在该目录运行 `python3 -m http.server 8765 --bind 127.0.0.1`。
4. 打开旧版本，在「设置 › 更新」点「检查更新…」，安装并重启。确认重启后的版本号。

测试副本只在设置了 `CLAUDE_IN_CODEX_FEED_URL` 时才带更新器，不会读取正式 feed。
