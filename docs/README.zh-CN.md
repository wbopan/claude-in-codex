<p align="center">
  <img src="../apps/macos/icon/AppIcon-1024.png" width="128" height="128" alt="Claude in Codex 图标">
</p>

<h1 align="center">Claude in Codex</h1>

<p align="center">在 Codex App 里使用本机的 Claude Code，和 GPT 并排工作。</p>

<p align="center">
  <a href="https://github.com/wbopan/claude-in-codex/releases/latest"><img src="https://img.shields.io/github/v/release/wbopan/claude-in-codex?label=release" alt="最新版本"></a>
  <img src="https://img.shields.io/badge/macOS-14%2B%20%C2%B7%20Apple%20silicon-000000?logo=apple" alt="macOS 14+，Apple 芯片">
  <a href="https://github.com/wbopan/claude-in-codex/actions/workflows/ci.yml"><img src="https://github.com/wbopan/claude-in-codex/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="../LICENSE"><img src="https://img.shields.io/github/license/wbopan/claude-in-codex" alt="MIT 许可证"></a>
</p>

<p align="center"><a href="../README.md">English</a> | 简体中文</p>

Claude in Codex 是一个小巧的 macOS 菜单栏 App。它接入你已经打开的 Codex App，把本机 Claude 模型加进模型选择器，让 Claude Code Session 和 GPT 任务在同一个窗口里运行。

- **原生模型选择器。** 直接在 Codex App 自己的模型菜单里选择 Claude。
- **用你自己的 Claude Code。** 使用本机已安装、已登录的 Claude Code。
- **额度一目了然。** 菜单里显示 Codex 和 Claude 的剩余用量。
- **放心断开。** 退出时会等正在运行的 Session 完成，Codex App 照常运行。

## 安装

1. 从 [最新 Release](https://github.com/wbopan/claude-in-codex/releases/latest) 下载 DMG，把 **Claude in Codex** 拖到 **Applications（应用程序）**。
2. 先打开 Codex App，再打开 Claude in Codex。
3. 菜单栏的云朵变成实心并睁开眼睛后，在 Codex App 里选择 Claude 模型即可。

需要 Apple 芯片的 Mac、macOS 14 或更新版本、官方 Codex App，以及已登录的 [Claude Code](https://docs.anthropic.com/en/docs/claude-code)。App 经过 Apple 公证，并会自动更新。App 界面跟随 macOS 语言，中文排在英文前面时显示简体中文。

## 隐私

一切都在你的 Mac 上运行。Claude 对话和登录由 Claude Code 自己处理，App 只连接 GitHub 检查更新，不收集任何使用数据。

## 了解更多

- [使用指南](guide.zh-CN.md)：菜单与主窗口、功能、设置、更新、数据与卸载
- [开发](development.md)（英文）：从源码构建、测试与发布
- [更新日志](CHANGELOG.md)（英文）

## 许可证

MIT，见 [LICENSE](../LICENSE)。Claude in Codex 是独立项目，与 Anthropic 和 OpenAI 无关。Claude 和 Claude Code 是 Anthropic 的商标，Codex 和 ChatGPT 是 OpenAI 的商标。

本文是英文 README 的中文翻译，内容以英文版为准。
