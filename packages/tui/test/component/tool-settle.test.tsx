/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { RGBA } from "@opentui/core"
import { ManualClock } from "@opentui/core/testing"
import { testRender } from "@opentui/solid"
import { createSignal } from "solid-js"
import { SETTLE_DURATION, ToolSettle, settleColor, settleLevel, type ToolSettleRenderable } from "../../src/component/tool-settle"

const FLASH = RGBA.fromHex("#25502f")
const BASE = RGBA.fromHex("#0a0e0b")

async function mount(props: () => { active: boolean }) {
  const clock = new ManualClock()
  const app = await testRender(
    () => (
      <ToolSettle id="settle" flash={FLASH} base={BASE} backgroundColor={BASE} active={props().active}>
        <text>Settle</text>
      </ToolSettle>
    ),
    { width: 20, height: 1, clock },
  )
  await app.renderOnce()
  const node = app.renderer.root.findDescendantById("settle")
  if (!(node instanceof Object) || !("level" in node)) throw new Error("Missing settle row")
  return Object.assign(app, {
    clock,
    node: node as unknown as ToolSettleRenderable,
    async step(ms: number) {
      clock.advance(ms)
      await app.renderOnce()
    },
  })
}

test("a live row flashes and settles to its resting background", async () => {
  await using app = await mount(() => ({ active: true }))
  expect(app.node.level).toBe(1)
  expect(app.node.backgroundColor.equals(settleColor(BASE, FLASH, 1))).toBe(true)

  await app.step(SETTLE_DURATION / 2)
  expect(app.node.level).toBeCloseTo(settleLevel(SETTLE_DURATION / 2), 5)
  expect(app.node.backgroundColor.equals(settleColor(BASE, FLASH, settleLevel(SETTLE_DURATION / 2)))).toBe(true)

  await app.step(SETTLE_DURATION / 2)
  expect(app.node.level).toBe(0)
  expect(app.node.backgroundColor.equals(BASE)).toBe(true)
  // Nothing is left ticking once the row has settled.
  expect(app.clock.pendingTimerCount).toBe(0)
})

test("history rows never flash and hold no timer", async () => {
  const [active, setActive] = createSignal(false)
  await using app = await mount(() => ({ active: active() }))
  expect(app.node.level).toBe(0)
  expect(app.node.backgroundColor.equals(BASE)).toBe(true)
  expect(app.clock.pendingTimerCount).toBe(0)

  await app.step(SETTLE_DURATION)
  expect(app.node.level).toBe(0)
  expect(app.clock.pendingTimerCount).toBe(0)

  // A row that becomes live starts its flash from full strength.
  setActive(true)
  await app.step(0)
  expect(app.node.level).toBe(1)
})
