# 更新记录

每个版本的说明会原样显示在 App 的更新提示和 GitHub Release 页面上。发布新版本前，在这里加一节 `## <版本号>`。

## 0.2.0

第一个公开发布的版本。

- 在正常启动的 Codex App 中使用本机 Claude Code：原生模型选择器增加 Claude 模型，Claude Code Session 与 GPT 任务并行运行。
- 菜单栏 App 显示接入状态和 Codex、Claude Code 两边的额度。主窗口的「功能」页可以开关 Codex App 工具、Computer & Browser Use 和记忆同步。
- 断开或退出时先等正在执行的 Session 完成，也可以明确选择停止。
- 自动更新：App 默认每 6 小时检查一次新版本。安装更新前同样先等 Session 完成，然后重启到新版本。可以在「设置 › 更新」关闭自动检查或手动检查。
- 已验证 Codex App 26.915.31945 和 26.917.51856。
