import { expect, test } from "bun:test"
import type { RGBA } from "@opentui/core"
import { parseThemeDocument, resolveThemeDocument, ToolKindRole } from "../src/tui/index.js"

const assets = new URL("../../tui/src/theme/assets/v2/", import.meta.url)
const banyan = parseThemeDocument(await Bun.file(new URL("banyan.json", assets)).json(), "banyan")
const opencode = parseThemeDocument(await Bun.file(new URL("opencode.json", assets)).json(), "opencode")
const opencode2 = parseThemeDocument(await Bun.file(new URL("opencode2.json", assets)).json(), "opencode2")

function relativeLuminance(color: RGBA) {
  const channel = (value: number) => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b)
}

function contrast(color: RGBA, background: RGBA) {
  const first = relativeLuminance(color)
  const second = relativeLuminance(background)
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05)
}

test.each([
  ["banyan", banyan],
  ["opencode", opencode],
  ["opencode2", opencode2],
] as const)("every tool kind stays readable in both %s modes", (_name, document) => {
  for (const mode of ["dark", "light"] as const) {
    const theme = resolveThemeDocument(document, mode)
    for (const role of ToolKindRole.literals) {
      expect(theme.tool[role]).toBeDefined()
      expect(contrast(theme.tool[role], theme.background.base)).toBeGreaterThanOrEqual(1.8)
    }
  }
})

test("the banyan theme names a distinct colour for every tool kind", () => {
  for (const mode of ["dark", "light"] as const) {
    const theme = resolveThemeDocument(banyan, mode)
    const colours = ToolKindRole.literals.map((role) => theme.tool[role].toInts().join(","))
    expect(new Set(colours).size).toBe(ToolKindRole.literals.length)
  }
  const dark = resolveThemeDocument(banyan, "dark")
  // The brief's violet for web tools, and sky for reads.
  expect(dark.tool.web.toInts()).toEqual([185, 162, 232, 255])
  expect(dark.tool.read.toInts()).toEqual(dark.text.feedback.info.base.toInts())
  expect(dark.tool.shell.toInts()).toEqual(dark.growth.wood.toInts())
  expect(dark.tool.verify.toInts()).toEqual(dark.growth.highlight.toInts())
  expect(dark.tool.edit.toInts()).toEqual(dark.growth.leaf.toInts())
})
