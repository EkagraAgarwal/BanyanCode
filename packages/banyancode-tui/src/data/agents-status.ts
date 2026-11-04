import { createSignal } from "solid-js"
import { truncate } from "./format"

/**
 * The one row under the composer on the Agents tab. The panel owns what it
 * says — the transient `say()` message, else what needs the user — and the
 * host's status row (`session.footer`) draws it, so the tab spends no row of
 * its own on a hint line. Chat never reads this: the panel clears it when it
 * unmounts.
 */
export interface AgentsStatus {
  /** The message, else the attention line. Absent when nothing needs saying. */
  readonly text?: string | undefined
  /** The theme role the message is drawn in: amber for attention, coral for stale. */
  readonly tone?: "warning" | "error" | undefined
  /** Right-aligned key hints, most important first. */
  readonly hints: readonly string[]
  /**
   * What clicking the attention message does: pick the agent it names. The
   * footer is host-side, so the panel hands the action over rather than
   * owning a hit region there.
   */
  readonly onAttention?: (() => void) | undefined
}

const [current, write] = createSignal<AgentsStatus | undefined>(undefined)

/** What the Agents tab wants its status row to say; undefined when it is closed. */
export const agentsStatus = current

export function setAgentsStatus(next: AgentsStatus | undefined): void {
  write(next)
}

/** Columns between two blocks of the status row. */
const GAP = 2

export interface AgentsStatusRow {
  readonly left: string
  readonly text: string
  readonly marks: string
  readonly hints: string
}

/** Whole hint segments only, most important first; a segment that does not fit is dropped. */
function fitWhole(width: number, segments: readonly string[]): string {
  if (width <= 0) return ""
  let line = ""
  for (const segment of segments) {
    const next = line === "" ? segment : `${line} · ${segment}`
    if ([...next].length > width) continue
    line = next
  }
  return line
}

/**
 * Fit the row by priority: the directory and branch first, then the message,
 * then the mode marks, and the key hints with whatever is left. A message
 * never takes more than a little over half the free columns, so the hints
 * survive on a wide terminal instead of being pushed off by a long ask.
 */
export function fitAgentsStatusRow(input: {
  readonly width: number
  readonly left: string
  readonly text?: string | undefined
  readonly marks: readonly string[]
  readonly hints: readonly string[]
}): AgentsStatusRow {
  const width = Math.max(0, Math.floor(input.width))
  const marks = input.marks.filter((mark) => mark !== "").join(" ")
  const left = truncate(input.left, Math.max(0, width - (marks === "" ? 0 : [...marks].length + GAP)))
  const reserved = [...left].length + (marks === "" ? 0 : [...marks].length + GAP)
  const room = Math.max(0, width - reserved - (reserved === 0 ? 0 : GAP))
  const wanted = input.text === undefined ? 0 : [...input.text].length
  const budget = Math.max(0, Math.min(Math.floor(room * 0.55), room - (input.hints.length === 0 ? 0 : 12)))
  const text = wanted === 0 ? "" : truncate(input.text!, Math.max(0, Math.min(wanted, budget)))
  const hintRoom = Math.max(0, room - (text === "" ? 0 : [...text].length + 1))
  return { left, text, marks, hints: fitWhole(hintRoom, input.hints) }
}
