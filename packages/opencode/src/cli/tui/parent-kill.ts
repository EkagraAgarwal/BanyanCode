/**
 * Parent-owned Ctrl+C kill escalation.
 *
 * The TUI parent process hosts the renderer while the worker thread hosts the
 * server + codegraph indexer. A wedged worker can leave the user trapped:
 * the keymap's `codegraph.cancel` RPC never resolves and the renderer never
 * receives new events. This controller gives the PARENT a way to force-exit
 * that does not depend on the worker acknowledging anything.
 *
 * Escalation (only while the controller is armed — i.e. a codegraph build is
 * active/stuck):
 *   - first Ctrl+C byte: fire-and-forget the cancel RPC and arm a short
 *     window;
 *   - second Ctrl+C byte within the window: hard kill (terminate + exit);
 *   - cancel not acknowledged within the window: hard kill.
 *
 * The app arms/disarms the controller via `setArmed` as the codegraph build
 * state transitions, so an idle app never hard-kills on a stray Ctrl+C (e.g.
 * double-pressing Ctrl+C while typing a prompt).
 */
export const KILL_ESCALATION_MS = 2_000

export type ParentKillOptions = {
  now?: () => number
  windowMs?: number
  onCancel: () => void
  onKill: () => void
}

export function createParentKill({
  now = Date.now,
  windowMs = KILL_ESCALATION_MS,
  onCancel,
  onKill,
}: ParentKillOptions) {
  let armed = false
  let lastCancelAt = -1
  let cancelInFlight = false
  let timer: ReturnType<typeof setTimeout> | undefined

  const clearTimer = () => {
    if (timer) {
      clearTimeout(timer)
      timer = undefined
    }
  }

  return {
    /** Arm/disarm the escalation. Call with `false` when the build ends. */
    setArmed(active: boolean) {
      armed = active
      if (!active) {
        cancelInFlight = false
        lastCancelAt = -1
        clearTimer()
      }
    },
    /** Observe a raw Ctrl+C byte (0x03) arriving at the parent stdin. */
    onRawCtrlC() {
      if (!armed) return
      const t = now()
      if (lastCancelAt !== -1 && t - lastCancelAt < windowMs) {
        // Second press within the window: the first cancel did not land (or
        // the user wants out). Hard kill.
        cancelInFlight = false
        lastCancelAt = -1
        clearTimer()
        onKill()
        return
      }
      lastCancelAt = t
      cancelInFlight = true
      onCancel()
      clearTimer()
      timer = setTimeout(() => {
        timer = undefined
        // The cancel was never acknowledged within the window — the worker is
        // wedged. Hard kill.
        if (armed && cancelInFlight) {
          cancelInFlight = false
          lastCancelAt = -1
          onKill()
        }
      }, windowMs)
    },
    /** Call when the worker acknowledges the cancel RPC. */
    cancelAcked() {
      if (!cancelInFlight) return
      cancelInFlight = false
      lastCancelAt = -1
      clearTimer()
    },
    dispose() {
      armed = false
      cancelInFlight = false
      lastCancelAt = -1
      clearTimer()
    },
  }
}

/**
 * Subscribe to raw stdin bytes and feed Ctrl+C (0x03) to the controller.
 * Multiple `data` listeners are supported — this does not consume the stream
 * from the TUI renderer.
 */
export function watchParentCtrlC(
  controller: ReturnType<typeof createParentKill>,
  input: { stdin?: NodeJS.ReadableStream } = {},
) {
  const stdin = input.stdin ?? process.stdin
  const onData = (chunk: unknown) => {
    const data = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : (chunk as Uint8Array)
    for (const byte of data) {
      if (byte === 0x03) controller.onRawCtrlC()
    }
  }
  stdin.on("data", onData)
  return () => {
    stdin.off("data", onData)
  }
}
