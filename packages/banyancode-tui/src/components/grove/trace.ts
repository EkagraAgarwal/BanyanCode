import type { ChildState } from "../../data/mesh"

/**
 * Remembers when each agent was first seen running and when it last finished,
 * so motion only plays on real transitions. An agent first seen already
 * finished is never animated: its `seenAt` and `finishedAt` stay undefined,
 * which `groveAges` reports as "long ago".
 */
export interface GroveTraceEntry {
  readonly state: ChildState
  readonly seenAt?: number | undefined
  readonly finishedAt?: number | undefined
}

export interface GroveTraceItem {
  readonly id: string
  readonly state: ChildState
}

export interface GroveAges {
  /** Seconds since the agent started running, or Infinity when it never did. */
  readonly spawn: number
  /** Seconds since the agent finished, or Infinity when it has not (or never will). */
  readonly finish: number
}

const RUNNING: ReadonlySet<ChildState> = new Set(["running", "waiting"])
const FINISHED: ReadonlySet<ChildState> = new Set(["done", "failed"])

/**
 * Fold the current agent list into the previous trace. `time` is the shared
 * ticker's seconds; `undefined` means animations are off, and transitions are
 * recorded as final states with nothing to animate.
 */
export function updateGroveTrace(
  previous: ReadonlyMap<string, GroveTraceEntry>,
  items: readonly GroveTraceItem[],
  time: number | undefined,
): ReadonlyMap<string, GroveTraceEntry> {
  const present = new Set(items.map((item) => item.id))
  const next = new Map<string, GroveTraceEntry>()
  let changed = previous.size !== items.length || [...previous.keys()].some((key) => !present.has(key))

  for (const item of items) {
    const before = previous.get(item.id)
    const entry = before === undefined ? entered(item.state, time) : transition(before, item.state, time)
    if (entry !== before) changed = true
    next.set(item.id, entry)
  }
  return changed ? next : previous
}

function entered(state: ChildState, time: number | undefined): GroveTraceEntry {
  if (time === undefined) return { state }
  if (RUNNING.has(state)) return { state, seenAt: time }
  return { state }
}

function transition(before: GroveTraceEntry, state: ChildState, time: number | undefined): GroveTraceEntry {
  if (before.state === state) return before
  if (time === undefined) return { state }
  if (FINISHED.has(state) && RUNNING.has(before.state)) {
    return { state, seenAt: before.seenAt, finishedAt: time }
  }
  if (RUNNING.has(state)) return { state, seenAt: time }
  return { state, seenAt: before.seenAt }
}

export function groveAges(entry: GroveTraceEntry | undefined, time: number): GroveAges {
  if (entry === undefined) return { spawn: Number.POSITIVE_INFINITY, finish: Number.POSITIVE_INFINITY }
  return {
    spawn: entry.seenAt === undefined ? Number.POSITIVE_INFINITY : Math.max(0, time - entry.seenAt),
    finish: entry.finishedAt === undefined ? Number.POSITIVE_INFINITY : Math.max(0, time - entry.finishedAt),
  }
}
