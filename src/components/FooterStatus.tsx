/** @jsxImportSource @opentui/solid */

import { Show, createMemo } from "solid-js"
import type { Context } from "@opencode/plugin/tui/context"
import type { StatsManager } from "../lib/stats"
import type { StatsSnapshot } from "../types"
import { formatCompactSpeed, formatCompactTokens } from "../lib/metrics"
import { statsColors } from "../theme"

function line(snapshot: StatsSnapshot) {
  switch (snapshot.status) {
    case "waiting":
      return "等待首字"
    case "streaming":
      return snapshot.currentSpeed === undefined
        ? "生成中"
        : `${formatCompactSpeed(snapshot.currentSpeed)} tok/s`
    case "tool":
      return "工具执行中"
    case "completed":
      return snapshot.outputTokens > 0
        ? `${formatCompactTokens(snapshot.outputTokens)} tok`
        : "本轮完成"
    case "interrupted":
      return "已中断"
    case "error":
      return "生成失败"
    default:
      return ""
  }
}

export function FooterStatus(props: {
  context: Context
  manager: StatsManager
  sessionID: string
}) {
  const colors = () => statsColors(props.context)
  const snapshot = createMemo(() => props.manager.read(props.sessionID))
  const text = () => line(snapshot())
  const color = () => {
    switch (snapshot().status) {
      case "error":
        return colors().error
      case "interrupted":
        return colors().warning
      default:
        return colors().muted
    }
  }

  return (
    <Show when={snapshot().hasData}>
      <text fg={color()} wrapMode="none">
        <span style={{ fg: colors().accent }}>◆</span> {text()}
      </text>
    </Show>
  )
}
