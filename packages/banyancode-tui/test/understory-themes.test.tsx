/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { RGBA } from "@opentui/core"
import type { SessionMessageInfo } from "@opencode/client"
import { migrateV1, parseThemeDocument, resolveThemeDocument, type ResolvedTheme } from "@opencode/theme/tui"
import { Inspector, type InspectorProps } from "../src/components/understory/inspector"
import { rowGeometry } from "../src/components/understory/layout"
import { RootsLens } from "../src/components/understory/roots"
import { StreamLens } from "../src/components/understory/stream"
import { TraceLens } from "../src/components/understory/trace"
import { createUnderstoryView, type LensProps } from "../src/components/understory/view"
import { branchHue } from "../src/components/understory/hue"
import { kindColor, palette, type Palette } from "../src/theme"
import type { RosterRow } from "../src/data/understory"
import { agentSpans, type AgentSpan } from "../src/data/understory-spans"
import { mount } from "./harness"

/**
 * The Agents tab under real theme documents, not the flat harness colour.
 * Banyan ships dark and light; opencode's own theme and a v1 theme (github,
 * migrated) prove the roles survive a definition this package does not own.
 * Every role the lens prints as text is measured against the page it sits on,
 * so a theme that cannot be read fails here instead of in the app.
 */

const ASSETS = new URL("../../tui/src/theme/assets/", import.meta.url)

const v2 = async (name: string, mode: "dark" | "light"): Promise<ResolvedTheme> =>
  resolveThemeDocument(parseThemeDocument(await Bun.file(new URL(`v2/${name}.json`, ASSETS)).json(), name), mode)

const v1 = async (name: string, mode: "dark" | "light"): Promise<ResolvedTheme> =>
  resolveThemeDocument(migrateV1((await Bun.file(new URL(`${name}.json`, ASSETS)).json()) as never), mode)

const THEMES: ReadonlyArray<{ readonly name: string; readonly mode: "dark" | "light"; readonly load: () => Promise<ResolvedTheme> }> = [
  { name: "banyan dark", mode: "dark", load: () => v2("banyan", "dark") },
  { name: "banyan light", mode: "light", load: () => v2("banyan", "light") },
  { name: "opencode dark", mode: "dark", load: () => v2("opencode", "dark") },
  // A v1 document, migrated: what a user's own theme actually becomes.
  { name: "github light", mode: "light", load: () => v1("github", "light") },
]

function luminance(color: RGBA): number {
  const channel = (value: number) => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b)
}

/** WCAG 2.1 contrast ratio between two colours. */
export function contrast(first: RGBA, second: RGBA): number {
  const a = luminance(first)
  const b = luminance(second)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

/** AA for normal text: every role below is printed as text, glyphs included. */
const AA = 4.5

const NOW = 46_000
const AT = (seconds: number) => NOW - (46 - seconds) * 1_000

const rows = (): RosterRow[] => [
  {
    sessionID: "ses_root",
    depth: 0,
    agent: "build",
    label: "build",
    title: "orchestrate the installer fix",
    state: "blocked",
    pending: 0,
    tokens: 185_000,
    cost: 0.03,
    startedAt: AT(0),
    historyMayBeTruncated: false,
    hasChildren: true,
  },
  {
    sessionID: "ses_c1",
    depth: 1,
    parentID: "ses_root",
    agent: "coder",
    label: "coder-1",
    title: "Add version check and working fallback",
    state: "running",
    pending: 0,
    tokens: 32_200,
    cost: 0.01,
    startedAt: AT(20),
    historyMayBeTruncated: false,
    hasChildren: false,
  },
]

const toolPart = (name: string, created: number, completed: number): SessionMessageInfo =>
  ({
    type: "tool",
    id: `tool_${name}`,
    name,
    state: { status: "completed", input: { filePath: "postinstall.mjs" }, content: [], metadata: {} },
    time: { created, completed },
  }) as unknown as SessionMessageInfo

const messages = (): readonly SessionMessageInfo[] => [
  { id: "u1", type: "user", time: { created: AT(19) }, text: "start" } as unknown as SessionMessageInfo,
  {
    id: "a1",
    type: "assistant",
    time: { created: AT(20), completed: AT(26) },
    agent: "coder",
    model: { providerID: "provider", id: "deepseek-v4.1-flash" },
    content: [toolPart("read", AT(21), AT(22)), toolPart("edit", AT(23), AT(25))],
  } as unknown as SessionMessageInfo,
]

const spans = (): Map<string, readonly AgentSpan[]> => {
  const map = new Map<string, readonly AgentSpan[]>()
  for (const row of rows()) map.set(row.sessionID, agentSpans(messages(), { state: row.state, start: row.startedAt }))
  return map
}

function lensProps(theme: Palette): LensProps {
  const list = rows()
  const height = 37
  return {
    rows: list,
    visible: list,
    offset: 0,
    ask: () => "shell: npm pack --dry-run",
    spans: spans(),
    messages,
    hues: new Map(list.map((row, index) => [row.sessionID, branchHue(index, "dark")])),
    theme,
    view: createUnderstoryView({ now: () => NOW }),
    selected: "ses_c1",
    width: 90,
    height,
    geometry: rowGeometry(height + 2, list.length),
    animations: false,
    tick: 0,
    on: { selectAgent: () => {}, pinCall: () => {}, selectFile: () => {} },
  }
}

function inspectorProps(theme: Palette): InspectorProps {
  const rows_ = rows()
  return {
    width: 44,
    height: 37,
    row: rows_[1]!,
    hue: branchHue(1, "dark"),
    glyph: "⣿",
    glyphColor: theme.leaf,
    ask: {
      kind: "permission",
      title: "shell",
      target: "npm pack --dry-run",
    },
    sheet: {
      sessionID: "ses_c1",
      label: "coder-1",
      agent: "coder",
      state: "running",
      pending: 0,
      output: ["the npm fallback resolves the wrong tarball"],
      tools: [
        { name: "read", letter: "R", target: "postinstall.mjs", status: "completed", at: AT(21), durationMs: 1_400, error: false },
        { name: "edit", letter: "E", target: "postinstall.mjs", status: "completed", at: AT(23), durationMs: 2_900, error: false },
      ],
      files: [{ path: "postinstall.mjs", added: 6, removed: 1 }],
      tokens: 32_200,
      historyMayBeTruncated: false,
    },
    run: undefined,
    hues: new Map(rows_.map((row, index) => [row.sessionID, branchHue(index, "dark")])),
    theme,
    animations: false,
    tick: 0,
    now: () => NOW,
    actions: ["s steer", "x kill", "↵ open session"],
    file: undefined,
    graph: undefined,
    pinned: undefined,
    spans: spans(),
    stale: [],
    touches: () => [],
    rate: () => 0,
  }
}

/** The role table the Agents tab prints, and the floor each one has to clear. */
function roles(p: Palette, mode: "dark" | "light"): ReadonlyArray<{ readonly role: string; readonly color: RGBA }> {
  return [
    { role: "text", color: p.text },
    { role: "muted", color: p.muted },
    { role: "R read", color: kindColor("R", p) },
    { role: "S search", color: kindColor("S", p) },
    { role: "E edit", color: kindColor("E", p) },
    { role: "$ shell", color: kindColor("$", p) },
    { role: "V verify", color: kindColor("V", p) },
    { role: "W web", color: kindColor("W", p) },
    // Branch identity hues, from the ramp the theme's own mode picks.
    ...Array.from({ length: 5 }, (_, index) => ({ role: `hue ${index}`, color: branchHue(index, mode) })),
    { role: "amber", color: p.warning },
    { role: "coral", color: p.error },
  ]
}

for (const item of THEMES) {
  test(`${item.name}: every role the lens prints clears AA on the page`, async () => {
    const theme = await item.load()
    const p = palette(theme)
    const failures = roles(p, item.mode)
      .map(({ role, color }) => ({ role, ratio: contrast(color, p.background) }))
      .filter(({ ratio }) => ratio < AA)
      .map(({ role, ratio }) => `${role} ${ratio.toFixed(2)} < ${AA}`)
    expect(failures).toEqual([])
    // The selected row and the inspector sit on the raised surface, so text
    // and the muted roles must clear it too.
    const onSurface = [p.text, p.muted, p.warning, p.error].map((color) => contrast(color, p.surface))
    expect(onSurface.every((ratio) => ratio >= AA)).toBe(true)
  })
}

for (const item of THEMES) {
  test(`${item.name}: Trace, Roots, Stream and the inspector render in the theme's own colours`, async () => {
    const theme = await item.load()
    const p = palette(theme)

    const lenses: ReadonlyArray<{ readonly name: string; readonly width: number; readonly render: () => unknown; readonly says: string }> = [
      { name: "trace", width: 90, render: () => <TraceLens {...lensProps(p)} />, says: "R read  S search" },
      {
        name: "roots",
        width: 90,
        render: () => <RootsLens {...lensProps(p)} mapRoot={undefined} onMapRoot={() => {}} root={undefined} />,
        says: "postinstall",
      },
      {
        name: "stream",
        width: 90,
        render: () => <StreamLens {...lensProps(p)} following={true} top={0} onScroll={() => {}} />,
        says: "postinstall",
      },
      { name: "inspector", width: 44, render: () => <Inspector {...inspectorProps(p)} />, says: "NEEDS YOU" },
    ]

    for (const lens of lenses) {
      const app = await mount(lens.render as () => never, { width: lens.width, height: 37 })
      try {
        await app.renderOnce()
        expect(app.captureCharFrame()).toContain(lens.says)
      } finally {
        app.renderer.destroy()
      }
    }

    // The drawer really read the theme: a tool block's letter cell carries the
    // palette's own kind colour, not a hard-coded one.
    const app = await mount(() => <TraceLens {...lensProps(p)} />, { width: 90, height: 37 })
    try {
      await app.renderOnce()
      const node = app.renderer.root.findDescendantById("banyancode.understory.trace") as unknown as {
        readonly grid: { cells(): ReadonlyArray<{ readonly fg: RGBA }> }
      }
      const painted = node.grid.cells().map((cell) => cell.fg)
      for (const letter of ["R", "E"] as const) {
        const wanted = kindColor(letter, p)
        expect(painted.some((color) => color.equals(wanted))).toBe(true)
      }
    } finally {
      app.renderer.destroy()
    }
  })
}
