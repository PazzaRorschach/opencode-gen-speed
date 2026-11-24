function isWide(codePoint: number) {
  return (
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe10 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1f300 && codePoint <= 0x1faff) ||
    (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  )
}

function isAsciiLetterOrDigit(codePoint: number) {
  return (
    (codePoint >= 0x30 && codePoint <= 0x39) ||
    (codePoint >= 0x41 && codePoint <= 0x5a) ||
    (codePoint >= 0x61 && codePoint <= 0x7a)
  )
}

/**
 * Rough token estimate for streaming text.
 *
 * OpenCode only exposes text deltas while a step runs; provider token counts
 * arrive when the step ends. English averages about four characters per
 * token, while CJK and emoji are usually one token each. The result is only
 * used for the live estimate and is replaced by provider usage afterwards.
 */
export function estimateTokens(text: string) {
  let weight = 0
  for (const char of text) {
    const codePoint = char.codePointAt(0)
    if (codePoint === undefined) continue
    if (isWide(codePoint)) {
      weight += 1
    } else if (isAsciiLetterOrDigit(codePoint) || codePoint === 0x20 || codePoint === 0x0a) {
      weight += 0.25
    } else {
      weight += 0.5
    }
  }
  return weight
}

export function formatSpeed(value: number | undefined) {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return "—"
  return value.toLocaleString("en-US", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  })
}

/** Short speed for the narrow prompt footer. */
export function formatCompactSpeed(value: number | undefined) {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return "—"
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return `${Math.round(value)}`
}

export function formatTokens(value: number) {
  return Math.max(0, Math.round(value)).toLocaleString("en-US")
}

/** Short token count for the narrow prompt footer. */
export function formatCompactTokens(value: number) {
  const count = Math.max(0, Math.round(value))
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`
  if (count >= 10_000) return `${(count / 1_000).toFixed(1)}k`
  return count.toLocaleString("en-US")
}

export function formatTTFT(ms: number | undefined) {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return "—"
  const seconds = ms / 1000
  return `${seconds < 10 ? seconds.toFixed(2) : seconds.toFixed(1)}s`
}

export function formatDuration(ms: number | undefined) {
  if (ms === undefined || !Number.isFinite(ms) || ms <= 0) return "—"
  const seconds = ms / 1000
  if (seconds < 3600) return `${seconds < 10 ? seconds.toFixed(2) : seconds.toFixed(1)}s`
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds - hours * 3600) / 60)
  return `${hours}h ${minutes.toString().padStart(2, "0")}m`
}
