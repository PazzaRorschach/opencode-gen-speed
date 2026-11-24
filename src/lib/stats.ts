import { createSignal, untrack } from "solid-js"
import type { Context } from "@opencode/plugin/tui/context"
import type { PluginOptions, StatsSnapshot, StatsStatus } from "../types"
import { estimateTokens } from "./metrics"

const MAX_SESSIONS = 20
const TICK_MS = 250
const HYDRATION_MAX_ATTEMPTS = 2
const HYDRATION_TIMEOUT_MS = 10_000

type Message = ReturnType<Context["data"]["session"]["message"]["list"]>[number]
type AssistantMessage = Extract<Message, { type: "assistant" }>

type Sample = {
  readonly at: number
  readonly text: number
  readonly reasoning: number
}

type SessionState = {
  status: StatsStatus
  executionStartedAt?: number
  stepStartedAt?: number
  stepFirstTokenAt?: number
  stepStreamedAt?: number
  ttftMs?: number
  exactOutput: number
  exactReasoning: number
  durationMs: number
  currentText: number
  currentReasoning: number
  samples: Sample[]
  currentSpeed: number
  /** Keeps an interrupted step's estimate visible after the step ends. */
  partial: boolean
  /** False until message history has been read or live events supplied data. */
  hydrated: boolean
  /** Bounds automatic recovery attempts for one session. */
  hydrationAttempts: number
  /** Prevents overlapping recovery fetches. */
  hydrationInFlight: boolean
  /** Invalidates a recovery fetch when live events arrive first. */
  eventVersion: number
  lastTouch: number
}

export type StatsManager = {
  read(sessionID: string): StatsSnapshot
  dispose(): void
}

function emptyState(): SessionState {
  return {
    status: "idle",
    exactOutput: 0,
    exactReasoning: 0,
    durationMs: 0,
    currentText: 0,
    currentReasoning: 0,
    samples: [],
    currentSpeed: 0,
    partial: false,
    hydrated: false,
    hydrationAttempts: 0,
    hydrationInFlight: false,
    eventVersion: 0,
    lastTouch: Date.now(),
  }
}

function isActive(status: StatsStatus) {
  return status === "waiting" || status === "streaming" || status === "tool"
}

function resetTurn(state: SessionState, startedAt: number) {
  state.status = "waiting"
  state.executionStartedAt = startedAt
  state.stepStartedAt = undefined
  state.stepFirstTokenAt = undefined
  state.stepStreamedAt = undefined
  state.ttftMs = undefined
  state.exactOutput = 0
  state.exactReasoning = 0
  state.durationMs = 0
  state.currentText = 0
  state.currentReasoning = 0
  state.samples = []
  state.currentSpeed = 0
  state.partial = false
  state.hydrated = true
}

function clearStep(state: SessionState) {
  state.stepStartedAt = undefined
  state.stepFirstTokenAt = undefined
  state.stepStreamedAt = undefined
  state.currentText = 0
  state.currentReasoning = 0
  state.samples = []
  state.currentSpeed = 0
}

/** Freezes a partially generated step so interrupted turns keep their numbers. */
function finalizePartial(state: SessionState, endAt: number) {
  const start = state.stepFirstTokenAt
  if (start !== undefined) state.durationMs += Math.max(0, (state.stepStreamedAt ?? endAt) - start)
  state.stepStartedAt = undefined
  state.stepFirstTokenAt = undefined
  state.stepStreamedAt = undefined
  state.samples = []
  state.currentSpeed = 0
  state.partial = state.currentText > 0 || state.currentReasoning > 0
}

function assistantParts(message: AssistantMessage) {
  let text = ""
  let reasoning = ""
  for (const part of message.content) {
    if (part.type === "text") text += part.text
    else if (part.type === "reasoning") reasoning += part.text
  }
  return { text, reasoning }
}

export function createStatsManager(
  context: Context,
  options: PluginOptions,
  onUpdate: () => void,
): StatsManager {
  const [revision, setRevision] = createSignal(0)
  const states = new Map<string, SessionState>()
  let disposed = false

  function bump() {
    if (disposed) return
    setRevision((value) => value + 1)
    onUpdate()
  }

  function trim() {
    if (states.size <= MAX_SESSIONS) return
    const removable = [...states.entries()]
      .filter(([, state]) => !isActive(state.status))
      .sort((left, right) => left[1].lastTouch - right[1].lastTouch)
    for (const [id] of removable) {
      if (states.size <= MAX_SESSIONS) break
      states.delete(id)
    }
  }

  function stateForEvent(sessionID: string) {
    let state = states.get(sessionID)
    if (!state) {
      state = emptyState()
      states.set(sessionID, state)
      trim()
    }
    state.lastTouch = Date.now()
    state.hydrated = true
    state.eventVersion++
    return state
  }

  function hydrate(state: SessionState, sessionID: string) {
    const session = context.data.session.get(sessionID)
    const messages = context.data.session.message.list(sessionID) ?? []
    let lastUser = -1
    for (let index = messages.length - 1; index >= 0; index--) {
      if (messages[index].type === "user") {
        lastUser = index
        break
      }
    }
    if (!session || lastUser < 0) return false

    const assistants = messages
      .slice(lastUser + 1)
      .filter((message): message is AssistantMessage => message.type === "assistant")

    let firstTokenSeen = false
    let streamingAssistant: AssistantMessage | undefined

    for (const assistant of assistants) {
      const firstToken = assistant.time.firstToken
      const streamed = assistant.time.streamed
      const completed = assistant.time.completed

      if (firstToken !== undefined && !firstTokenSeen) {
        state.ttftMs = Math.max(0, firstToken - assistant.time.created)
        firstTokenSeen = true
      }

      if (streamed !== undefined || completed !== undefined) {
        if (assistant.tokens) {
          state.exactOutput += assistant.tokens.output
          state.exactReasoning += assistant.tokens.reasoning
        }
        const end = streamed ?? completed
        if (end !== undefined) {
          state.durationMs += Math.max(0, end - (firstToken ?? assistant.time.created))
        }
      } else {
        streamingAssistant = assistant
      }
    }

    const running = context.data.session.status(sessionID) === "running"
    state.executionStartedAt = session.time.busy ?? assistants[0]?.time.created ?? session.time.created

    if (running && streamingAssistant) {
      state.stepStartedAt = streamingAssistant.time.created
      if (streamingAssistant.time.firstToken === undefined) {
        state.status = "waiting"
      } else {
        state.status = "streaming"
        state.stepFirstTokenAt = streamingAssistant.time.firstToken
        if (state.ttftMs === undefined) {
          state.ttftMs = Math.max(0, streamingAssistant.time.firstToken - streamingAssistant.time.created)
        }
        const parts = assistantParts(streamingAssistant)
        state.currentText = estimateTokens(parts.text)
        state.currentReasoning = estimateTokens(parts.reasoning)
      }
    } else if (running) {
      state.status = state.exactOutput > 0 || state.durationMs > 0 ? "tool" : "waiting"
    } else if (state.exactOutput > 0 || state.durationMs > 0 || state.ttftMs !== undefined) {
      state.status =
        session.outcome === "failed"
          ? "error"
          : session.outcome === "interrupted"
            ? "interrupted"
            : "completed"
    }
    state.hydrated = true
    return true
  }

  async function loadRecentMessages(sessionID: string, signal: AbortSignal) {
    const collected: Message[] = []
    let cursor: string | undefined
    for (let page = 0; page < 3; page++) {
      const response = await context.client.message.list(
        {
          sessionID,
          limit: 200,
          ...(cursor ? { cursor } : { order: "desc" as const }),
        },
        { signal },
      )
      const data = response.data ?? []
      collected.push(...data)
      if (data.some((message) => message.type === "user")) break
      const next = response.cursor?.next ?? null
      if (!next) break
      cursor = next
    }
    return collected
  }

  /** Rebuilds the latest turn from server history when the loaded window is partial. */
  function applyServerTurn(state: SessionState, sessionID: string, messages: Message[]) {
    const userIndex = messages.findIndex((message) => message.type === "user")
    if (userIndex < 0) return false
    const assistants = messages
      .slice(0, userIndex)
      .filter((message): message is AssistantMessage => message.type === "assistant")
    if (assistants.length === 0) return false

    state.exactOutput = 0
    state.exactReasoning = 0
    state.durationMs = 0
    state.ttftMs = undefined
    state.partial = false
    clearStep(state)

    let firstTokenSeen = false
    for (const assistant of assistants.slice().reverse()) {
      const firstToken = assistant.time.firstToken
      if (firstToken !== undefined && !firstTokenSeen) {
        state.ttftMs = Math.max(0, firstToken - assistant.time.created)
        firstTokenSeen = true
      }
      if (assistant.tokens) {
        state.exactOutput += assistant.tokens.output
        state.exactReasoning += assistant.tokens.reasoning
      }
      const end = assistant.time.streamed ?? assistant.time.completed
      if (end !== undefined) {
        state.durationMs += Math.max(
          0,
          end - (firstToken ?? assistant.time.created),
        )
      }
    }

    const session = context.data.session.get(sessionID)
    const hasData =
      state.exactOutput > 0 || state.durationMs > 0 || state.ttftMs !== undefined
    state.status =
      session?.outcome === "failed"
        ? "error"
        : session?.outcome === "interrupted"
          ? "interrupted"
          : hasData
            ? "completed"
            : "idle"
    state.hydrated = true
    return hasData
  }

  function startServerHydration(state: SessionState, sessionID: string) {
    if (
      disposed ||
      state.hydrationInFlight ||
      state.hydrationAttempts >= HYDRATION_MAX_ATTEMPTS
    ) {
      return
    }
    state.hydrationAttempts++
    state.hydrationInFlight = true
    const version = state.eventVersion
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), HYDRATION_TIMEOUT_MS)
    void loadRecentMessages(sessionID, controller.signal)
      .then((messages) => {
        if (disposed || state.eventVersion !== version || isActive(state.status)) return
        if (context.data.session.status(sessionID) === "running") return
        if (applyServerTurn(state, sessionID, messages)) bump()
      })
      .catch(() => undefined)
      .finally(() => {
        clearTimeout(timer)
        state.hydrationInFlight = false
      })
  }

  function ensure(sessionID: string) {
    let state = states.get(sessionID)
    if (state) {
      state.lastTouch = Date.now()
      if (!state.hydrated) state.hydrated = untrack(() => hydrate(state, sessionID))
      startServerHydration(state, sessionID)
      return state
    }
    const created = emptyState()
    states.set(sessionID, created)
    trim()
    created.hydrated = untrack(() => hydrate(created, sessionID))
    startServerHydration(created, sessionID)
    return created
  }

  function computeSpeed(state: SessionState, now: number) {
    const cutoff = now - options.windowMs
    while (state.samples.length > 0 && state.samples[0].at < cutoff) state.samples.shift()
    if (state.samples.length === 0) return 0

    const first = state.samples[0].at
    const elapsed = now - first
    // Wait for a full second so the first reading is not a burst artifact.
    if (elapsed < 1_000) return 0
    const span = Math.min(options.windowMs, elapsed)
    let total = 0
    for (const sample of state.samples) {
      total += options.includeReasoning ? sample.text + sample.reasoning : sample.text
    }
    return total / (span / 1000)
  }

  function tick() {
    if (disposed) return
    const now = Date.now()
    let active = false
    for (const [sessionID, state] of states) {
      if (!state.hydrated && !isActive(state.status)) {
        if (untrack(() => hydrate(state, sessionID))) active = true
        startServerHydration(state, sessionID)
      }
      if (state.status === "waiting" || state.status === "streaming") {
        active = true
        if (state.status === "streaming") state.currentSpeed = computeSpeed(state, now)
      }
    }
    if (active) bump()
  }

  function snapshot(state: SessionState): StatsSnapshot {
    const now = Date.now()
    const live = state.status === "streaming"
    const liveEnd = state.stepStreamedAt ?? now
    const liveDuration =
      live && state.stepFirstTokenAt !== undefined
        ? Math.max(0, liveEnd - state.stepFirstTokenAt)
        : 0
    const includeCurrent = live || state.partial
    const total =
      state.exactOutput +
      (options.includeReasoning ? state.exactReasoning : 0) +
      (includeCurrent
        ? state.currentText + (options.includeReasoning ? state.currentReasoning : 0)
        : 0)
    const duration = state.durationMs + liveDuration
    const averageSpeed = duration > 0 && total > 0 ? total / (duration / 1000) : undefined
    const waitingMs =
      state.status === "waiting" && state.executionStartedAt !== undefined
        ? Math.max(0, now - state.executionStartedAt)
        : undefined

    return {
      status: state.status,
      currentSpeed:
        state.status === "streaming" && state.currentSpeed > 0 ? state.currentSpeed : undefined,
      averageSpeed,
      ttftMs: state.ttftMs,
      outputTokens: total,
      modelDurationMs: duration,
      waitingMs,
      estimated: isActive(state.status) || state.partial,
      hasData:
        total > 0 ||
        duration > 0 ||
        state.ttftMs !== undefined ||
        state.status === "waiting" ||
        state.status === "streaming",
    }
  }

  function handleTextDelta(
    state: SessionState,
    created: number,
    delta: string,
    kind: "text" | "reasoning",
  ) {
    if (kind === "reasoning" && !options.includeReasoning) return
    if (!isActive(state.status)) resetTurn(state, created)
    if (state.status !== "streaming") state.status = "streaming"
    if (state.stepFirstTokenAt === undefined) {
      state.stepFirstTokenAt = created
      if (state.ttftMs === undefined) {
        state.ttftMs = Math.max(0, created - (state.stepStartedAt ?? created))
      }
    }

    const tokens = estimateTokens(delta)
    if (kind === "text") state.currentText += tokens
    else state.currentReasoning += tokens

    state.samples.push({
      at: Date.now(),
      text: kind === "text" ? tokens : 0,
      reasoning: kind === "reasoning" ? tokens : 0,
    })
    // Bound memory between ticks on very fast streams.
    if (state.samples.length > 2_000) state.samples.splice(0, state.samples.length - 2_000)
  }

  const stop = context.data.listen(({ details }) => {
    switch (details.type) {
      case "session.execution.started": {
        const state = stateForEvent(details.data.sessionID)
        resetTurn(state, details.created)
        bump()
        return
      }
      case "session.step.started": {
        const state = stateForEvent(details.data.sessionID)
        if (!isActive(state.status)) resetTurn(state, details.created)
        state.status = "waiting"
        state.stepStartedAt = details.data.started
        state.stepFirstTokenAt = undefined
        state.stepStreamedAt = undefined
        state.currentText = 0
        state.currentReasoning = 0
        state.samples = []
        state.currentSpeed = 0
        if (state.executionStartedAt === undefined) state.executionStartedAt = details.data.started
        bump()
        return
      }
      case "session.step.first-token": {
        const state = stateForEvent(details.data.sessionID)
        if (!isActive(state.status)) resetTurn(state, details.created)
        state.stepFirstTokenAt = details.created
        if (state.ttftMs === undefined) {
          state.ttftMs = Math.max(0, details.created - (state.stepStartedAt ?? details.created))
        }
        state.status = "streaming"
        bump()
        return
      }
      case "session.text.delta": {
        handleTextDelta(
          stateForEvent(details.data.sessionID),
          details.created,
          details.data.delta,
          "text",
        )
        return
      }
      case "session.reasoning.delta": {
        handleTextDelta(
          stateForEvent(details.data.sessionID),
          details.created,
          details.data.delta,
          "reasoning",
        )
        return
      }
      case "session.step.streamed": {
        const state = stateForEvent(details.data.sessionID)
        state.stepStreamedAt = details.created
        state.samples = []
        state.currentSpeed = 0
        bump()
        return
      }
      case "session.step.ended": {
        const state = stateForEvent(details.data.sessionID)
        state.exactOutput += details.data.tokens.output
        state.exactReasoning += details.data.tokens.reasoning
        const start = state.stepFirstTokenAt
        const end = state.stepStreamedAt ?? details.created
        if (start !== undefined) state.durationMs += Math.max(0, end - start)
        clearStep(state)
        state.partial = false
        state.status =
          details.data.finish === "error"
            ? "error"
            : details.data.finish === "tool-calls"
              ? "tool"
              : "completed"
        bump()
        return
      }
      case "session.step.failed": {
        const state = stateForEvent(details.data.sessionID)
        if (details.data.tokens) {
          state.exactOutput += details.data.tokens.output
          state.exactReasoning += details.data.tokens.reasoning
          const start = state.stepFirstTokenAt
          if (start !== undefined) state.durationMs += Math.max(0, details.created - start)
          clearStep(state)
          state.partial = false
        } else {
          finalizePartial(state, details.created)
        }
        state.status = "error"
        bump()
        return
      }
      case "session.execution.succeeded": {
        const state = stateForEvent(details.data.sessionID)
        if (state.status === "streaming" || state.status === "waiting") {
          finalizePartial(state, details.created)
        }
        if (state.status !== "error" && state.status !== "interrupted") state.status = "completed"
        state.currentSpeed = 0
        bump()
        return
      }
      case "session.execution.failed": {
        const state = stateForEvent(details.data.sessionID)
        finalizePartial(state, details.created)
        state.status = "error"
        bump()
        return
      }
      case "session.execution.interrupted": {
        const state = stateForEvent(details.data.sessionID)
        finalizePartial(state, details.created)
        state.status = "interrupted"
        bump()
        return
      }
      case "session.idle": {
        const state = states.get(details.data.sessionID)
        if (!state || !isActive(state.status)) return
        finalizePartial(state, details.created)
        state.status = "completed"
        bump()
        return
      }
      case "session.deleted": {
        states.delete(details.data.sessionID)
        bump()
        return
      }
      default:
        return
    }
  })

  const timer = setInterval(tick, TICK_MS)

  return {
    read(sessionID) {
      const state = ensure(sessionID)
      if (!state.hydrated) state.hydrated = untrack(() => hydrate(state, sessionID))
      startServerHydration(state, sessionID)
      revision()
      return snapshot(state)
    },
    dispose() {
      disposed = true
      stop()
      clearInterval(timer)
    },
  }
}
