import type { PluginOptions } from "./types"

const DEFAULT_WINDOW_MS = 4_000
const MIN_WINDOW_MS = 1_000
const MAX_WINDOW_MS = 10_000

function clampWindow(value: unknown, fallback: number) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallback
  return Math.min(MAX_WINDOW_MS, Math.max(MIN_WINDOW_MS, Math.round(value)))
}

/** Reads plugin options while keeping every value bounded and predictable. */
export function readOptions(raw: Readonly<Record<string, unknown>>): PluginOptions {
  return {
    footer: raw.footer !== false,
    windowMs: clampWindow(raw.windowMs, DEFAULT_WINDOW_MS),
    includeReasoning: raw.includeReasoning !== false,
  }
}
