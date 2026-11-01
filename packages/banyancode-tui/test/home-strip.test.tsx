/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { HOME_TIPS, HomeStrip } from "../src/components/home/home-strip"
import { codegraphLive, context, mount } from "./harness"

test("home strip shows the codegraph tip, progress and quick actions", async () => {
  const app = await mount(
    () => <HomeStrip context={context()} codegraph={codegraphLive({ readiness: { reason: "missing", autoBuilt: false } })} />,
    { width: 100, height: 20 },
  )
  try {
    const frame = app.captureCharFrame()
    expect(HOME_TIPS.some((tip) => frame.includes(tip))).toBe(true)
    expect(frame).toContain("Codegraph not built")
    expect(frame).toContain("/agent-model")
    expect(frame).toContain("/yolo")
    expect(frame).toContain("/swarm")
  } finally {
    app.renderer.destroy()
  }
})

test("home strip disappears instead of crowding a narrow home", async () => {
  const app = await mount(
    () => <HomeStrip context={context()} codegraph={codegraphLive()} />,
    { width: 50, height: 20 },
  )
  try {
    expect(app.captureCharFrame().trim()).toBe("")
  } finally {
    app.renderer.destroy()
  }
})

test("home strip hides at short heights", async () => {
  const app = await mount(
    () => <HomeStrip context={context()} codegraph={codegraphLive()} />,
    { width: 100, height: 12 },
  )
  try {
    expect(app.captureCharFrame().trim()).toBe("")
  } finally {
    app.renderer.destroy()
  }
})
