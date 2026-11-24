export type StatsStatus =
  | "idle"
  | "waiting"
  | "streaming"
  | "tool"
  | "completed"
  | "interrupted"
  | "error"

/** Immutable view consumed by the footer and the popup. */
export type StatsSnapshot = {
  readonly status: StatsStatus
  /** Estimated output tokens per second over the recent window. */
  readonly currentSpeed?: number
  /** Generated tokens divided by model generation time. */
  readonly averageSpeed?: number
  /** Execution start to first token. */
  readonly ttftMs?: number
  /** Generated tokens for this turn, including the active estimate. */
  readonly outputTokens: number
  /** Model generation time, excluding first-token waits and tool execution. */
  readonly modelDurationMs: number
  /** Elapsed time before the first token arrives. */
  readonly waitingMs?: number
  /** True when output or average includes an estimate. */
  readonly estimated: boolean
  /** False when the session has no completed or active turn to display. */
  readonly hasData: boolean
}

export type PluginOptions = {
  /** Registers the one-line prompt footer status when true. */
  readonly footer: boolean
  /** Rolling window used to estimate the current speed. */
  readonly windowMs: number
  /** Includes reasoning tokens in totals and speed estimates. */
  readonly includeReasoning: boolean
}
