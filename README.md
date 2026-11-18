# dsh-unread

Codex 风格的未读会话提醒，面向 Windows 上的 DeepSeek Harness 桌面应用。

当会话任务完成、或存在待人工审批时，任务栏的 DeepSeek Harness 图标会显示一个黑底白字的数字角标（Codex 风格）；同时侧栏会话列表提供未读圆点、右键菜单中的「标记为已读 / 标记为未读」，并在打开会话时自动标记为已读。

## 功能

- **任务栏数字角标**：黑底白字数字（1–99，超过显示 99+），直接叠加在 DeepSeek Harness 的任务栏图标上；应用最小化到托盘时自动降级为托盘角标图标。
- **会话运行完成提醒**：仅当一次会话运行从「运行中」转为「空闲」且期间产出过真实回复时才点亮角标；运行中的中间消息（包括子 agent 消息）不会点亮；被停止、取消或报错的运行不会产生幽灵计数。
- **审批待处理提醒**：工具审批或用户提问待处理时点亮角标，处理完成后自动清除。
- **侧栏未读圆点**：未读会话在侧栏行首显示橙色状态圆点。
- **标记已读 / 标记未读**：会话右键菜单新增条目；打开未读会话时自动标记为已读（Codex 式行为）。
- **实时推送**：状态变化通过 SSE 即时同步到界面，无需轮询等待。

## 安装

- dshmarket：搜索 `dsh-unread` 一键安装（上架后）。
- GitHub：在 DeepSeek Harness 中执行 `dsh plugin add github:AmazarashiEnduerRain/dsh-unread`。
- 本地：将本目录作为本地 bundle 安装（`plugin_manager` 传入绝对路径）。

依赖 `koffi` 与 `zod` 由包管理器自动安装；`koffi` 使用预编译二进制，无需本地编译。

## 工作原理

- 宿主侧监听会话生命周期与审批事件，把未读状态写入存储域 `dsh_unread`（v1，单文件 JSON）。
- 角标通过 `ITaskbarList3::SetOverlayIcon` 直接绘制在任务栏图标上（DeepSeek Harness 桌面版未开放 Electron 角标 API）；找不到主窗口或失败时使用托盘图标兜底。
- 界面侧通过 `EventSource` 订阅 `/dsh-unread/events` 实时刷新；打开会话时自动标记已读。

## 重新生成角标图标

`assets/dsh-unread-*.ico`（1–99 与 99+）由纯 Node 脚本生成：

```
node tools/gen-icons.mjs
```

## 许可

MIT
