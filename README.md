# Claude in Codex

在正常启动的 Codex App（`/Applications/ChatGPT.app`）中使用 Claude。日常入口是 **Claude in Codex.app**，一个 macOS 菜单栏应用。

## 使用

App 安装在 `/Applications/Claude in Codex.app`（见「构建」）。

1. 正常打开 `/Applications/ChatGPT.app`，然后打开 Claude in Codex。
2. 菜单栏的云朵图标变成实心并睁开眼睛，表示已接入。原生模型选择器会增加本机 Claude 模型。
3. 选择「断开」或「退出 Claude in Codex」，等待正在执行的 Claude Code Session 和后台任务完成。等待期间可以取消断开，也可以明确选择停止 Session。
4. Codex App 和 GPT 任务继续运行。重新打开 Host 或选择「接入 Codex App」即可再次接入。

目前支持 macOS 14+，已验证官方 Desktop **26.915.31945**、**26.917.51856**。接入前只校验 OpenAI 签名，并在运行时检查内部连接结构；结构对不上时停止接入并显示原因。Host 使用已安装、已登录的 Claude Code。打包后的 App 自带 Node 和插件。

如果当前 Desktop 是旧 launcher 启动的，需要先自行退出旧实例，再从 Finder 正常打开 Codex App。Host 会识别旧的 `CODEX_CLI_PATH` 并拒绝叠加接入。

本项目原名 Codex Host。如果旧版 Codex Host.app 还在运行，Claude in Codex 启动时会提示先退出它，并在它退出后自动继续启动；两者不会同时接入同一个 Codex App。

## 菜单与主窗口

图标是 Claude 云朵，适配系统明暗主题，用眼睛表示状态：描边云朵加闭眼表示未接入，实心云朵加睁眼表示已接入，三个点表示接入或排空中，感叹号表示错误。

下拉菜单只放简要状态：第一行是接入状态，点它（⌘O）打开主窗口；然后是各额度窗口的剩余量（小进度条，悬停可见百分比和重置时间），以及接入/断开、设置（⌘,）和退出。

同一时间只运行一个 Host。再次打开 Claude in Codex.app（包括其他路径下的副本）时，新实例不会启动 Host，而是让已运行的实例打开主窗口后退出；在 Finder 中重新打开正在运行的 App 同样会打开主窗口。

主窗口标题栏中间是「概览 / 功能 / 设置」切换，右侧是接入/断开按钮。

**概览**

- 组件：Codex App、Claude Code CLI、Claude in Codex 三张卡片，各带图标和健康状态（运行中、Host 启动的 Claude 进程数、已接入）。图标都是不带底色的图形：Codex 云朵从 Codex App 自带的图标中取出，Claude Code CLI 用 Clawd 像素图，Claude in Codex 用 Claude 云朵。
- 用量：每个额度窗口一行，显示剩余量进度条、百分比和重置时间，剩余 20% 及以下标为橙色。Codex 额度来自 Codex App 自己轮询的 `/backend-api/wham/usage`：优先读结构化的 `rate_limit` 窗口，没有时保留服务端下发的文字行。Claude Code 额度来自 Claude Code 的账户用量接口（5 小时、每周和按模型的每周窗口，例如 Fable），与 Codex App 用量菜单共用 90 秒缓存。
- Claude Code Session：每个 Session 一行，显示标题和当前活动（思考、运行命令、等待批准等）及已运行时长，悬停可见所在目录。不显示提示词、命令或输出内容。

Claude Code CLI 进程数和用量在接入后读取。

**功能**

可选功能的开关，保存在数据目录的 `features.json`。某个功能出问题时，它的说明换成一行橙色提示。

- 工具：Codex App 工具（让 Claude 新建、管理 Codex thread 并发消息）、Computer & Browser Use。
- 记忆：Codex 记忆注入（把 Codex 的记忆摘要附加到 Claude 的 system prompt）、Claude Code 记忆同步（把 Claude 的自动记忆同步到 Codex 的记忆）。
- Session：闲置释放不是开关，而是一个时长选择：永不，或闲置多少分钟后释放 Claude 进程（发消息时再恢复），默认永不。文件里存为开关 `idleRelease` 加超时 `idleReleaseTimeoutMinutes`。

工具和记忆注入从下一个 Session 开始生效，其余立即生效。功能是否开启只由 `features.json` 决定，不读环境变量。

**设置**

- 登录时启动：通过系统登录项注册 App。如果系统要求批准，这一行会提示并提供「打开登录项设置…」。
- 启动时自动接入 Codex App：默认开启。关闭后启动 Host 但保持未接入，需要时从菜单选择「接入 Codex App」。
- 启动时打开此窗口：默认关闭。
- Codex App、数据目录和诊断日志的位置，可以在 Finder 中显示或直接打开日志。

「关于 Claude in Codex」显示版本号，以及构建时写入的 Git 修订和构建时间。

## 构建

需要 Node 22.19+ 或 24（开发默认用 `.node-version` 中的版本）、npm，以及 Xcode Command Line Tools。使用当前机器的架构构建。

```sh
npm ci
npm run app:install
open '/Applications/Claude in Codex.app'
```

`npm run app:install` 先构建到 `.dev/app/Claude in Codex.app`，再替换 `/Applications` 中的 App。正在运行的 App 不会被覆盖：先从菜单退出（等待任务完成），再安装。只构建不安装用 `npm run app:build`。

也可以用 `CLAUDE_IN_CODEX_NODE_BINARY=/absolute/path/to/node` 指定打包的 Node 22/24。构建会生成 App 图标（装有 Xcode 时用 `actool` 编译 `apps/macos/icon/Claude.icon`，否则用预渲染 PNG 生成 icns）、进行本地 ad-hoc 签名并检查签名。

仓库内的开发产物（构建、工具链、验收记录）都在 Git 忽略的 `.dev/` 下。`npm run bootstrap` 把 Node 和 Rust 工具链装到 `.dev/toolchains`。

开发测试使用独立的官方 App 副本及数据目录，详情见 [迁移设计与验收](docs/menubar-migration.md)。`CLAUDE_IN_CODEX_DESKTOP_APP` 可以指定测试副本，`CLAUDE_IN_CODEX_DATA_DIR` 指定 Host 数据目录。`CLAUDE_IN_CODEX_AUTO_ATTACH=0|1` 和 `CLAUDE_IN_CODEX_SHOW_DASHBOARD=1` 会覆盖设置中对应的启动选项，`CLAUDE_IN_CODEX_SHOW_FEATURES=1`、`CLAUDE_IN_CODEX_SHOW_SETTINGS=1` 在启动时打开主窗口的功能或设置页，`CLAUDE_IN_CODEX_SHOW_ABOUT=1` 打开关于窗口。普通使用不需要这些环境变量。

已有 Claude in Codex 在运行时，同一 bundle identifier 的新构建会直接交给它并退出。要和正在使用的 Host 并排测试界面，构建一个独立标识的副本，并关闭自动接入：

```sh
CLAUDE_IN_CODEX_BUNDLE_ID=ai.bytepioneer.claude-in-codex.test CLAUDE_IN_CODEX_APP_NAME='Claude in Codex Test' npm run app:build
open --env CLAUDE_IN_CODEX_AUTO_ATTACH=0 --env CLAUDE_IN_CODEX_DATA_DIR="$PWD/.dev/test-data" '.dev/app/Claude in Codex Test.app'
```

测试副本有自己的偏好设置和登录项。

## 数据与远程连接

模型偏好、线程映射、标题和归档记录保存在 `~/Library/Application Support/Claude in Codex/`，日志写到 `~/Library/Logs/Claude in Codex/host.log`，主窗口的设置页里都可以打开。Claude 的正文和认证仍由原生 Claude Code 管理。接入读取 Desktop 实际使用的 `CODEX_HOME`，保留已有 Codex 记忆导出和注入路径。

从 Codex Host 升级时，第一次接入会把 `~/.codexhost` 中的数据移到上述位置，旧日志改名为 `codexhost-*.log` 放进日志目录，旧 launcher 留下的 `desktop-proxy` 被删除；全部移走后删除 `~/.codexhost`。旧 Host 仍持有线程映射时不会迁移，而是显示错误，退出旧 Host 后重新接入即可。旧线程中的 `codexhost/…` 模型标识、旧的 `CODEXHOST_*` 环境变量和旧的 `codexhost/…` 管理方法都继续有效。

热接入只改变当前 Desktop 的本机 stdio 连接。Cloud GPT、ChatGPT Work 和 SSH 主机的连接及筛选仍由 Codex App 管理。本机 Claude 不会追加到云端模型列表。已有 SSH Remote Host、Aqua broker 和 `claude-in-codex remote install|start|stop|status|uninstall` 保持原有管理方式，菜单栏 App 不重新安装或重启远端服务。

远端只通过 npm 包 `@claude-in-codex/cli` 发行：在 SSH 目标机上执行 `npm install -g @claude-in-codex/cli`，再执行 `claude-in-codex remote install`。包内只有 Host Runtime（`app/host-runtime.mjs`，由当前 Node.js 运行）、预装的 Harness 插件和 Rust Shim（`libexec/claude-in-codex-shim`）。安装把 Shim 复制为 `<数据目录>/remote/bin/codex`（macOS 为 `~/Library/Application Support/Claude in Codex`，Linux 为 `$XDG_DATA_HOME/claude-in-codex`，默认 `~/.local/share/claude-in-codex`），并在登录配置中写入仅对 SSH 会话生效的段落。重新安装会接管改名前的 `~/.codexhost/remote`：迁移其中的数据，删除旧入口，并替换登录配置中的旧段落；macOS 上旧的 `ai.bytepioneer.codexhost.*` LaunchAgent 也会被移除。Shim 只把 Codex Desktop 托管的 `app-server --listen unix://` 监听交给 Host Runtime，其余调用（包括 stdio `app-server`）都原样转给官方 Codex CLI。macOS 上的 Aqua broker 由 Shim 的隐藏命令 `--claude-in-codex-broker` 安装和管理，`remote install|status|uninstall` 会自动调用，也可用 `claude-in-codex broker install|status|stop|uninstall` 单独管理。旧的 launcher、DMG 安装包和本机 stdio Host 已删除。

本地打包验证：`npm run release:npm -- --pack` 生成当前平台包，`npm run release:npm:meta -- --version <版本> --pack` 生成入口包，输出位于 `build/npm/`。

## 开发验证

`.node-version` 固定开发用的 Node 版本（与 `npm run bootstrap` 下载的一致），`fnm use` 或 `nvm use` 会读取它；`.npmrc` 开启了 `engine-strict`，版本不符时 `npm ci` 直接失败。`npm ci` 同时通过 lefthook 安装 pre-commit 钩子，只对暂存文件运行 Prettier、ESLint 和 rustfmt，`LEFTHOOK=0 git commit` 可临时跳过。

```sh
npm run check            # 提交前的完整检查：类型、lint、格式、全部测试
npm run test:unit        # 日常改代码：毫秒级的单元测试
npm run test:watch       # 单元测试 watch 模式
npm run test:integration # 启动 Host、派生进程的慢测试
npm run test:coverage    # v8 覆盖率报告，输出到 coverage/
```

`npm run typecheck` 同时检查包源码和测试（`tests/tsconfig.json`）。GitHub Actions（`.github/workflows/ci.yml`）在推送到 `main` 和每个 PR 上运行同样的检查。

测试约定：

- 测试放在各包的 `test/` 下；启动 Host、派生子进程或耗时以秒计的测试放在 `test/integration/`，归入 `integration` 项目。
- `*.real.test.ts` 连接真实的 Claude 或 Hermes，只在设置对应的 `CLAUDE_IN_CODEX_RUN_*=1` 时运行。
- 单元和集成测试运行时 `HOME`、`CODEX_HOME`、`CLAUDE_CONFIG_DIR` 指向临时目录（`tests/setup/isolate-home.ts`），测试读不到开发者本机的 `~/.codex` 和 `~/.claude`。
- 临时目录用 `tests/helpers/temp-dir.ts` 的 `tempDir()`：路径已解析软链接，测试结束自动删除。
- 等待异步结果时等具体事件或用 `vi.waitFor`，不写固定时长的 sleep。CI 中遗留的 `.only` 会让测试失败。
- 大的测试文件按功能拆到同名目录，共用的 fixture 放在该目录的非测试模块里。

热接入代码在 `packages/host-runtime/src/hot-attach/`，原生菜单在 `apps/macos/main.swift`，打包和安装入口在 `tools/app/`。数据和日志位置由 `packages/shared-contracts/src/app-paths.ts` 统一解析，改名前的标识符兼容集中在各自的读取入口。协议、适配器、模型投影、权限、历史、工具和远程实现复用现有 Host。
