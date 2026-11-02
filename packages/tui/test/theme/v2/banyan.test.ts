import { expect, test } from "bun:test"
import { RGBA } from "@opentui/core"
import { resolveThemeDocument } from "@opencode/theme/tui"
import { allThemes, getOpenCodeTheme, parseTheme } from "../../../src/theme"

const source = allThemes().banyan
if (!source) throw new Error("banyan theme is not registered")
const document = parseTheme(source, "banyan")
const dark = resolveThemeDocument(document, "dark")
const light = resolveThemeDocument(document, "light")

function relativeLuminance(color: RGBA) {
  const channel = (value: number) => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b)
}

function contrast(color: RGBA, background: RGBA) {
  const first = relativeLuminance(color)
  const second = relativeLuminance(background)
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05)
}

test("registers banyan as a built-in V2 theme", () => {
  expect(allThemes().banyan).toBeDefined()
  expect(document.base).toBeDefined()
  expect(document.dark).toBeDefined()
  expect(document.light).toBeDefined()
  expect(allThemes().banyan).not.toBe(getOpenCodeTheme())
})

test("maps the dark Banyan palette onto semantic roles", () => {
  const roles = {
    "background.base": dark.background.base,
    "background.raised.base": dark.background.raised.base,
    "background.raised.high": dark.background.raised.high,
    "background.raised.max": dark.background.raised.max,
    "border.base": dark.border.base,
    "scrollbar.base": dark.scrollbar.base,
    "text.base": dark.text.base,
    "text.muted": dark.text.muted,
    "text.faint": dark.text.faint,
    "growth.bright": dark.growth.bright,
    "growth.leaf": dark.growth.leaf,
    "growth.highlight": dark.growth.highlight,
    "growth.done": dark.growth.done,
    "growth.faded": dark.growth.faded,
    "growth.wood": dark.growth.wood,
    "text.feedback.warning.base": dark.text.feedback.warning.base,
    "text.feedback.error.base": dark.text.feedback.error.base,
    "text.feedback.info.base": dark.text.feedback.info.base,
    "diff.background.added": dark.diff.background.added,
    "diff.background.removed": dark.diff.background.removed,
  }
  const expected = {
    "background.base": "#0a0e0b",
    "background.raised.base": "#101611",
    "background.raised.high": "#172019",
    "background.raised.max": "#1e2c21",
    "border.base": "#2b382e",
    "scrollbar.base": "#42544a",
    "text.base": "#dce5d8",
    "text.muted": "#aebdad",
    "text.faint": "#7f8e80",
    "growth.bright": "#f6faf2",
    "growth.leaf": "#7fd68a",
    "growth.highlight": "#c8f27c",
    "growth.done": "#4b8a58",
    "growth.faded": "#25502f",
    "growth.wood": "#a98257",
    "text.feedback.warning.base": "#e8b15a",
    "text.feedback.error.base": "#ee8478",
    "text.feedback.info.base": "#8cc4e8",
    "diff.background.added": "#16301c",
    "diff.background.removed": "#3a1d1b",
  }
  for (const [role, hex] of Object.entries(expected)) {
    expect(roles[role as keyof typeof roles].toInts()).toEqual(RGBA.fromHex(hex).toInts())
  }
})

test("provides a light Banyan variant instead of forcing a dark screen", () => {
  expect(relativeLuminance(dark.background.base)).toBeLessThan(0.1)
  expect(relativeLuminance(light.background.base)).toBeGreaterThan(0.5)
  expect(light.growth.leaf.equals(dark.growth.leaf)).toBeFalse()
  expect(light.text.base.equals(dark.text.base)).toBeFalse()
  expect(light.surface("dialog").background.base.toInts()).toEqual(light.background.raised.base.toInts())
})

test.each(["light", "dark"] as const)("keeps %s text and growth readable on the base background", (mode) => {
  const theme = mode === "dark" ? dark : light
  const background = theme.background.base

  expect(contrast(theme.text.base, background)).toBeGreaterThanOrEqual(4.5)
  expect(contrast(theme.text.muted, background)).toBeGreaterThanOrEqual(3)
  for (const role of ["leaf", "highlight", "done", "wood", "bright"] as const) {
    expect(contrast(theme.growth[role], background)).toBeGreaterThanOrEqual(3)
  }
  // `faded` is the deep branch color, not body text; it must still separate from the background.
  expect(contrast(theme.growth.faded, background)).toBeGreaterThanOrEqual(2)
})
