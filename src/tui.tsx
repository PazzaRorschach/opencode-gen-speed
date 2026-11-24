/** @jsxImportSource @opentui/solid */

import { Plugin } from "@opencode/plugin/tui"
import { Show } from "solid-js"
import { FooterStatus } from "./components/FooterStatus"
import { StatsCard } from "./components/StatsCard"
import { createStatsManager } from "./lib/stats"
import { readOptions } from "./options"

const DIALOG_WIDTH = 60
const REPAINT_INTERVAL_MS = 80
const SLOT_REMOUNT_MS = 1_000

export default Plugin.define({
  id: "opencode-gen-speed",
  setup(context) {
    const options = readOptions(context.options)
    let repaintTimer: ReturnType<typeof setTimeout> | undefined
    let footerHandle: (() => void) | undefined
    let footerTimer: ReturnType<typeof setTimeout> | undefined
    let footerRemountedAt = 0
    let dialogSessionID: string | undefined
    let dialogTimer: ReturnType<typeof setTimeout> | undefined
    let dialogRefreshedAt = 0
    let dialogGeneration = 0
    let mouseAttached = false
    let mouseBuffer = ""

    function requestRepaint() {
      if (repaintTimer !== undefined) return
      repaintTimer = setTimeout(() => {
        repaintTimer = undefined
        try {
          context.renderer.requestRender()
        } catch {
          // The host owns the renderer; a missing frame hook is not fatal.
        }
      }, REPAINT_INTERVAL_MS)
    }

    function attachFooter() {
      if (!options.footer) return
      footerHandle = context.ui.slot({
        append: "prompt.footer.status",
        render: (input) => (
          <Show when={input.mode === "normal" ? input.sessionID : undefined} keyed>
            {(sessionID: string) => (
              <FooterStatus context={context} manager={manager} sessionID={sessionID} />
            )}
          </Show>
        ),
      })
    }

    // OpenCode 2.3.x does not repaint plugin-owned Solid updates in the prompt
    // footer on its own. Re-claim the small status slot on a slow cadence so a
    // fresh mount reads the current snapshot.
    function requestFooterRemount() {
      if (!options.footer || footerTimer !== undefined) return
      const wait = Math.max(0, SLOT_REMOUNT_MS - (Date.now() - footerRemountedAt))
      footerTimer = setTimeout(() => {
        footerTimer = undefined
        footerRemountedAt = Date.now()
        try {
          footerHandle?.()
        } catch {
          // A stale handle is harmless; the next remount replaces it.
        }
        try {
          attachFooter()
        } catch {
          // Keep the dialog usable even when the host rejects the slot.
        }
      }, wait)
    }

    // Custom dialog content is not hit-tested for mouse input on 2.3.x. Watch
    // stdin while the popup is open so clicking the visible `esc` dismisses it.
    function onStdinData(chunk: Buffer | string) {
      mouseBuffer += typeof chunk === "string" ? chunk : chunk.toString("utf8")
      const pattern = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g
      let pressed = false
      let consumed = 0
      let match: RegExpExecArray | null
      while ((match = pattern.exec(mouseBuffer))) {
        consumed = pattern.lastIndex
        if (match[4] === "M" && Number(match[1]) === 0) pressed = true
      }
      if (consumed > 0) mouseBuffer = mouseBuffer.slice(consumed)
      // Keep a partial escape sequence that may continue in the next chunk.
      const escape = mouseBuffer.lastIndexOf("\x1b")
      mouseBuffer = escape >= 0 ? mouseBuffer.slice(escape) : ""
      if (mouseBuffer.length > 64) mouseBuffer = mouseBuffer.slice(-64)
      if (pressed) closeDialog()
    }

    function attachMouse() {
      if (mouseAttached) return
      const stdin = context.renderer.stdin
      if (!stdin) return
      mouseAttached = true
      mouseBuffer = ""
      stdin.on("data", onStdinData)
    }

    function detachMouse() {
      if (!mouseAttached) return
      mouseAttached = false
      mouseBuffer = ""
      const stdin = context.renderer.stdin
      if (stdin) stdin.off("data", onStdinData)
    }

    function closeDialog() {
      const hadDialog = dialogSessionID !== undefined
      dialogGeneration++
      detachMouse()
      dialogSessionID = undefined
      if (!hadDialog) return
      try {
        context.ui.dialog.clear()
      } catch {
        // The dialog may already be closed.
      }
    }

    function showDialog(sessionID: string, generation = ++dialogGeneration) {
      dialogSessionID = sessionID
      attachMouse()
      context.ui.dialog.set({ size: "large", centered: true })
      context.ui.dialog.show(
        () => (
          <StatsCard
            context={context}
            manager={manager}
            sessionID={sessionID}
            width={DIALOG_WIDTH}
          />
        ),
        () => {
          // Ignore the close event caused by our own clear+show refresh.
          if (generation !== dialogGeneration) return
          dialogGeneration++
          dialogSessionID = undefined
          detachMouse()
        },
      )
    }

    function openDialog() {
      const route = context.ui.router.current()
      if (route.type !== "session") {
        context.ui.toast.show({
          message: "请先在会话中打开生成速度",
          variant: "warning",
        })
        return
      }
      showDialog(route.sessionID)
    }

    // A custom dialog is also plugin-owned content; refresh it while visible
    // so the speed and token numbers do not freeze on the opening snapshot.
    function requestDialogRefresh() {
      if (!dialogSessionID || dialogTimer !== undefined) return
      const wait = Math.max(0, SLOT_REMOUNT_MS - (Date.now() - dialogRefreshedAt))
      dialogTimer = setTimeout(() => {
        dialogTimer = undefined
        if (!dialogSessionID) return
        const sessionID = dialogSessionID
        dialogRefreshedAt = Date.now()
        // Invalidate the old close callback before clearing so the refresh
        // cannot be mistaken for a user close.
        const generation = ++dialogGeneration
        try {
          context.ui.dialog.clear()
        } catch {
          // The dialog may already be closed; reopen below.
        }
        if (dialogSessionID === sessionID) showDialog(sessionID, generation)
      }, wait)
    }

    function onUpdate() {
      requestRepaint()
      requestFooterRemount()
      requestDialogRefresh()
    }

    const manager = createStatsManager(context, options, onUpdate)

    attachFooter()

    context.keymap.layer(() => ({
      mode: "global",
      priority: 10,
      commands: [
        {
          id: "gen-speed.open",
          title: "查看生成速度",
          description: "弹出当前会话的实时生成速度与 Token 用量",
          group: "Token Stats",
          bind: false,
          palette: true,
          slash: { name: "speed", aliases: ["tokens", "tps"] },
          run: openDialog,
        },
        {
          id: "gen-speed.dismiss",
          title: "关闭生成速度",
          bind: "escape",
          run: () => {
            if (!dialogSessionID) return false
            closeDialog()
          },
        },
      ],
    }))

    return () => {
      if (repaintTimer !== undefined) clearTimeout(repaintTimer)
      if (footerTimer !== undefined) clearTimeout(footerTimer)
      if (dialogTimer !== undefined) clearTimeout(dialogTimer)
      detachMouse()
      dialogSessionID = undefined
      manager.dispose()
      try {
        context.ui.dialog.clear()
      } catch {
        // The dialog may already be closed.
      }
      try {
        footerHandle?.()
      } catch {
        // The host may already have removed the claim.
      }
    }
  },
})
