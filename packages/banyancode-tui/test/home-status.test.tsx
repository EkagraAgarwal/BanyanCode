/** @jsxImportSource @opentui/solid */
import type { Context } from "@opencode/plugin/tui/context"
import { expect, test } from "bun:test"
import { HomeStatus } from "../src/components/home/home-status"
import { context, mount } from "./harness"

const render = async (ctx: Context, size = { width: 100, height: 2 }) => {
  const app = await mount(() => <HomeStatus context={ctx} />, size)
  await app.renderOnce()
  return app
}

const withoutBranch = (base: Context) =>
  ({
    ...base,
    data: {
      ...base.data,
      location: { ...base.data.location, vcs: { ...base.data.location.vcs, info: () => undefined } },
    },
  }) as unknown as Context

test("shows the working directory and its branch", async () => {
  const app = await render(context({ directory: "D:/bc-tui-redesign" }))
  try {
    const text = app.captureCharFrame().replace(/\s+/g, " ")
    expect(text).toContain("D:/bc-tui-redesign")
    expect(text).toContain("v2-base")
  } finally {
    app.renderer.destroy()
  }
})

test("formats the directory through the host and omits a missing branch", async () => {
  const base = context({ directory: "/home/someone/very/long/project/path" })
  const shortened = {
    ...base,
    ui: { ...base.ui, format: { path: () => "~/project" } },
  } as unknown as Context

  const app = await render(withoutBranch(shortened))
  try {
    const text = app.captureCharFrame().replace(/\s+/g, " ")
    expect(text).toContain("~/project")
    expect(text).not.toContain("v2-base")
  } finally {
    app.renderer.destroy()
  }
})

test("keeps the branch visible when the directory has to truncate", async () => {
  const full = `${"deep/".repeat(20)}end`
  const app = await render(context({ directory: full }), { width: 30, height: 2 })
  try {
    const line = app.captureCharFrame().split("\n")[0] ?? ""
    expect(line).toContain("v2-base")
    expect(line).not.toContain(full)
    expect(line.trimEnd().length).toBeLessThanOrEqual(30)
  } finally {
    app.renderer.destroy()
  }
})

/** Mounts the status block beside a fixed-width neighbour, as the real footer row does. */
const renderBeside = async (ctx: Context, width: number, neighbour: number) => {
  const app = await mount(
    () => (
      <box flexDirection="row" width={width} height={1}>
        <HomeStatus context={ctx} />
        <box width={neighbour} flexShrink={0} />
      </box>
    ),
    { width, height: 1 },
  )
  await app.renderOnce()
  return app
}

test("never loses the directory's basename when the row is tight", async () => {
  const base = context({ directory: "/home/someone/very/long/project/path/project" })
  for (const [width, neighbour] of [
    [100, 78],
    [80, 58],
  ] as const) {
    const app = await renderBeside(base, width, neighbour)
    try {
      const line = app.captureCharFrame().split("\n")[0] ?? ""
      // The prefix gives way; the basename and the branch stay.
      expect(line).toContain("/project")
      expect(line).toContain("v2-base")
      expect(line.trimEnd().length).toBeLessThanOrEqual(width)
    } finally {
      app.renderer.destroy()
    }
  }
})
