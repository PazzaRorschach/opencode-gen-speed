# opencode-gen-speed

OpenCode 2 TUI 插件：在会话中查看实时生成速度、首字时间和本轮 Token 用量。

## 功能

- 底部常驻一行：生成中显示当前速度；完成后显示上一轮输出 Token
- `/speed` 居中弹出完整卡片：当前速度、整轮平均、首字时间、本轮输出、模型耗时
- 生成中显示估算值，step 结束后自动替换为服务商返回的精确 Token
- 工具执行、等待首字、中断、失败都有对应状态
- 弹窗浮在会话上方，背后的会话内容保持可见
- 配色跟随 OpenCode 当前主题，切换主题时同步更新

## 和原生 TPS 的区别

OpenCode 自带的 `session.tps` 在响应结束后显示平均 `tok/s`，计算方式是：

```text
(output + reasoning tokens) / (streamed - firstToken)
```

这个插件补充的是：

- 生成过程中的当前速度（按最近 4 秒流式文本估算）
- 首字时间
- 本轮输出 Token 数
- 工具执行、等待首字、中断等状态
- 可随时打开的详情弹窗

生成中的数字只能是估算，因为 OpenCode 流式阶段只发送文本增量，精确 Token 由服务商在 step 结束时返回。

## 安装

从 GitHub 安装：

```sh
opencode plugin add github:PazzaRorschach/opencode-gen-speed
```

固定版本：

```sh
opencode plugin add github:PazzaRorschach/opencode-gen-speed#v0.0.1
```

本地开发时也可以直接把目录加入全局 `opencode.json`：

```jsonc
{
  "plugins": [
    "/absolute/path/to/opencode-gen-speed"
  ]
}
```

## 使用

| 方式 | 操作 |
| --- | --- |
| 斜杠命令 | `/speed`，别名 `/tokens`、`/tps` |
| 命令面板 | `Ctrl+P` → “查看生成速度” |
| 关闭弹窗 | 点击 `esc`（或弹窗内任意位置）或按 `Esc` |

默认没有绑定快捷键，可以在 `cli.json` 中自行设置：

```json
{
  "keybinds": {
    "gen-speed.open": "alt+t"
  }
}
```

底部状态在会话正常输入模式下显示；shell 模式下隐藏。

## 选项

```jsonc
{
  "plugins": [
    {
      "package": "opencode-gen-speed",
      "options": {
        "footer": true,
        "windowMs": 4000,
        "includeReasoning": true
      }
    }
  ]
}
```

| 选项 | 默认 | 说明 |
| --- | --- | --- |
| `footer` | `true` | 是否在底部显示一行状态 |
| `windowMs` | `4000` | 当前速度的估算窗口，范围 1000–10000 毫秒 |
| `includeReasoning` | `true` | 是否把推理 Token 计入总量和速度 |

## 指标口径

| 指标 | 口径 | 实时性 |
| --- | --- | --- |
| 当前速度 | 最近 `windowMs` 内流式文本的估算 Token ÷ 时间 | 估算 |
| 整轮平均 | 本轮输出 Token ÷ 模型耗时 | 生成中估算，step 结束后精确 |
| 首字时间 | 本轮 step 开始到第一个 Token | 精确 |
| 本轮输出 | 各 step 的 `output`（可选加 `reasoning`）之和 | 生成中估算，step 结束后精确 |
| 模型耗时 | 各 step 的 `streamed - firstToken` 之和，不含工具等待 | 生成中实时增长，step 结束后精确 |

“轮”按 `session.execution.started` 到 `succeeded`、`failed` 或 `interrupted` 计算。同一轮里的工具调用会产生多个 step。

## 配色

弹窗卡片和底部状态直接读取 OpenCode 主题语义色：

| 用途 | 主题 token |
| --- | --- |
| 标题、当前速度 | `background.action.primary.focused` |
| 数值 | `text.base` |
| 标签、脚注 | `text.muted` |
| 分隔线 | `border.base` |
| 弹窗背景 | `background.raised.base` |
| 本轮完成 | `text.feedback.success.base` |
| 工具执行中 | `text.feedback.info.base` |
| 中断、失败 | `text.feedback.warning.base` / `text.feedback.error.base` |

## 已知限制

- 当前速度和生成中的本轮输出是估算值，精确值在 step 结束后才有
- 计划任务、后台子会话等场景只统计当前会话；切换到其他会话时从服务端消息记录恢复上一轮
- OpenCode 2.3.x 对插件自有的 Solid 更新不会主动排帧；统计数据每 250 毫秒更新，底部状态以 1 秒节流重建 slot，弹窗以 1 秒节流重新挂载内容
- 自定义弹窗内容不接收鼠标事件，点击关闭通过监听 stdin 实现；弹窗打开期间左键点击任意位置都会关闭
- 切换会话时服务端历史恢复最多重试 2 次，每次 10 秒超时
- 极端长的会话只保留最近 20 个会话的统计状态

## 结构

```text
src/
  index.ts              server 壳（只注册 id）
  tui.tsx               TUI 入口：命令、弹窗、底部状态
  options.ts            选项读取与边界处理
  types.ts              状态快照与选项类型
  theme.ts              当前主题色读取
  lib/
    metrics.ts          Token 估算、速度/时间/数字格式
    stats.ts            事件状态机、会话统计、估算窗口
  components/
    FooterStatus.tsx    底部一行状态
    StatsCard.tsx       `/speed` 弹窗卡片
```

数据来源：

1. `session.text.delta` / `session.reasoning.delta`：生成中的文本增量，用于估算当前速度
2. `session.step.first-token` / `streamed` / `ended`：首字时间、生成耗时、精确 Token
3. `session.execution.*`：一轮的开始、完成、失败、中断
4. 服务端 `message.list`：插件加载或切换会话时恢复上一轮统计，避免只读到本地已加载窗口

## 开发

```sh
npm install
npm run typecheck
```

## 许可

MIT。
