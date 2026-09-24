# Changelog

Each version's notes appear as written in the App's update prompt and on its GitHub Release. Before releasing, add a `## <version>` section here.

## 0.2.2

- Releases now live on this repository, which is public. Copies of 0.2.0 and 0.2.1 read their updates from the former `claude-in-codex-releases` repository, and this version moves them over. Later updates come from here.
- The README, docs and release notes are now in English, and a Chinese README is available as `README.zh-CN.md`. The App's interface is still in Chinese. English support is planned.
- Verified with Codex App 26.915.31945 and 26.917.51856.

## 0.2.1

- No functional changes. This is the first version built, notarized and published by GitHub Actions, released to confirm that the update channel works. When updating from 0.2.0, the App waits for running Sessions to finish and then relaunches into the new version.
- Verified with Codex App 26.915.31945 and 26.917.51856.

## 0.2.0

The first public release.

- Use your local Claude Code inside the normally launched Codex App. The native model picker gains the Claude models, and Claude Code Sessions run next to GPT tasks.
- The menu bar App shows the attachment state and the remaining Codex and Claude Code quotas. The Features pane of the main window switches Codex App tools, Computer & Browser Use and memory sync on or off.
- Disconnecting or quitting first waits for running Sessions to finish, or stops them if you choose to.
- Automatic updates: the App checks for a new version every six hours. Installing an update also waits for Sessions to finish, then relaunches into the new version. Automatic checks can be turned off, and updates checked manually, under Settings › Updates.
- Verified with Codex App 26.915.31945 and 26.917.51856.
