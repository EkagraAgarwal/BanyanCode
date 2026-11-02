/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import type { Context } from "@opencode/plugin/tui/context"
import type { SessionInfo } from "@opencode/client"
import { RGBA } from "@opentui/core"
import { createSignal } from "solid-js"
import { Resume, fitTitle, relativeAge, RESUME_ROWS } from "../src/components/home/resume"
import type { Growth } from "../src/components/home/growth"
import { context, mount, session } from "./harness"

const BG = RGBA.fromInts(0, 0, 0)
const INK = RGBA.fromInts(200, 200, 200)
/** Marks the row after the block so a frame shows the space the block reserves. */
const TAIL = "TAIL"

const growthAt = (elapsed: () => number): Growth => ({
  elapsed,
  done: () => elapsed() >= 6.1,
  start: () => {},
  finish: () => {},
})

// The harness theme is one flat colour; the fade needs knowable endpoints.
const styled = (sessions: readonly SessionInfo[]) => {
  const base = context({ sessions })
  const raw = base.theme as unknown as Record<string, Record<string, unknown>>
  return {
    ...base,
    theme: {
      ...raw,
      background: { ...raw.background, base: BG },
      text: { ...raw.text, muted: INK, faint: INK },
      growth: { leaf: INK, highlight: INK, done: INK, faded: INK, wood: INK, bright: INK },
    },
  } as unknown as Context
}

const sessions = () => [
  session({ id: "ses_oldest", title: "Oldest", time: { created: 1_000, updated: 3_000 } }),
  session({ id: "ses_newest", title: "Newest", time: { created: 1_000, updated: 9_000 } }),
  session({ id: "ses_middle", title: "Middle", time: { created: 1_000, updated: 6_000 } }),
  session({ id: "ses_child", parentID: "ses_newest", title: "Child", time: { created: 1_000, updated: 9_500 } }),
  session({
    id: "ses_elsewhere",
    title: "Elsewhere",
    time: { created: 1_000, updated: 9_900 },
    location: { directory: "D:/other" },
  }),
  session({ id: "ses_fourth", title: "Fourth", time: { created: 1_000, updated: 1_500 } }),
]

const collect = (base: Context, overrides: { navigate?: (destination: unknown) => void; layer?: () => void }) =>
  ({
    ...base,
    keymap: { ...base.keymap, layer: overrides.layer ?? base.keymap.layer },
    ui: {
      ...base.ui,
      router: { ...base.ui.router, navigate: overrides.navigate ?? base.ui.router.navigate },
    },
  }) as unknown as Context

const render = async (ctx: Context, size = { width: 80, height: 30 }) => {
  const app = await mount(
    () => (
      <box flexDirection="column">
        <Resume context={ctx} growth={growthAt(() => 6.1)} />
        <text>{TAIL}</text>
      </box>
    ),
    size,
  )
  await Bun.sleep(10)
  await app.renderOnce()
  return app
}

const rowOf = (frame: string, needle: string) =>
  frame
    .replace(/\n$/, "")
    .split("\n")
    .findIndex((line) => line.includes(needle))

test("relative ages stay compact", () => {
  const now = 10 * 24 * 60 * 60 * 1000
  expect(relativeAge(now - 48 * 60 * 1000, now)).toBe("48m")
  expect(relativeAge(now - 60 * 60 * 1000, now)).toBe("1h")
  expect(relativeAge(now - 3 * 24 * 60 * 60 * 1000, now)).toBe("3d")
  expect(relativeAge(now - 21 * 24 * 60 * 60 * 1000, now)).toBe("3w")
})

test("titles truncate with an ellipsis instead of wrapping", () => {
  expect(fitTitle("short", 10)).toBe("short")
  expect(fitTitle("a very long session title", 10)).toBe("a very lo…")
})

test("lists the three most recently updated root sessions for this directory", async () => {
  const app = await render(styled(sessions()))
  try {
    const text = app.captureCharFrame().replace(/\s+/g, " ")
    expect(text).toContain("RESUME")
    expect(text).toContain("1 Newest")
    expect(text).toContain("2 Middle")
    expect(text).toContain("3 Oldest")
    expect(text).not.toContain("Child")
    expect(text).not.toContain("Elsewhere")
    expect(text).not.toContain("Fourth")
  } finally {
    app.renderer.destroy()
  }
})

test("the ordinals are not hotkeys", async () => {
  const claimed: string[] = []
  const app = await render(
    collect(styled(sessions()), {
      layer: () => {
        claimed.push("layer")
      },
    }),
  )
  try {
    expect(claimed).toEqual([])
  } finally {
    app.renderer.destroy()
  }
})

test("clicking a row opens that session", async () => {
  const opened: unknown[] = []
  const app = await render(collect(styled(sessions()), { navigate: (destination) => opened.push(destination) }))
  try {
    // Row 0 is the header; the three sessions follow.
    await app.mockMouse.click(40, 1)
    expect(opened).toEqual([{ type: "session", sessionID: "ses_newest" }])

    await app.mockMouse.click(40, 2)
    expect(opened[1]).toEqual({ type: "session", sessionID: "ses_middle" })
  } finally {
    app.renderer.destroy()
  }
})

test("zero sessions reserve the rows but render no header", async () => {
  const app = await render(styled([]))
  try {
    const frame = app.captureCharFrame()
    expect(frame).not.toContain("RESUME")
    expect(frame.trim().split("\n")).toEqual([TAIL])
    // The marker sits after the reserved block, so the block still occupies its rows.
    expect(rowOf(frame, TAIL)).toBe(RESUME_ROWS)
  } finally {
    app.renderer.destroy()
  }
})

test("the rows are reserved once the list resolves", async () => {
  const app = await render(styled(sessions()))
  try {
    expect(rowOf(app.captureCharFrame(), TAIL)).toBe(RESUME_ROWS)
  } finally {
    app.renderer.destroy()
  }
})

test("the size guard drops the block instead of overflowing", async () => {
  const ctx = styled(sessions())

  const narrow = await render(ctx, { width: 59, height: 40 })
  try {
    expect(narrow.captureCharFrame().trim()).toBe(TAIL)
  } finally {
    narrow.renderer.destroy()
  }

  // 10 rows cannot hold the prompt and footer around the block.
  const flat = await render(ctx, { width: 80, height: 10 })
  try {
    expect(flat.captureCharFrame().trim()).toBe(TAIL)
  } finally {
    flat.renderer.destroy()
  }

  // 12 rows can: one plain hero row, the prompt, the block and the footer.
  const tight = await render(ctx, { width: 80, height: 12 })
  try {
    expect(tight.captureCharFrame()).toContain("RESUME")
  } finally {
    tight.renderer.destroy()
  }
})

test("the rows hold their space from the first frame and fade in", async () => {
  const [elapsed, setElapsed] = createSignal(0)
  const ctx = styled(sessions())
  const app = await mount(
    () => (
      <box flexDirection="column">
        <Resume context={ctx} growth={growthAt(elapsed)} />
        <text>{TAIL}</text>
      </box>
    ),
    { width: 80, height: 30 },
  )
  try {
    await Bun.sleep(10)
    await app.renderOnce()
    const textAtStart = app.captureCharFrame()
    expect(textAtStart).toContain("RESUME")
    const faded = app.captureSpans().lines.flatMap((line) => line.spans).find((span) => span.text.includes("RESUME"))
    expect(faded?.fg.equals(BG)).toBe(true)

    setElapsed(6.1)
    await app.renderOnce()
    const textAtEnd = app.captureCharFrame()
    expect(textAtEnd).toContain("RESUME")
    expect(textAtEnd.replace(/\s+/g, " ")).toBe(textAtStart.replace(/\s+/g, " "))
    const lit = app.captureSpans().lines.flatMap((line) => line.spans).find((span) => span.text.includes("RESUME"))
    expect(lit?.fg.equals(INK)).toBe(true)
  } finally {
    app.renderer.destroy()
  }
})
