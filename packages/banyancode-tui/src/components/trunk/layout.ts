import type { SessionMessageInfo } from "@opencode/client"
import { truncate } from "../../data/format"
import type { ChildState, MeshChild } from "../../data/mesh"
import { currentTool, returnedSummary } from "../../data/messages"
import { ease, gauss } from "../../motion"

/**
 * The trunk rail's geometry and data. Everything here is pure so the branch
 * rules (ordering, capacity, the 7 s farewell) are testable without a renderer.
 * The rail is the left side column of the Chat layout, so widths and heights
 * come from the host's own column maths.
 */

/** Below this terminal width the rail is hidden and agent status moves to the composer. */
export const TRUNK_RAIL_MIN_WIDTH = 110
/** Rows between two branch labels, including the branch's own detail line. */
export const TRUNK_ROW_STEP = 3
/** First branch label row. The root node sits on row 0, then one blank row. */
export const TRUNK_FIRST_BRANCH_ROW = 2
/** Connector cells at full growth. */
export const TRUNK_CONNECTOR_CELLS = 12
/** Connector growth from spawn. */
export const TRUNK_GROW_MS = 450
/** The label starts fading in this long after spawn… */
export const TRUNK_LABEL_DELAY_MS = 300
/** …and takes this long to arrive. */
export const TRUNK_LABEL_FADE_MS = 300
/** A finished branch leaves the rail this long after it stopped working. */
export const TRUNK_SETTLE_MS = 7000
/** Finished branches dim over this long before they leave. */
export const TRUNK_DIM_MS = 1200
/** Trunk pulse speed, in rows per second. */
export const TRUNK_PULSE_SPEED = 9
export const TRUNK_PULSE_SIGMA = 2.4
/** Branch connector pulse, in cells per second. */
export const BRANCH_PULSE_SPEED = 16
export const BRANCH_PULSE_SIGMA = 1.6
/** Attention breathe: `sin(tick * BREATHE_RATE)`, about a one second period. */
export const BREATHE_RATE = 6

const LEVELS = 12

const clamp01 = (value: number) => Math.max(0, Math.min(1, value))

/**
 * Ordering weight. Anything still working comes first — a waiting agent needs
 * the reader's eyes more than a running one, and both come before failures and
 * the finished tail.
 */
const RANK: Record<ChildState, number> = { waiting: 0, running: 1, failed: 2, done: 3 }

export type TrunkBranch = {
  readonly child: MeshChild
  /** Killed through `mesh.kill` rather than failed on its own. */
  readonly killed: boolean
  /** The dim second line: current tool, returned summary, or the failure. */
  readonly detail: string
  /** Milliseconds since the branch appeared. */
  readonly ageMs: number
  /** Milliseconds since it stopped working, for a finished branch. */
  readonly settledMs: number
}

/**
 * One terminal row of the trunk column. A branch is two rows: its label, then
 * the dim detail line under it.
 */
export type TrunkRow =
  | { readonly kind: "root" }
  | { readonly kind: "branch"; readonly branch: TrunkBranch }
  | { readonly kind: "detail"; readonly branch: TrunkBranch }
  | { readonly kind: "more"; readonly count: number }
  | { readonly kind: "blank" }

/** How many branches the rail can label at this height, the `+N more` row included. */
export function trunkCapacity(height: number): number {
  if (!Number.isFinite(height)) return 0
  return Math.max(0, Math.floor((Math.floor(height) - TRUNK_FIRST_BRANCH_ROW - 2) / TRUNK_ROW_STEP) + 1)
}

/**
 * Branch order: work first, then failures, then the finished tail. Ties keep
 * spawn order so a tree never reshuffles under the reader.
 */
export function orderBranches(branches: readonly TrunkBranch[]): TrunkBranch[] {
  return [...branches].sort(
    (a, b) => RANK[a.child.state] - RANK[b.child.state] || a.child.createdAt - b.child.createdAt,
  )
}

/**
 * The detail line for a branch, from real child data only. Blank when the child
 * has produced nothing to say, so the rail never invents narration.
 */
export function branchDetail(input: {
  readonly child: MeshChild
  readonly killed: boolean
  readonly messages: ReadonlyArray<SessionMessageInfo>
  readonly max: number
}): string {
  if (input.killed) return "killed"
  if (input.child.state === "failed") return "failed"
  if (input.child.state === "waiting") {
    const count = input.child.pending
    return count === 1 ? "waiting for you" : `waiting on ${count} requests`
  }
  if (input.child.state === "running") {
    const tool = currentTool(input.messages)
    if (!tool) return ""
    const args = tool.args
    return truncate(args ? `${tool.name} ${args}` : tool.name, input.max)
  }
  return truncate(returnedSummary(input.messages) ?? "", input.max)
}

/**
 * Every direct child as a rail branch. A finished branch leaves after
 * `TRUNK_SETTLE_MS`; failures and kills stay until the mesh drops them.
 */
export function trunkBranches(input: {
  readonly children: readonly MeshChild[]
  readonly killed: ReadonlySet<string>
  readonly messages: (sessionID: string) => ReadonlyArray<SessionMessageInfo>
  readonly now: number
  readonly maxDetail: number
}): TrunkBranch[] {
  return input.children.flatMap((child) => {
    const killed = input.killed.has(child.sessionID)
    const ageMs = Math.max(0, input.now - child.createdAt)
    const settledMs =
      child.state === "done"
        ? Math.max(0, input.now - (child.lastActivityAt ?? child.createdAt))
        : child.state === "failed"
          ? ageMs
          : 0
    if (child.state === "done" && !killed && settledMs >= TRUNK_SETTLE_MS) return []
    return [
      {
        child,
        killed,
        ageMs,
        settledMs,
        detail: branchDetail({
          child,
          killed,
          messages: input.messages(child.sessionID),
          max: input.maxDetail,
        }),
      },
    ]
  })
}

/** Connector cells a branch has grown after `ageMs`. */
export function connectorCells(ageMs: number, animations = true): number {
  if (!animations) return TRUNK_CONNECTOR_CELLS
  return Math.round(TRUNK_CONNECTOR_CELLS * ease(ageMs / TRUNK_GROW_MS))
}

/** Label opacity after `ageMs`: it fades in at 300 ms, over 300 ms. */
export function labelOpacity(ageMs: number, animations = true): number {
  if (!animations) return 1
  return clamp01((ageMs - TRUNK_LABEL_DELAY_MS) / TRUNK_LABEL_FADE_MS)
}

/** How much a finished branch has dimmed, 0 (fresh) to 1 (gone). */
export function dimProgress(settledMs: number, animations = true): number {
  if (!animations) return 1
  return clamp01(settledMs / TRUNK_DIM_MS)
}

/** Highlight intensity of the trunk column at row `y`. */
export function trunkLevel(y: number, tick: number, height: number): number {
  if (height <= 0) return 0
  const span = height + 10
  const head = ((Math.max(0, tick) * TRUNK_PULSE_SPEED) % span) - 5
  return clamp01(gauss(y - head, TRUNK_PULSE_SIGMA))
}

/** Attention breathe, 0..1, about a one second period. */
export function breathe(tick: number): number {
  return 0.5 + 0.5 * Math.sin(Math.max(0, tick) * BREATHE_RATE)
}

export interface ConnectorRun {
  readonly text: string
  /** 0..1 highlight intensity along the connector. */
  readonly level: number
}

/**
 * The connector to the trunk as colour runs. Idle and finished branches are one
 * unlit run; a running branch carries a travelling lobe.
 */
export function connectorRuns(input: {
  readonly cells: number
  readonly tick: number
  readonly index: number
  readonly running: boolean
}): ConnectorRun[] {
  const cells = Math.max(0, Math.min(TRUNK_CONNECTOR_CELLS, Math.floor(input.cells)))
  if (cells === 0) return []
  if (!input.running) return [{ text: "─".repeat(cells), level: 0 }]
  const period = TRUNK_CONNECTOR_CELLS + 6
  const runs: ConnectorRun[] = []
  for (let cell = 1; cell <= cells; cell++) {
    const head = ((Math.max(0, input.tick) * BRANCH_PULSE_SPEED + input.index * 5) % period) - 2
    const level = Math.round(gauss(cell - head, BRANCH_PULSE_SIGMA) * LEVELS) / LEVELS
    const previous = runs.at(-1)
    if (previous && previous.level === level) {
      runs[runs.length - 1] = { text: previous.text + "─", level }
      continue
    }
    runs.push({ text: "─", level })
  }
  return runs
}

/**
 * The rail's rows for a height. Branch labels sit `TRUNK_ROW_STEP` apart and own
 * the dim row below them, so nothing ever overlaps and the `+N more` row takes
 * the last branch slot instead of spilling past the column.
 */
export function trunkRows(input: { readonly height: number; readonly branches: readonly TrunkBranch[] }): TrunkRow[] {
  const height = Math.max(0, Math.floor(input.height))
  if (height === 0) return []
  const ordered = orderBranches(input.branches)
  const capacity = trunkCapacity(height)
  const overflow = ordered.length > capacity
  const visible = ordered.slice(0, Math.max(0, overflow ? capacity - 1 : capacity))
  const rows: TrunkRow[] = [{ kind: "root" }]
  for (const branch of visible) {
    rows.push({ kind: "blank" }, { kind: "branch", branch }, { kind: "detail", branch })
  }
  if (overflow) rows.push({ kind: "blank" }, { kind: "more", count: ordered.length - visible.length }, { kind: "blank" })
  while (rows.length < height) rows.push({ kind: "blank" })
  return rows.slice(0, height)
}

/** Milliseconds until this branch stops moving, or `Infinity` while it works. */
export function motionRemaining(branch: TrunkBranch, now: number): number {
  if (branch.child.state === "running" || branch.child.state === "waiting") return Number.POSITIVE_INFINITY
  if (branch.child.state === "failed") return Math.max(0, TRUNK_GROW_MS + TRUNK_LABEL_DELAY_MS + TRUNK_LABEL_FADE_MS - branch.ageMs)
  return Math.max(
    0,
    Math.max(
      TRUNK_GROW_MS + TRUNK_LABEL_DELAY_MS + TRUNK_LABEL_FADE_MS - branch.ageMs,
      TRUNK_SETTLE_MS - branch.settledMs,
    ),
  )
}

/**
 * How a branch label fits in the columns left of the trunk. The label is
 * right-aligned against its connector, so a growing connector pushes it left,
 * exactly as the mockup does.
 */
export function branchLabelLayout(input: {
  readonly name: string
  readonly cells: number
  /** Columns available left of the trunk cell. */
  readonly area: number
}): { readonly name: string; readonly cells: number; readonly pad: number } {
  const area = Math.max(0, Math.floor(input.area))
  // The name needs at least one column, then one space and the state glyph
  // follow it, then a space on each side of the connector.
  const cells = Math.max(0, Math.min(Math.floor(input.cells), area - 4))
  const name = truncate(input.name, Math.max(1, area - cells - 3))
  return { name, cells, pad: Math.max(0, area - name.length - cells - 3) }
}

