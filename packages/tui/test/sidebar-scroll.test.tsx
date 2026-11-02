/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { RGBA } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { For } from "solid-js"
import { SidebarScroll } from "../src/routes/session/sidebar"
import { CustomSpeedScroll } from "../src/util/scroll"

const background = RGBA.fromInts(30, 30, 30)
const scrollbar = RGBA.fromInts(200, 200, 200)

// A row with a right-aligned value (the shape that touched the scrollbar) plus a
// long line that wraps to the full content width.
function Content(props: { readonly rows: number }) {
  return (
    <box flexDirection="column" gap={0}>
      <box flexDirection="row" justifyContent="space-between" width="100%">
        <text>Thinking</text>
        <text>29.0%</text>
      </box>
      <text>{"x".repeat(200)}</text>
      <For each={Array.from({ length: props.rows })}>{(_, index) => <text>row {index()}</text>}</For>
    </box>
  )
}

async function render(width: number, height: number, rows: number) {
  const app = await testRender(
    () => (
      <box width={width} height={height} flexDirection="column">
        <SidebarScroll
          acceleration={new CustomSpeedScroll(3)}
          background={background}
          scrollbar={scrollbar}
        >
          <Content rows={rows} />
        </SidebarScroll>
      </box>
    ),
    { width, height },
  )
  await app.renderOnce()
  return app
}

function scrollNode(app: Awaited<ReturnType<typeof testRender>>) {
  const node = app.renderer.root.findDescendantById("session-sidebar-scroll")
  if (!node) throw new Error("Missing session-sidebar-scroll")
  return node
}

test("sidebar content keeps a column between text and the scrollbar", async () => {
  for (const width of [30, 44]) {
    const app = await render(width, 8, 20)
    try {
      const node = scrollNode(app)
      const right = node.x + node.width - 1
      const lines = app.captureCharFrame().split("\n")
      const valueRow = lines.findIndex((line) => line.includes("29.0%"))
      expect(valueRow).toBeGreaterThanOrEqual(node.y)

      const value = lines[valueRow]!
      const end = value.indexOf("29.0%") + "29.0%".length - 1
      expect(end).toBeLessThanOrEqual(right - 2)
      expect(end).toBe(right - 2)

      // The gap column stays empty on every row, so wrapped text cannot touch the bar either.
      for (let row = node.y; row < node.y + node.height; row++) {
        expect(lines[row]![right - 1]).toBe(" ")
      }
      // The bar itself is showing, otherwise the gap assertion would be vacuous.
      expect(lines.slice(node.y, node.y + node.height).some((line) => line[right] === "█")).toBe(true)
    } finally {
      app.renderer.destroy()
    }
  }
})

test("sidebar content keeps the gap column with or without a scrollbar", async () => {
  for (const rows of [1, 20]) {
    const app = await render(40, 12, rows)
    try {
      const node = scrollNode(app)
      const right = node.x + node.width - 1
      const lines = app.captureCharFrame().split("\n")
      const valueRow = lines.findIndex((line) => line.includes("29.0%"))
      expect(valueRow).toBeGreaterThanOrEqual(node.y)
      expect(lines[valueRow]![right - 1]).toBe(" ")
      expect(lines[valueRow]!.indexOf("29.0%") + "29.0%".length - 1).toBe(right - 2)
    } finally {
      app.renderer.destroy()
    }
  }
})
