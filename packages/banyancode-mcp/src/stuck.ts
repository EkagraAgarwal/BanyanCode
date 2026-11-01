// Stuck / loop detection for `banyan_checkup`.
//
// Two independent signals, deliberately cheap:
// - no durable progress for longer than a threshold while the task claims to
//   be running (a wedged model call, a tool waiting on a dead socket);
// - a repeating identical tool call (same tool name and same canonical input)
//   more than N times in a row, which is the observable shape of an agent loop.
//
// Pure functions: the engine passes the digest counters and the checkup
// formatter reports them.

export const DEFAULT_STUCK_AFTER_MS = 5 * 60_000
export const DEFAULT_LOOP_THRESHOLD = 3

export type StuckStatus = "queued" | "running" | "needs_input" | "done" | "failed" | "cancelled"

export type StuckSignal =
  | { kind: "no_progress"; detail: string; staleMs: number }
  | { kind: "loop"; detail: string; repeats: number }

export function detectStuck(input: {
  status: StuckStatus
  lastEventAt?: number | undefined
  now: number
  stuckAfterMs?: number | undefined
  recentToolCalls?: readonly string[] | undefined
  loopThreshold?: number | undefined
}): StuckSignal | undefined {
  // Terminal and waiting-for-input tasks are not "stuck": one is finished and
  // the other is blocked on a human by design.
  if (input.status !== "running") return undefined
  const threshold = Math.max(1_000, input.stuckAfterMs ?? DEFAULT_STUCK_AFTER_MS)
  if (input.lastEventAt !== undefined && input.now - input.lastEventAt > threshold) {
    return {
      kind: "no_progress",
      detail: `no durable progress for ${Math.round((input.now - input.lastEventAt) / 1000)}s`,
      staleMs: input.now - input.lastEventAt,
    }
  }
  const loopThreshold = Math.max(2, input.loopThreshold ?? DEFAULT_LOOP_THRESHOLD)
  const calls = input.recentToolCalls ?? []
  if (calls.length < loopThreshold) return undefined
  const tail = calls[calls.length - 1]
  let repeats = 0
  for (let index = calls.length - 1; index >= 0; index -= 1) {
    if (calls[index] !== tail) break
    repeats += 1
  }
  if (repeats >= loopThreshold) {
    return { kind: "loop", detail: `the same tool call repeated ${repeats} times in a row`, repeats }
  }
  return undefined
}

// How long the caller should wait before the next checkup. Cheap tasks that
// are moving fast get a short interval; blocked or stuck tasks get a longer
// one so the caller does not burn tokens polling.
export function suggestCheckupSeconds(input: {
  status: StuckStatus
  stuck?: StuckSignal | undefined
  lastEventAt?: number | undefined
  now: number
}): number | undefined {
  if (input.status === "done" || input.status === "failed" || input.status === "cancelled") return undefined
  if (input.status === "needs_input") return 30
  if (input.stuck !== undefined) return 60
  if (input.lastEventAt === undefined) return 15
  const idleSeconds = (input.now - input.lastEventAt) / 1000
  if (idleSeconds < 60) return 20
  if (idleSeconds < 300) return 45
  return 60
}

export * as Stuck from "./stuck"
