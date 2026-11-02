/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { HomeStrip } from "../src/components/home/home-strip"
import { codegraphLive, context, mount } from "./harness"

const frame = async (codegraph: ReturnType<typeof codegraphLive>, size = { width: 100, height: 20 }) => {
  const app = await mount(() => <HomeStrip context={context()} codegraph={codegraph} />, size)
  try {
    return app.captureCharFrame()
  } finally {
    app.renderer.destroy()
  }
}

const compact = (text: string) => text.replace(/\s+/g, " ")

test("shows scanning instead of a 0/0 count before the file total is known", async () => {
  const running = await frame(codegraphLive({ build: { status: "running", done: 0, total: 0 } as never }))
  expect(running).toContain("Scanning files")
  expect(running).not.toContain("0/0")

  const counted = await frame(codegraphLive({ build: { status: "running", done: 3, total: 9 } as never }))
  expect(counted).toContain("3/9")
})

test("no tip text is left on the home strip", async () => {
  const text = compact(
    await frame(codegraphLive({ readiness: { reason: "missing", autoBuilt: false } as never })),
  )
  for (const tip of ["/swarm", "/yolo", "/agent-model", "/codegraph-build"]) expect(text).not.toContain(tip)
})

test("an idle strip renders nothing, even when it is narrow or short", async () => {
  expect((await frame(codegraphLive())).trim()).toBe("")
  expect((await frame(codegraphLive(), { width: 50, height: 20 })).trim()).toBe("")
  expect((await frame(codegraphLive(), { width: 100, height: 12 })).trim()).toBe("")
})
