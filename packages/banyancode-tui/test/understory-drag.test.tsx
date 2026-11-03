/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { CellGrid, type CellGridRenderable } from "../src/components/understory/cells"
import { palette } from "../src/theme"
import { mount, theme as harnessTheme } from "./harness"

interface Pointer {
  readonly kind: string
  readonly region: string | undefined
  readonly x: number
  readonly y: number
}

test("a drag reports cell coordinates and the region under the pointer", async () => {
  const events: Pointer[] = []
  const app = await mount(
    () => (
      <CellGrid
        id="drag-grid"
        width={20}
        height={4}
        background={palette(harnessTheme).background}
        draw={(grid) => {
          grid.text(0, 1, "0123456789", palette(harnessTheme).text)
          grid.hit(0, 1, 10, 1, "row:one")
        }}
        onDragStart={(pointer) => events.push({ kind: "start", ...pointer })}
        onDragMove={(pointer) => events.push({ kind: "move", ...pointer })}
        onDragEnd={(pointer) => events.push({ kind: "end", ...pointer })}
      />
    ),
    { width: 20, height: 4 },
  )
  try {
    await app.renderOnce()
    const grid = app.renderer.root.findDescendantById("drag-grid") as unknown as CellGridRenderable
    expect(grid).toBeDefined()
    await app.mockMouse.drag(1, 1, 6, 1)
    await app.renderOnce()
    expect(events[0]).toEqual({ kind: "start", region: "row:one", x: 1, y: 1 })
    expect(events.some((event) => event.kind === "move" && event.x === 4 && event.region === "row:one")).toBe(true)
    expect(events.at(-1)).toEqual({ kind: "end", region: "row:one", x: 6, y: 1 })
  } finally {
    app.renderer.destroy()
  }
})
