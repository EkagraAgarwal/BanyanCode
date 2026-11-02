import { expect, test } from "bun:test"
import { RGBA, type TerminalColors } from "@opentui/core"
import { resolveThemeDocument } from "@opencode/theme/tui"
import { allThemes, parseTheme } from "../../../src/theme"
import { generateSystem } from "../../../src/theme/system"

const roles = ["leaf", "highlight", "done", "faded", "wood", "bright"] as const

function terminalColors(): TerminalColors {
  return {
    palette: ["#15161e", "#f7768e", "#9ece6a", "#e0af68", "#7aa2f7", "#bb9af7", "#7dcfff", "#c0caf5"],
    defaultBackground: "#1a1b26",
    defaultForeground: "#c0caf5",
    cursorColor: null,
    mouseForeground: null,
    mouseBackground: null,
    tekForeground: null,
    tekBackground: null,
    highlightBackground: null,
    highlightForeground: null,
  }
}

test.each(["light", "dark"] as const)("resolves growth for every built-in theme in %s mode", (mode) => {
  for (const [name, source] of Object.entries(allThemes())) {
    const theme = resolveThemeDocument(parseTheme(source, name), mode)
    for (const role of roles) {
      expect(theme.growth[role]).toBeInstanceOf(RGBA)
    }
  }
})

test.each(["light", "dark"] as const)("derives growth for the generated system theme in %s mode", (mode) => {
  const theme = resolveThemeDocument(parseTheme(generateSystem(terminalColors(), mode)), mode)

  for (const role of roles) {
    expect(theme.growth[role]).toBeInstanceOf(RGBA)
  }
  expect(theme.growth.wood).toBe(theme.text.muted)
  expect(theme.growth.bright).toBe(theme.text.base)
})
