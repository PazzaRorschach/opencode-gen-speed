/** @jsxImportSource @opentui/solid */

import { Show, createMemo } from "solid-js"
import type { Context } from "@opencode/plugin/tui/context"
import type { RGBA } from "@opentui/core"
import type { StatsManager } from "../lib/stats"
import type { StatsSnapshot } from "../types"
import { formatDuration, formatSpeed, formatTTFT, formatTokens } from "../lib/metrics"
import { statsColors } from "../theme"

function statusLabel(snapshot: StatsSnapshot) {
  switch (snapshot.status) {
    case "waiting":
      return "等待首字"
    case "streaming":
      return "生成中 ●"
    case "tool":
      return "工具执行中"
    case "completed":
      return "本轮完成"
    case "interrupted":
      return "已中断"
    case "error":
      return "生成失败"
    default:
      return "等待生成"
  }
}

function footnote(snapshot: StatsSnapshot) {
  switch (snapshot.status) {
    case "waiting":
      return "已发出请求，等待模型返回第一个 Token。"
    case "streaming":
      return "当前速度按最近 4 秒流式文本估算；整轮平均使用服务商返回的输出 Token 除以模型耗时。"
    case "tool":
      return "当前 step 已结束，等待工具结果后继续生成。"
    case "completed":
      return "统计来自服务商返回的 Token 与模型生成时间。"
    case "interrupted":
      return "本轮已中断，显示已经产生的部分统计。"
    case "error":
      return "本轮生成失败，显示已经产生的部分统计。"
    default:
      return "发送消息后显示生成速度与 Token 用量。"
  }
}

/** Shared content for the `/speed` popup. */
export function StatsCard(props: {
  context: Context
  manager: StatsManager
  sessionID: string
  width?: number
}) {
  const colors = () => statsColors(props.context)
  const snapshot = createMemo(() => props.manager.read(props.sessionID))
  const cardWidth = () => Math.min(props.width ?? 52, Math.max(28, props.context.renderer.width - 6))
  const compact = () => cardWidth() < 44

  function statusColor() {
    switch (snapshot().status) {
      case "streaming":
        return colors().accent
      case "completed":
        return colors().success
      case "tool":
        return colors().info
      case "interrupted":
        return colors().warning
      case "error":
        return colors().error
      default:
        return colors().muted
    }
  }

  function Row(propsRow: { label: string; value: string; color?: RGBA }) {
    return (
      <box flexDirection="row" width="100%">
        <text fg={colors().muted}>{propsRow.label}</text>
        <box flexGrow={1} />
        <text fg={propsRow.color ?? colors().text}>{propsRow.value}</text>
      </box>
    )
  }

  const currentSpeed = () => {
    const speed = snapshot().currentSpeed
    return speed === undefined ? "—" : `${formatSpeed(speed)} tok/s`
  }

  const averageSpeed = () => {
    const value = snapshot().averageSpeed
    if (value === undefined) return "—"
    return `${snapshot().estimated ? "~" : ""}${formatSpeed(value)} tok/s`
  }

  const firstToken = () =>
    snapshot().status === "waiting" ? "等待中…" : formatTTFT(snapshot().ttftMs)

  const output = () => {
    const value = snapshot().outputTokens
    if (value <= 0) return "—"
    return `${snapshot().estimated ? "~" : ""}${formatTokens(value)} tokens`
  }

  const duration = () => formatDuration(snapshot().modelDurationMs)

  return (
    <box
      flexDirection="column"
      width="100%"
      backgroundColor={colors().background}
      paddingLeft={3}
      paddingRight={3}
      paddingTop={0}
      paddingBottom={1}
    >
      <box flexDirection="row" width="100%">
        <text fg={colors().accent}>{"◆ 生成速度"}</text>
        <box flexGrow={1} />
        <text fg={statusColor()}>{statusLabel(snapshot())}</text>
        <box paddingLeft={2}>
          <text fg={colors().muted}>esc</text>
        </box>
      </box>

      <box width="100%" height={1} border={["top"]} borderColor={colors().border} />

      <box flexDirection="column" width="100%">
        <Show
          when={
            snapshot().status !== "completed" &&
            snapshot().status !== "interrupted" &&
            snapshot().status !== "error"
          }
        >
          <Row
            label={compact() ? "当前" : "当前速度"}
            value={currentSpeed()}
            color={colors().accent}
          />
        </Show>
        <Row label={compact() ? "平均" : "整轮平均"} value={averageSpeed()} />
        <Row label={compact() ? "首字" : "首字时间"} value={firstToken()} />
        <Row label={compact() ? "输出" : "本轮输出"} value={output()} />
        <Row label={compact() ? "耗时" : "模型耗时"} value={duration()} />
      </box>

      <box flexDirection="column">
        <box width="100%" height={1} border={["top"]} borderColor={colors().border} />
        <text fg={colors().muted} wrapMode="word">
          {footnote(snapshot())}
        </text>
      </box>
    </box>
  )
}
