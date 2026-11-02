import { expect, test } from "bun:test"
import { RGBA } from "@opentui/core"
import { migrateV1, parseThemeDocument, resolveThemeDocument } from "../src/tui/index.js"
import type { ThemeV1Json } from "../src/tui/v1.js"

const source: ThemeV1Json = await Bun.file(
  new URL("../../tui/src/theme/assets/opencode.json", import.meta.url),
).json()
const opencode = migrateV1(source)

function relativeLuminance(color: RGBA) {
  const channel = (value: number) => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b)
}

function contrast(color: RGBA, background: RGBA) {
  const first = relativeLuminance(color)
  const second = relativeLuminance(background)
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05)
}

test.each(["light", "dark"] as const)("derives optional growth roles for %s v1 themes", (mode) => {
  const theme = resolveThemeDocument(opencode, mode)
  const background = theme.background.base

  for (const role of ["leaf", "highlight", "done", "faded", "wood", "bright"] as const) {
    expect(theme.growth[role]).toBeInstanceOf(RGBA)
  }
  expect(theme.growth.wood).toBe(theme.text.muted)
  expect(theme.growth.bright).toBe(theme.text.base)
  expect(contrast(theme.growth.highlight, background)).toBeGreaterThan(contrast(theme.growth.faded, background))
  expect(contrast(theme.growth.leaf, background)).toBeGreaterThanOrEqual(2.5)
  expect(contrast(theme.growth.faded, background)).toBeGreaterThanOrEqual(1.8)
})

const gray = {
  100: "#000000",
  200: "#222222",
  300: "#444444",
  400: "#666666",
  500: "#888888",
  600: "#aaaaaa",
  700: "#cccccc",
  800: "#eeeeee",
  900: "#ffffff",
}

// A complete theme without `green`: v1 migration only creates chromatic hues a theme actually used.
const minimal = parseThemeDocument(
  {
    base: {
      categorical: ["neutral"],
      text: {
        base: "$hue.neutral.200",
        muted: "$hue.neutral.400",
        action: {
          primary: { base: "$text.base" },
          secondary: { base: "$text.muted" },
          destructive: { base: "$hue.neutral.100" },
        },
        formfield: { base: "$text.base" },
        feedback: {
          error: { base: "$hue.neutral.200" },
          warning: { base: "$hue.neutral.200" },
          success: { base: "$hue.neutral.200" },
          info: { base: "$hue.neutral.200" },
        },
      },
      background: {
        base: "$hue.neutral.800",
        raised: { base: "$hue.neutral.700", high: "$hue.neutral.600", max: "$hue.neutral.500" },
        action: {
          primary: { base: "transparent" },
          secondary: { base: "transparent" },
          destructive: { base: "$hue.neutral.200" },
        },
        formfield: { base: "$background.base" },
        feedback: {
          error: { base: "$background.base" },
          warning: { base: "$background.base" },
          success: { base: "$background.base" },
          info: { base: "$background.base" },
        },
      },
      border: { base: "$hue.neutral.600" },
      scrollbar: { base: "$hue.neutral.500" },
      diff: {
        text: { added: "$hue.neutral.300", removed: "$hue.neutral.300", context: "$hue.neutral.400", hunkHeader: "$hue.neutral.400" },
        background: { added: "$hue.neutral.700", removed: "$hue.neutral.700", context: "$hue.neutral.700" },
        highlight: { added: "$hue.neutral.200", removed: "$hue.neutral.200" },
        lineNumber: { text: "$hue.neutral.500", background: { added: "$hue.neutral.700", removed: "$hue.neutral.700" } },
      },
      syntax: {
        comment: "$hue.neutral.400",
        keyword: "$hue.neutral.200",
        function: "$hue.neutral.200",
        variable: "$hue.neutral.200",
        string: "$hue.neutral.200",
        number: "$hue.neutral.200",
        type: "$hue.neutral.200",
        operator: "$hue.neutral.200",
        punctuation: "$hue.neutral.200",
      },
      markdown: {
        text: "$hue.neutral.200",
        heading: "$hue.neutral.200",
        link: "$hue.neutral.200",
        linkText: "$hue.neutral.200",
        code: "$hue.neutral.200",
        blockQuote: "$hue.neutral.200",
        emphasis: "$hue.neutral.200",
        strong: "$hue.neutral.200",
        horizontalRule: "$hue.neutral.200",
        listItem: "$hue.neutral.200",
        listEnumeration: "$hue.neutral.200",
        image: "$hue.neutral.200",
        imageText: "$hue.neutral.200",
        codeBlock: "$hue.neutral.200",
      },
    },
    light: { hue: { gray, accent: "$hue.gray", interactive: "$hue.gray", neutral: "$hue.gray" } },
  },
  "minimal",
)

test("derives growth roles from the accent hue when a theme has no green", () => {
  const theme = resolveThemeDocument(minimal, "light")
  const background = theme.background.base

  expect(theme.hue.accent[300]).toBeDefined()
  for (const role of ["leaf", "highlight", "done", "faded", "wood", "bright"] as const) {
    expect(theme.growth[role]).toBeInstanceOf(RGBA)
    expect(contrast(theme.growth[role], background)).toBeGreaterThanOrEqual(1.8)
  }
  expect(contrast(theme.growth.leaf, background)).toBeGreaterThanOrEqual(2.5)
})

test("honours explicit growth roles and resolves them on dialog surfaces", () => {
  const themed = parseThemeDocument(
    {
      ...opencode,
      base: {
        ...opencode.base,
        growth: { leaf: "#102030", done: "#a1b2c3" },
        "@dialog": { growth: { leaf: "#405060" } },
      },
    },
    "growth",
  )
  const theme = resolveThemeDocument(themed, "light")

  expect(theme.growth.leaf.toInts()).toEqual([16, 32, 48, 255])
  expect(theme.growth.done.toInts()).toEqual([161, 178, 195, 255])
  expect(theme.growth.highlight).toBeInstanceOf(RGBA)
  expect(theme.surface("dialog").growth.leaf.toInts()).toEqual([64, 80, 96, 255])
  expect(theme.surface("dialog").growth.done.toInts()).toEqual([161, 178, 195, 255])
})
