# Codex Desktop 热接入研究

2026-09-22，本机 macOS，Desktop `26.915.31945`。

结论：当前安装版本支持启动后的主进程接入。已实测一个可撤销的模型列表 hook，
包括原生菜单更新、正常撤销、控制端断开后的自动撤销，以及原有 GPT 任务连续运行。
可以据此设计菜单栏开关。完整 Claude 路由还没有接入这个原型。

## 验证范围和结果

使用官方 App 的独立 APFS 副本，保留官方签名。测试实例使用独立的 `CODEX_HOME`、
SQLite、Electron/Chromium profile。启动时不设置 shim，不传 inspector 参数。
测试启动仍由研究脚本执行，但启动参数只负责隔离数据目录；接入入口在启动之后建立。

| 检查 | 实测结果 |
| --- | --- |
| 原版启动后激活调试入口 | `SIGUSR1` 开启主进程 inspector，`execArgv` 为 `[]` |
| 现有后端连接 | 官方 `codex` PID `81854`，stdio 连接 |
| 添加模型列表项 | 原生列表新增 `Hook Probe (temporary)`，无磁盘配置修改 |
| 无刷新更新界面 | 仅 invalidate `['models', 'list', 'local']`，窗口 navigation 计数为 0 |
| 显式撤销 | 原始方法 descriptor 恢复，定时器和全局 hook 句柄删除，菜单项消失 |
| 运行中的 GPT 任务 | 接入和撤销时均为 `inProgress`，随后完成连续输出 1–100 |
| 进程连续性 | Desktop `81817`、后端 `81854`、renderer `81859` 在成功循环中均不变 |
| 控制端丢失 | 不再续租，3 秒后主进程自动恢复方法和模型缓存，菜单项消失 |
| 重新接入 | 关闭 inspector 后，通过新的控制端再次激活并接入成功 |
| 原始应用完整性 | 原版与测试副本的 `app.asar` 哈希一致，二者 codesign 校验通过 |

7 个含隐藏项的官方模型条目变为 8 个；用户可见的 5 项变为 6 项。
测试项仅验证目录和 UI，不提供推理服务，也没有选择它发起任务。

当前检查过的 `app.asar` SHA-256：

```text
1f7939c1c781887c167043c4d1d307af3400d324685cfc315dfe2f80e634f483
```

稳定实例 PID `57509`、启动时间 `2026-09-22 15:24:57` 保持不变。
早期探索中曾刷新测试 renderer 以取得测试连接对象。最终 hook 安装不依赖该对象，
成功的接入/撤销循环单独记录了零 navigation，并覆盖了一条真实运行中的任务。

## 接入点

现有 launcher 通过 `CODEX_CLI_PATH` 指向 shim。shim 建立 Host 通信链，再 `exec`
官方 CLI，以保留 Desktop → 官方 CLI 的签名进程关系。
Host 占据 Desktop 和后端之间的 stdio，当前退出逻辑会关闭后端；launcher 也会在
controller 退出时关闭 Desktop。这种生命周期不能直接用作热退出。

热接入原型使用现有主进程中的连接类。在模块缓存的 `.vite/build/src-*.js` 导出中，
按 `routeResponse`、`listModels`、`getPendingRequestCount` 的方法形状定位连接类，
不依赖压缩后的类名或导出别名。对其 `routeResponse` 安装一个可恢复的 prototype wrapper：

1. 只处理 `local` host。
2. 从 Desktop 原有的 pending-request 表读取响应所属 method。
3. 只给成功的 `model/list` 响应追加测试项，复制对象，保留原始响应。
4. 其他消息直接调用原方法。
5. 显式撤销或租约到期后，恢复完整 property descriptor。
6. 如果别的组件在此期间替换了方法，不覆盖对方的实现；停用本层改写并报告未完全恢复。

模型列表在 renderer 中有缓存。原型读取已挂载 React provider 中的 query client，
只刷新本地模型列表。它没有改写 renderer 函数、DOM 或 React 状态。
这仍依赖内部实现，需要按 Desktop 版本维护。

主进程保留一个短租约。控制端定期续租；控制端消失时，由主进程自己的计时器恢复
方法并调用预先安装的缓存清理回调。这使退出恢复不依赖控制端仍然存活。

## 复现

三个源码文件和单元验证：

- `tools/probes/desktop-hot-attach.mjs`：限定独立测试实例的控制端，校验 PID/启动时间、
  私有数据目录、未启用 shim 和应用归档哈希，拒绝对其他进程操作。
- `tools/probes/desktop-model-hook.mjs`：可序列化到主进程的 hook 与租约。
- `tools/probes/desktop-model-refresh.mjs`：可序列化到 renderer 的定向缓存刷新。
- `tools/probes/desktop-model-hook.test.mjs`：8 项测试，覆盖不改写其他路由、原对象保留、
  renderer/internal 请求、descriptor 恢复、租约、后装 wrapper、结构变化和清理失败。

在仓库根目录执行：

```sh
npx vitest run --config tests/vitest.config.js tools/probes/desktop-model-hook.test.mjs
node tools/probes/desktop-hot-attach.mjs start
node tools/probes/desktop-hot-attach.mjs attach
```

等待独立窗口启动完成后再执行 `attach`。控制端保持运行并每 1.5 秒续租。
`Ctrl-C` 撤销；若直接杀掉控制端，5 秒租约到期后撤销。
打开原生模型选择器可看到测试项；不要选择它执行任务。

```sh
node tools/probes/desktop-hot-attach.mjs status
node tools/probes/desktop-hot-attach.mjs detach
node tools/probes/desktop-hot-attach.mjs close-inspector
node tools/probes/desktop-hot-attach.mjs stop
```

`close-inspector` 先要求 hook 已撤销。`stop` 只退出记录的测试实例。
`status` 在 inspector 已关闭时会报告关闭，不会为了查询而重新激活它。

本轮完整实测产物在本机 `.codexhost/hot-attach-research/`，不纳入 Git：

- `cycle-report.json`：真实 GPT turn、接入/撤销、PID、原型恢复和 navigation 证据。
- `lost-controller-report.json`：控制端断开后的恢复结果。
- `inspector-close-report.json` / `cleanup-report.json`：调试端口关闭、测试进程清理和稳定实例连续性。
- `verified-attached.png` / `verified-detached.png`：展开后的真实模型菜单截图。
- `make-cycle.mjs` / `cycle.js`：本轮针对已捕获测试连接的连续任务实验。

## 避开的失败路径

首次尝试用 `Runtime.queryObjects` 查找连接实例时，测试实例 PID `79876` 崩溃。
系统报告为 `EXC_BAD_ACCESS / SIGBUS`，栈包含 `v8::HeapProfiler::QueryObjects`。
系统报告：`~/Library/Logs/DiagnosticReports/ChatGPT-2026-09-22-154719.ips`。
稳定实例未受影响。最终方案通过导出的 prototype 安装 hook，不再使用堆对象扫描。
实验结束后，独立 App 和首次崩溃遗留的三个辅助进程已按精确进程身份清理，
9229 调试端口已关闭，稳定实例仍保持原 PID 和启动时间。

仅检查 `document.body.innerText` 还不够确认菜单视觉状态：此版本在折叠的模型菜单中
保留模型文本。最终截图通过真实 pointer 事件展开菜单后采集，并已人工视觉核对。

## 完整产品的建议设计

推荐一个菜单栏小助手，拥有 Attach / Detach / 状态三个入口。用户正常启动官方 App，
小助手识别版本和精确进程身份后接入；关闭开关时恢复原始行为。
不修改 `.app`、不重新签名、不设置全局 `launchctl` 环境、不接管原版 App 启动。

协议层建议分为三个组件：

```text
原生 Desktop 连接
    ↕ 最小的版本适配与可撤销 hook
本机私有 IPC
    ↕
Claude 协议服务（复用现有 adapter / projector / thread store）
```

接入与退出状态应为 `off → attaching → active → draining → off`。
进入 draining 后拒绝新增 Claude 请求，等待或按用户选择停止正在运行的 Claude 任务，
再撤销路由、清理临时目录项和缓存、关闭本方打开的 inspector。
已有 GPT 任务继续沿官方连接运行。

下一步需要验证和实现：

1. **双向 Claude 路由。** 在现有连接的发送/响应分发边界接入 sidecar，处理请求 ID
   关联、流式通知、审批回调和断线。保留官方原有 pending 请求，避免重复 initialize。
   本轮仅验证响应改写，不代表这些功能已实现。
2. **Host 生命周期拆分。** 现有 `AppServerHost` 假设拥有 transport/backend，需要将
   外部模型协议服务从官方后端创建、初始化和 shutdown 中分离。
3. **原生工具归属。** 原官方后端和签名父子关系天然保留；Claude 调用 `codex_app`、
   `cua_repl` 所需的 task ownership、turn metadata 和事件归属仍需重新端到端验证。
4. **Claude 状态收尾。** 活跃 Claude 会话不能在撤销时静默切成 GPT。保留历史和恢复
   所需状态；突然失联时明确报错，不丢弃请求或伪报完成。
5. **用量显示。** 现有 HTTPS 用量代理依赖启动时的证书 pin 参数。热接入需要另外验证
   对现有网络响应的定点扩展，或首版暂不带用量扩展。
6. **版本与权限。** 实测仅覆盖这个构建；新版需重新检查结构、签名和 inspector 开关。
   未识别版本保持原版行为。inspector 只绑定 loopback，记录本方是否开启，退出时归还。

当前稳定 App 仍走旧 launcher 链。未来迁移到热接入模式时，需要先退出旧链并正常
启动原版一次；之后可以研究每次开关都不重启。这次没有迁移稳定实例。

参考：[Electron fuses](https://www.electronjs.org/docs/latest/tutorial/fuses)、
[主进程调试](https://www.electronjs.org/docs/latest/tutorial/debugging-main-process)。
可行性判断以本机原版副本的实测为依据；这不是官方承诺稳定的插件接口。
