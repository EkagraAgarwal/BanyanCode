/** TUI-side diagnostic logger that suppresses stderr writes (which would
 *  corrupt the OpenTUI render frame when the fullscreen TUI is active).
 *  When an Effect runtime is registered, warnings route through the file
 *  logger via Effect.logWarning; otherwise they are silently dropped.
 *
 *  Best-effort and fire-and-forget: if the parent runtime is shutting down
 *  or rejects the forked fiber, the warning is dropped silently. Delivery
 *  is not guaranteed — the contract is "avoid corrupting the OpenTUI frame"
 *  first, "surface to file logger" second. */
import { Effect } from "effect"

type Runtime = { runFork: <A, E>(eff: Effect.Effect<A, E, never>) => void }

let runtime: Runtime | undefined

export function setLoggerRuntime(r: Runtime | undefined) {
  runtime = r
}

export function warn(message: string, details?: Record<string, unknown>) {
  if (!runtime) return
  const eff = details
    ? Effect.logWarning(message).pipe(Effect.annotateLogs({ details }))
    : Effect.logWarning(message)
  runtime.runFork(eff)
}

export const TuiLogger = { warn, setLoggerRuntime }
