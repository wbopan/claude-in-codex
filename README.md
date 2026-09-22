# Codex Host

在正常启动的原版 Codex / ChatGPT Desktop 中使用 Claude。日常入口是 **Codex Host.app**，一个 macOS 菜单栏应用。

## 使用

1. 正常打开 `/Applications/ChatGPT.app`，然后打开 `Codex Host.app`。
2. 菜单栏的括号图标中间变成实心圆，表示已接入。原生模型选择器会增加本机 Claude 模型。
3. 选择「断开（等待任务完成）」或「退出 Codex Host」，等待正在执行的外部任务和后台任务完成。等待期间可以取消断开，也可以明确选择停止外部任务。
4. 原版 App 和 GPT 任务继续运行。重新打开 Host 或选择「接入原版 App」即可再次接入。

目前支持 macOS 14+，官方 Desktop **26.915.31945**。兼容检查同时验证签名和 `app.asar` 哈希；遇到新版本会停止接入并显示原因。Host 使用已安装、已登录的 Claude Code。打包后的 App 自带 Node 和插件。

如果当前 Desktop 是旧 launcher 启动的，需要先自行退出旧实例，再从 Finder 正常打开原版 App。Host 会识别旧的 `CODEX_CLI_PATH` 并拒绝叠加接入。

## 菜单

图标由两个开放括号和连接点组成，适配系统明暗主题。空心点表示未接入，实心点表示已接入，省略号表示接入或排空中，感叹号表示错误。

菜单包含连接状态、Desktop 版本、前台与后台任务数、接入/断开、打开原版 App、连接状态窗口、诊断日志和退出。状态窗口右上角的「更多操作」也能打开同一个菜单。

## 构建

需要 Node 22.19+ 或 24、npm，以及 Xcode Command Line Tools。使用当前机器的架构构建。

```sh
npm ci
npm run menubar:build
open '.codexhost/menubar/Codex Host.app'
```

也可以用 `CODEXHOST_NODE_BINARY=/absolute/path/to/node` 指定打包的 Node 22/24。构建会生成 App 图标、进行本地 ad-hoc 签名并检查签名。运行中的构建不能被原地覆盖。

开发测试使用独立的官方 App 副本及数据目录，详情见 [迁移设计与验收](docs/menubar-migration.md)。`CODEXHOST_DESKTOP_APP` 可以指定测试副本，`CODEXHOST_DATA_DIR` 指定 Host 数据目录。普通使用不需要这些环境变量。

## 数据与远程连接

本机默认继续使用 `~/.codexhost` 中的模型偏好、映射、标题和归档记录；Claude 的正文和认证仍由原生 Claude Code 管理。接入读取 Desktop 实际使用的 `CODEX_HOME`，保留已有 Codex 记忆导出和注入路径。日志位于 `~/.codexhost/logs/menubar.log`。

热接入只改变当前 Desktop 的本机 stdio 连接。Cloud GPT、ChatGPT Work 和 SSH 主机的连接及筛选仍由原版 App 管理。本机 Claude 不会追加到云端模型列表。已有 SSH Remote Host、Aqua broker 和 `codexhost remote install|start|stop|status|uninstall` 保持原有安装与管理方式，MenuBar 不重新安装或重启远端服务。远端部署继续使用原来的平台发行包。

## 开发验证

```sh
npm run test:typescript
cargo test --workspace --locked --features codexhost-shim/test-utils
```

热接入代码在 `packages/host-runtime/src/hot-attach/`，原生菜单在 `apps/menubar/main.swift`，打包入口在 `tools/menubar/build.mjs`。协议、适配器、模型投影、权限、历史、工具和远程实现复用现有 Host。
