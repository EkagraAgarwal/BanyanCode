/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { ManualClock } from "@opentui/core/testing"
import { testRender } from "@opentui/solid"
import { createSignal } from "solid-js"
import {
  DIFF_CLOSE_DURATION,
  DIFF_OPEN_DURATION,
  DiffReveal,
  diffRowCount,
  revealHeight,
  type DiffRevealRenderable,
} from "../../src/component/diff-reveal"

async function mount(props: () => { open: boolean; active: boolean }) {
  const clock = new ManualClock()
  const app = await testRender(
    () => (
      <DiffReveal id="reveal" rows={6} active={props().active} open={props().open}>
        <text>line 1</text>
        <text>line 2</text>
        <text>line 3</text>
        <text>line 4</text>
        <text>line 5</text>
        <text>line 6</text>
      </DiffReveal>
    ),
    { width: 20, height: 8, clock },
  )
  await app.renderOnce()
  const node = app.renderer.root.findDescendantById("reveal")
  if (!(node instanceof Object) || !("revealed" in node)) throw new Error("Missing diff reveal")
  return Object.assign(app, {
    clock,
    node: node as unknown as DiffRevealRenderable,
    async step(ms: number) {
      clock.advance(ms)
      await app.renderOnce()
    },
  })
}

test("a live diff opens over 500 ms and collapses over 400 ms", async () => {
  const [open, setOpen] = createSignal(true)
  await using app = await mount(() => ({ open: open(), active: true }))
  // The first frame may already carry one animation tick, so the reveal starts near zero, not pinned at it.
  expect(app.node.revealed).toBeLessThanOrEqual(1)

  await app.step(250)
  expect(app.node.revealed).toBeGreaterThan(0)
  expect(app.node.revealed).toBeLessThan(6)

  await app.step(DIFF_OPEN_DURATION)
  expect(app.node.revealed).toBe(6)
  expect(app.node.animationFps).toBeUndefined()
  expect(app.clock.pendingTimerCount).toBe(0)

  setOpen(false)
  await app.step(0)
  expect(app.node.revealed).toBe(6)
  await app.step(200)
  expect(app.node.revealed).toBeGreaterThan(0)
  expect(app.node.revealed).toBeLessThan(6)
  await app.step(DIFF_CLOSE_DURATION)
  expect(app.node.revealed).toBe(0)
  expect(app.node.visible).toBe(false)
  expect(app.node.animationFps).toBeUndefined()
  expect(app.clock.pendingTimerCount).toBe(0)
})

test("a history diff renders at full height at once", async () => {
  await using app = await mount(() => ({ open: true, active: false }))
  expect(app.node.revealed).toBe(6)
  expect(app.clock.pendingTimerCount).toBe(0)
  await app.step(DIFF_OPEN_DURATION)
  expect(app.node.revealed).toBe(6)
  expect(app.clock.pendingTimerCount).toBe(0)
  expect(app.node.animationFps).toBeUndefined()
})

test("reveal height eases out to both endpoints", () => {
  expect(revealHeight(6, 0, "open")).toBe(0)
  expect(revealHeight(6, 1, "open")).toBe(6)
  expect(revealHeight(6, 0, "close")).toBe(6)
  expect(revealHeight(6, 1, "close")).toBe(0)
  expect(revealHeight(6, 0.5, "open")).toBeGreaterThan(3)
})

test("counts patch rows and hunk headers", () => {
  const single = ["@@ -1,2 +1,3 @@", " context", "-removed", "+added", "+more"].join("\n")
  expect(diffRowCount(single)).toBe(4)
  const doubled = [
    "--- a/file",
    "+++ b/file",
    "@@ -1,1 +1,1 @@",
    "-old",
    "+new",
    "@@ -9,1 +9,1 @@",
    "-again",
    "+again",
  ].join("\n")
  expect(diffRowCount(doubled)).toBe(5)
})
