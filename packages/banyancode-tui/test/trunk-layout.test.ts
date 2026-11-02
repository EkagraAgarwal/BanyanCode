import { expect, test } from "bun:test"
import {
  BRANCH_PULSE_SIGMA,
  BRANCH_PULSE_SPEED,
  branchDetail,
  branchLabelLayout,
  breathe,
  connectorCells,
  connectorRuns,
  dimProgress,
  labelOpacity,
  orderBranches,
  TRUNK_CONNECTOR_CELLS,
  TRUNK_GROW_MS,
  TRUNK_LABEL_DELAY_MS,
  TRUNK_LABEL_FADE_MS,
  TRUNK_PULSE_SIGMA,
  TRUNK_PULSE_SPEED,
  TRUNK_SETTLE_MS,
  trunkBranches,
  trunkCapacity,
  trunkLevel,
  trunkRows,
  type TrunkBranch,
} from "../src/components/trunk/layout"
import type { MeshChild } from "../src/data/mesh"

const NOW = 1_700_000_000_000

function child(input: Partial<MeshChild> & { readonly sessionID: string }): MeshChild {
  return {
    agent: "explore",
    state: "running",
    cost: 0,
    tokens: 0,
    createdAt: NOW - 1_000,
    lastActivityAt: NOW - 1_000,
    pending: 0,
    ...input,
  }
}

function branch(input: Partial<TrunkBranch> & { readonly child: MeshChild }): TrunkBranch {
  return { killed: false, detail: "", ageMs: 1_000, settledMs: 0, ...input }
}

test("motion constants match the motion spec", () => {
  expect(TRUNK_CONNECTOR_CELLS).toBe(12)
  expect(TRUNK_GROW_MS).toBe(450)
  expect(TRUNK_LABEL_DELAY_MS).toBe(300)
  expect(TRUNK_LABEL_FADE_MS).toBe(300)
  expect(TRUNK_SETTLE_MS).toBe(7000)
  expect(TRUNK_PULSE_SPEED).toBe(9)
  expect(TRUNK_PULSE_SIGMA).toBe(2.4)
  expect(BRANCH_PULSE_SPEED).toBe(16)
  expect(BRANCH_PULSE_SIGMA).toBe(1.6)
  // Attention breathe runs at about a one second period.
  expect(breathe(0)).toBeCloseTo(0.5, 6)
  expect(breathe(Math.PI / 12)).toBeCloseTo(1, 6)
})

test("a branch grows its connector over 450 ms with an ease-out", () => {
  expect(connectorCells(0)).toBe(0)
  expect(connectorCells(TRUNK_GROW_MS / 2)).toBe(Math.round(12 * 0.875))
  expect(connectorCells(TRUNK_GROW_MS)).toBe(12)
  expect(connectorCells(TRUNK_GROW_MS + 1)).toBe(12)
  // Animations off shows the grown connector at once.
  expect(connectorCells(0, false)).toBe(12)
})

test("a label fades in at 300 ms over 300 ms", () => {
  expect(labelOpacity(0)).toBe(0)
  expect(labelOpacity(TRUNK_LABEL_DELAY_MS)).toBe(0)
  expect(labelOpacity(TRUNK_LABEL_DELAY_MS + TRUNK_LABEL_FADE_MS / 2)).toBeCloseTo(0.5, 6)
  expect(labelOpacity(TRUNK_LABEL_DELAY_MS + TRUNK_LABEL_FADE_MS)).toBe(1)
  expect(labelOpacity(0, false)).toBe(1)
})

test("a finished branch dims over 1.2 s", () => {
  expect(dimProgress(0)).toBe(0)
  expect(dimProgress(600)).toBeCloseTo(0.5, 6)
  expect(dimProgress(1_200)).toBe(1)
  expect(dimProgress(0, false)).toBe(1)
})

test("the trunk pulse travels at nine rows a second", () => {
  // The head enters five rows above the column and moves down one row per 1/9 s.
  const head = (tick: number) => ((tick * TRUNK_PULSE_SPEED) % 58) - 5
  for (const tick of [0, 1 / 9, 2 / 9, 1]) {
    const row = head(tick)
    expect(trunkLevel(row, tick, 48)).toBeCloseTo(1, 6)
    expect(trunkLevel(row + TRUNK_PULSE_SIGMA * 4, tick, 48)).toBeLessThan(0.001)
  }
  // Idle rows carry no highlight.
  expect(trunkLevel(10, 0, 48)).toBeLessThan(1)
})

test("a running connector carries a travelling lobe, a finished one does not", () => {
  const running = connectorRuns({ cells: 12, tick: 0.5, index: 0, running: true })
  expect(running.reduce((sum, run) => sum + run.text.length, 0)).toBe(12)
  expect(Math.max(...running.map((run) => run.level))).toBeGreaterThan(0.8)
  const idle = connectorRuns({ cells: 12, tick: 0.5, index: 0, running: false })
  expect(idle).toEqual([{ text: "─".repeat(12), level: 0 }])
  expect(connectorRuns({ cells: 0, tick: 0, index: 0, running: true })).toEqual([])
})

test("ordering puts work first and keeps spawn order inside a state", () => {
  const branches = [
    branch({ child: child({ sessionID: "a", state: "done", createdAt: 1 }) }),
    branch({ child: child({ sessionID: "b", state: "running", createdAt: 3 }) }),
    branch({ child: child({ sessionID: "c", state: "waiting", createdAt: 4, pending: 1 }) }),
    branch({ child: child({ sessionID: "d", state: "failed", createdAt: 2 }) }),
    branch({ child: child({ sessionID: "e", state: "running", createdAt: 1 }) }),
  ]
  expect(orderBranches(branches).map((item) => item.child.sessionID)).toEqual(["c", "e", "b", "d", "a"])
})

test("a finished branch leaves after seven seconds, failures stay", () => {
  const done = branch({
    child: child({ sessionID: "done", state: "done", lastActivityAt: NOW - 2_000 }),
  })
  const expired = branch({
    child: child({ sessionID: "expired", state: "done", lastActivityAt: NOW - TRUNK_SETTLE_MS }),
  })
  const failed = branch({ child: child({ sessionID: "failed", state: "failed", lastActivityAt: NOW - 60_000 }) })
  const killed = branch({ child: child({ sessionID: "killed", state: "done", lastActivityAt: NOW - 60_000 }), killed: true })
  const rows = trunkBranches({
    children: [done.child, expired.child, failed.child, killed.child],
    killed: new Set(["killed"]),
    messages: () => [],
    now: NOW,
    maxDetail: 40,
  })
  expect(rows.map((item) => item.child.sessionID)).toEqual(["done", "failed", "killed"])
})

test("a detail line only ever restates real child data", () => {
  expect(branchDetail({ child: child({ sessionID: "a", state: "running" }), killed: false, messages: [], max: 40 })).toBe(
    "",
  )
  expect(
    branchDetail({
      child: child({ sessionID: "a", state: "waiting", pending: 2 }),
      killed: false,
      messages: [],
      max: 40,
    }),
  ).toBe("waiting on 2 requests")
  expect(
    branchDetail({
      child: child({ sessionID: "a", state: "waiting", pending: 1 }),
      killed: false,
      messages: [],
      max: 40,
    }),
  ).toBe("waiting for you")
  expect(branchDetail({ child: child({ sessionID: "a", state: "failed" }), killed: false, messages: [], max: 40 })).toBe(
    "failed",
  )
  expect(branchDetail({ child: child({ sessionID: "a", state: "failed" }), killed: true, messages: [], max: 40 })).toBe(
    "killed",
  )
  expect(branchDetail({ child: child({ sessionID: "a", state: "done" }), killed: false, messages: [], max: 40 })).toBe(
    "",
  )
})

test("a label fits the columns left of the trunk", () => {
  // Name, a space, the state glyph, a space either side of the connector.
  const roomy = branchLabelLayout({ name: "explore", cells: 12, area: 40 })
  expect(roomy.name).toBe("explore")
  expect(roomy.cells).toBe(12)
  expect(roomy.pad).toBe(40 - 7 - 12 - 3)

  const tight = branchLabelLayout({ name: "a-very-long-agent-name", cells: 12, area: 20 })
  expect(tight.name.length + tight.cells + 3).toBeLessThanOrEqual(20)
  expect(tight.pad).toBeGreaterThanOrEqual(0)

  const tiny = branchLabelLayout({ name: "explore", cells: 12, area: 4 })
  expect(tiny.cells).toBe(0)
  expect(tiny.name.length + tiny.cells + 3).toBeLessThanOrEqual(4)
})

test("capacity keeps every branch inside the column", () => {
  expect(trunkCapacity(0)).toBe(0)
  expect(trunkCapacity(5)).toBe(1)
  expect(trunkCapacity(30)).toBe(9)
  expect(trunkCapacity(48)).toBe(15)
  const branches = Array.from({ length: 15 }, (_, index) =>
    branch({ child: child({ sessionID: `s${index}` }) }),
  )
  for (const height of [6, 10, 20, 30, 48, 55]) {
    const rows = trunkRows({ height, branches })
    expect(rows).toHaveLength(height)
    expect(rows.filter((row) => row.kind === "branch").length).toBeLessThanOrEqual(trunkCapacity(height))
  }
})
