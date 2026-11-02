import { expect, test } from "bun:test"
import { RGBA } from "@opentui/core"
import { attentionBlend, attentionColor, branchGrowth, returnPulse, unfoldRows } from "../src/components/grove/motion"
import { groveAges, updateGroveTrace, type GroveTraceEntry } from "../src/components/grove/trace"

test("a spawned branch grows horizontally, drops, then unfolds the pane", () => {
  expect(branchGrowth(0)).toEqual({ horizontal: 0, drop: 0, unfold: 0 })
  const horizontal = branchGrowth(0.4)
  expect(horizontal.horizontal).toBe(1)
  expect(horizontal.drop).toBe(0)
  expect(horizontal.unfold).toBe(0)
  const dropped = branchGrowth(0.7)
  expect(dropped.drop).toBe(1)
  expect(dropped.unfold).toBe(0)
  const unfolded = branchGrowth(1.2)
  expect(unfolded).toEqual({ horizontal: 1, drop: 1, unfold: 1 })
  // An agent first seen finished has an infinite age, which reads as final.
  expect(branchGrowth(Number.POSITIVE_INFINITY).unfold).toBe(1)
})

test("the return pulse reaches the trunk, then the pane dims", () => {
  expect(returnPulse(0)).toEqual({ travel: 0, dim: 0 })
  expect(returnPulse(0.8).travel).toBe(1)
  expect(returnPulse(0.8).dim).toBe(0)
  expect(returnPulse(2).dim).toBe(1)
  expect(returnPulse(Number.POSITIVE_INFINITY).dim).toBe(1)
})

test("attention breathes on about a one-second period and never quite settles", () => {
  expect(attentionBlend(0)).toBeCloseTo(0.5, 6)
  expect(attentionBlend(0.25)).toBeCloseTo(1, 6)
  expect(attentionBlend(0.75)).toBeCloseTo(0, 6)
  expect(attentionBlend(1)).toBeCloseTo(0.5, 6)
  const amber = RGBA.fromInts(232, 177, 90)
  const line = RGBA.fromInts(43, 56, 46)
  expect(attentionColor(amber, line, 0).toInts()).not.toEqual(attentionColor(amber, line, 0.25).toInts())
  const blended = attentionColor(amber, line, 0.25).toInts()
  expect(blended[0]).toBeGreaterThan(43)
  expect(blended[0]).toBeLessThan(232)
})

test("a pane unfolds a growing number of rows", () => {
  expect(unfoldRows(20, 0)).toBe(0)
  expect(unfoldRows(20, 0.3)).toBe(6)
  expect(unfoldRows(20, 0.99)).toBe(20)
  expect(unfoldRows(20, 1)).toBe(20)
  expect(unfoldRows(2, 0.1)).toBe(2)
})

test("an agent first seen already finished is never animated", () => {
  const trace = updateGroveTrace(new Map(), [{ id: "done", state: "done" }], 4)
  const entry = trace.get("done") as GroveTraceEntry
  expect(entry.seenAt).toBeUndefined()
  expect(entry.finishedAt).toBeUndefined()
  expect(groveAges(entry, 10)).toEqual({ spawn: Number.POSITIVE_INFINITY, finish: Number.POSITIVE_INFINITY })
})

test("a running agent records its spawn, and finishing records one return", () => {
  let trace = updateGroveTrace(new Map(), [{ id: "a", state: "running" }], 2)
  expect(trace.get("a")).toEqual({ state: "running", seenAt: 2 })
  expect(groveAges(trace.get("a"), 5).spawn).toBe(3)

  trace = updateGroveTrace(trace, [{ id: "a", state: "done" }], 6)
  expect(trace.get("a")).toEqual({ state: "done", seenAt: 2, finishedAt: 6 })
  expect(groveAges(trace.get("a"), 7)).toEqual({ spawn: 5, finish: 1 })

  // A settled entry is not re-stamped on every tick.
  const settled = updateGroveTrace(trace, [{ id: "a", state: "done" }], 9)
  expect(settled).toBe(trace)
})

test("a re-run starts a new spawn and forgets the old finish", () => {
  let trace = updateGroveTrace(new Map(), [{ id: "a", state: "running" }], 1)
  trace = updateGroveTrace(trace, [{ id: "a", state: "done" }], 3)
  trace = updateGroveTrace(trace, [{ id: "a", state: "running" }], 8)
  expect(trace.get("a")).toEqual({ state: "running", seenAt: 8 })
})

test("animations off records states without any motion timestamps", () => {
  const trace = updateGroveTrace(new Map(), [{ id: "a", state: "running" }], undefined)
  expect(trace.get("a")).toEqual({ state: "running" })
  const done = updateGroveTrace(trace, [{ id: "a", state: "done" }], undefined)
  expect(done.get("a")).toEqual({ state: "done" })
})

test("agents that leave the tree drop out of the trace", () => {
  let trace = updateGroveTrace(new Map(), [
    { id: "a", state: "running" },
    { id: "b", state: "running" },
  ], 1)
  trace = updateGroveTrace(trace, [{ id: "b", state: "running" }], 2)
  expect([...trace.keys()]).toEqual(["b"])
})
