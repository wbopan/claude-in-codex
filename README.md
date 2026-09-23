# Codex Host

在正常启动的 Codex App（`/Applications/ChatGPT.app`）中使用 Claude。日常入口是 **Codex Host.app**，一个 macOS 菜单栏应用。

## 使用

1. 正常打开 `/Applications/ChatGPT.app`，然后打开 `Codex Host.app`。
2. 菜单栏的括号图标中间变成实心圆，表示已接入。原生模型选择器会增加本机 Claude 模型。
3. 选择「断开（等待任务完成）」或「退出 Codex Host」，等待正在执行的外部任务和后台任务完成。等待期间可以取消断开，也可以明确选择停止外部任务。
4. Codex App 和 GPT 任务继续运行。重新打开 Host 或选择「接入 Codex App」即可再次接入。

目前支持 macOS 14+，已验证官方 Desktop **26.915.31945**、**26.917.51856**。接入前只校验 OpenAI 签名，并在运行时检查内部连接结构；结构对不上时停止接入并显示原因。Host 使用已安装、已登录的 Claude Code。打包后的 App 自带 Node 和插件。

如果当前 Desktop 是旧 launcher 启动的，需要先自行退出旧实例，再从 Finder 正常打开 Codex App。Host 会识别旧的 `CODEX_CLI_PATH` 并拒绝叠加接入。

## 菜单与 Dashboard

图标由两个开放括号和连接点组成，适配系统明暗主题。空心点表示未接入，实心点表示已接入，省略号表示接入或排空中，感叹号表示错误。

下拉菜单只放简要状态：接入状态、运行中的任务数、各额度窗口的剩余量（小进度条，悬停可见百分比和重置时间），以及接入/断开、Dashboard 和退出。

Dashboard 的标题栏右侧有打开 Codex App、查看诊断日志和接入/断开按钮，内容分三块：

- 组件：Codex App、Claude Code CLI、Codex Host 三张卡片，各带图标、版本和健康状态（运行中、Host 启动的 Claude 进程数、已接入）。
- 用量：每个额度窗口一行，显示剩余量进度条、百分比和重置时间，剩余 20% 及以下标为橙色。Codex 额度来自 Codex App 自己轮询的 `/backend-api/wham/usage`：优先读结构化的 `rate_limit` 窗口，没有时保留服务端下发的文字行。Claude Code 额度来自 Claude Code 的账户用量接口（5 小时、每周和按模型的每周窗口，例如 Fable），与 Codex App 用量菜单共用 90 秒缓存。
- 外部任务：每个会话一行，显示标题、所在项目和当前活动（思考、运行命令、等待批准等）及已运行时长，不显示提示词、命令或输出内容。

Claude Code CLI 版本、进程数和用量在接入后读取。

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

热接入只改变当前 Desktop 的本机 stdio 连接。Cloud GPT、ChatGPT Work 和 SSH 主机的连接及筛选仍由 Codex App 管理。本机 Claude 不会追加到云端模型列表。已有 SSH Remote Host、Aqua broker 和 `codexhost remote install|start|stop|status|uninstall` 保持原有安装与管理方式，MenuBar 不重新安装或重启远端服务。远端部署继续使用原来的平台发行包。

## 开发验证

```sh
npm run test:typescript
cargo test --workspace --locked --features codexhost-shim/test-utils
```

热接入代码在 `packages/host-runtime/src/hot-attach/`，原生菜单在 `apps/menubar/main.swift`，打包入口在 `tools/menubar/build.mjs`。协议、适配器、模型投影、权限、历史、工具和远程实现复用现有 Host。
