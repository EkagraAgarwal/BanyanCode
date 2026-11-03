/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import type { SessionMessageInfo } from "@opencode/client"
import type { CodegraphEdge, CodegraphFile, CodegraphNode } from "../src/data/pending-rpc"
import { CellGridRenderable, type Grid } from "../src/components/understory/cells"
import { rowGeometry } from "../src/components/understory/layout"
import { RootsLens, type RootsLensProps } from "../src/components/understory/roots"
import { createUnderstoryView } from "../src/components/understory/view"
import { layoutMap, mapRect, repoMapFromGraph } from "../src/data/understory-map"
import type { AgentSpan } from "../src/data/understory-spans"
import type { RosterRow } from "../src/data/understory"
import { RGBA } from "@opentui/core"
import { palette } from "../src/theme"
import { codegraphLive, mount, theme } from "./harness"

/** The harness theme is one flat colour; Roots needs distinct roles to assert on. */
const TEST_THEME = {
  ...palette(theme),
  background: RGBA.fromInts(5, 7, 6),
  surface: RGBA.fromInts(23, 32, 25),
  surfaceHigh: RGBA.fromInts(30, 44, 33),
  text: RGBA.fromInts(220, 229, 216),
  muted: RGBA.fromInts(169, 184, 168),
  faint: RGBA.fromInts(127, 142, 128),
  wood: RGBA.fromInts(169, 130, 87),
  leaf: RGBA.fromInts(127, 214, 138),
  sky: RGBA.fromInts(140, 196, 232),
  lime: RGBA.fromInts(200, 242, 124),
  warning: RGBA.fromInts(232, 177, 90),
  error: RGBA.fromInts(238, 132, 120),
  border: RGBA.fromInts(43, 56, 46),
  done: RGBA.fromInts(75, 138, 88),
} as ReturnType<typeof palette>

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ROOT = "D:\\repo"
const NOW = 46_000

const files: CodegraphFile[] = [
  { id: "f1", path: "packages/core/src/engine.ts", contentHash: "h", language: "typescript", indexedAt: 1 },
  { id: "f2", path: "packages/core/src/postinstall.ts", contentHash: "h", language: "typescript", indexedAt: 1 },
  { id: "f3", path: "packages/core/src/resolve.ts", contentHash: "h", language: "typescript", indexedAt: 1 },
  { id: "f4", path: "packages/tui/src/frame.tsx", contentHash: "h", language: "typescript", indexedAt: 1 },
  { id: "f5", path: "packages/tui/src/footer.tsx", contentHash: "h", language: "typescript", indexedAt: 1 },
  { id: "f6", path: "packages/banyancode/src/intel/blast-radius.ts", contentHash: "h", language: "typescript", indexedAt: 1 },
  { id: "f7", path: "packages/banyancode/src/intel/preflight.ts", contentHash: "h", language: "typescript", indexedAt: 1 },
]

const node = (id: string, fileID: string, kind: string, name: string, endLine: number, signature?: string): CodegraphNode => ({
  id,
  fileID,
  kind,
  name,
  startLine: 1,
  endLine,
  ...(signature === undefined ? {} : { signature }),
})

const nodes: CodegraphNode[] = [
  node("f1:file", "f1", "file", "engine.ts", 2_114, "packages/core/src/engine.ts"),
  node("f1:fn", "f1", "function", "resolvePlatformPackage", 120),
  node("f2:file", "f2", "file", "postinstall.ts", 46, "packages/core/src/postinstall.ts"),
  node("f2:fn", "f2", "function", "main", 40),
  node("f3:file", "f3", "file", "resolve.ts", 92, "packages/core/src/resolve.ts"),
  node("f3:fn", "f3", "function", "resolveBinary", 60),
  node("f4:file", "f4", "file", "frame.tsx", 352, "packages/tui/src/frame.tsx"),
  node("f4:fn", "f4", "function", "Frame", 300),
  node("f5:file", "f5", "file", "footer.tsx", 175, "packages/tui/src/footer.tsx"),
  node("f5:fn", "f5", "function", "Footer", 150),
  node("f6:file", "f6", "file", "blast-radius.ts", 93, "packages/banyancode/src/intel/blast-radius.ts"),
  node("f6:fn", "f6", "function", "computeBlastRadius", 90),
  node("f7:file", "f7", "file", "preflight.ts", 210, "packages/banyancode/src/intel/preflight.ts"),
  node("f7:fn", "f7", "function", "computePreflight", 200),
]

const edges: CodegraphEdge[] = [
  { id: "e1", fromNodeID: "f2:fn", toNodeID: "f1:fn", kind: "imports" },
  { id: "e2", fromNodeID: "f3:fn", toNodeID: "f1:fn", kind: "imports" },
  { id: "e3", fromNodeID: "f7:fn", toNodeID: "f6:fn", kind: "imports" },
  { id: "e4", fromNodeID: "f5:fn", toNodeID: "f4:fn", kind: "imports" },
]

const graph = { nodes, edges }

const row = (input: Partial<RosterRow> & { readonly sessionID: string; readonly label: string }): RosterRow => ({
  depth: 1,
  agent: "coder",
  state: "running",
  pending: 0,
  tokens: 1_000,
  cost: 0,
  startedAt: 0,
  historyMayBeTruncated: false,
  hasChildren: false,
  ...input,
})

const rows: RosterRow[] = [
  row({ sessionID: "ses_root", label: "build", depth: 0, state: "blocked", startedAt: 0 }),
  row({ sessionID: "ses_c1", label: "coder-1", parentID: "ses_root", startedAt: 1_000, title: "Add version check" }),
  row({ sessionID: "ses_c2", label: "coder-2", parentID: "ses_root", startedAt: 2_000, title: "Route the updater" }),
]

const span = (input: Partial<AgentSpan> & { readonly t0: number; readonly letter: AgentSpan["letter"] }): AgentSpan => ({
  id: `span-${input.t0}-${input.letter}`,
  kind: "tool",
  name: "read",
  target: "",
  ...input,
})

const sawEngine = [
  span({ t0: 20_000, t1: 21_000, letter: "R", file: `${ROOT}\\packages\\core\\src\\engine.ts` }),
  span({ t0: 30_000, letter: "E", file: `${ROOT}\\packages\\core\\src\\postinstall.ts`, added: 6, removed: 1 }),
]

const THEME = TEST_THEME

function props(input: {
  readonly width?: number
  readonly height?: number
  readonly tick?: number
  readonly animations?: boolean
  readonly spans?: ReadonlyMap<string, readonly AgentSpan[]>
  readonly messages?: (sessionID: string) => readonly SessionMessageInfo[]
  readonly codegraph?: ReturnType<typeof codegraphLive> | undefined
  readonly root?: string
  readonly onFile?: (path: string | undefined) => void
} = {}): RootsLensProps & { readonly view: ReturnType<typeof createUnderstoryView> } {
  const width = input.width ?? 90
  const height = input.height ?? 37
  const view = createUnderstoryView({ now: () => NOW })
  const panel = height + 1 + 1
  return {
    rows,
    visible: rows,
    offset: 0,
    ask: () => undefined,
    spans: input.spans ?? new Map(),
    messages: input.messages ?? (() => []),
    hues: new Map(rows.map((entry, index) => [entry.sessionID, index === 0 ? THEME.text : THEME.leaf])),
    theme: THEME,
    view,
    selected: "ses_c1",
    width,
    height,
    geometry: rowGeometry(panel, rows.length),
    animations: input.animations ?? false,
    tick: input.tick ?? 0,
    on: {
      selectAgent: () => {},
      pinCall: () => {},
      selectFile: input.onFile ?? (() => {}),
    },
    ...(input.codegraph === undefined ? {} : { codegraph: input.codegraph }),
    ...(input.root === undefined ? {} : { root: input.root }),
  }
}

const gridOf = (app: Awaited<ReturnType<typeof mount>>): Grid => {
  const node = app.renderer.root.findDescendantById("banyancode.understory.roots")
  expect(node).toBeDefined()
  return (node as CellGridRenderable).grid
}

/** Every cell's glyph and both colours, so "nothing changed" is provable. */
const signature = (grid: Grid): string =>
  grid
    .cells()
    .map(
      (cell) =>
        `${cell.x},${cell.y},${cell.glyph},${Array.from(cell.fg.buffer).join("/")},${Array.from(cell.bg.buffer).join("/")},${cell.bold ? 1 : 0}`,
    )
    .join(";")

const lines = (grid: Grid): string[] => grid.lines()

const slack = (app: Awaited<ReturnType<typeof mount>>, width: number): number =>
  Math.max(...app.captureCharFrame().split("\n").map((line) => line.length)) - width

const graphFiles = () => codegraphLive({ graph, files })

/** The tile a path owns, laid out the same way the lens lays it out. */
function tileRect(width: number, height: number, path: string) {
  const map = repoMapFromGraph({ nodes, edges, files })
  const { rect } = mapRect(width, height)
  const layout = layoutMap(map, rect)
  const tile = layout.byFile.get(path)
  expect(tile).toBeDefined()
  return tile!.rect
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("the lens draws the repo map: a package header and file labels", async () => {
  const app = await mount(() => <RootsLens {...props({ codegraph: graphFiles() })} />, { width: 90, height: 37 })
  try {
    const frame = lines(gridOf(app)).join("\n")
    expect(frame).toContain("core")
    expect(frame).toContain("engine")
    expect(frame).toContain("read")
    expect(frame).toContain("click a tile")
    expect(slack(app, 90)).toBeLessThanOrEqual(0)
    expect(lines(gridOf(app))).toHaveLength(37)
  } finally {
    app.renderer.destroy()
  }
})

test("a tool path with Windows separators heats its own tile, and the heat follows the playhead", async () => {
  const rect = tileRect(90, 37, "packages/core/src/engine.ts")
  const cold = await mount(() => <RootsLens {...props({ codegraph: graphFiles(), root: ROOT })} />, {
    width: 90,
    height: 37,
  })
  const hot = await mount(
    () =>
      <RootsLens
        {...props({ codegraph: graphFiles(), root: ROOT, spans: new Map([["ses_c1", sawEngine]]) })}
      />,
    { width: 90, height: 37 },
  )
  try {
    const coldCell = gridOf(cold).cell(rect.x, rect.y)!
    const hotCell = gridOf(hot).cell(rect.x, rect.y)!
    expect(hotCell.bg.equals(coldCell.bg)).toBe(false)
    // An edit on postinstall tints leaf, a read on engine tints sky: the two
    // tiles differ, so the verb is not lost.
    const edited = tileRect(90, 37, "packages/core/src/postinstall.ts")
    expect(gridOf(hot).cell(edited.x, edited.y)!.bg.equals(hotCell.bg)).toBe(false)
  } finally {
    cold.renderer.destroy()
    hot.renderer.destroy()
  }
})

test("a root never overdraws a tile label", async () => {
  const app = await mount(
    () =>
      <RootsLens
        {...props({
          codegraph: graphFiles(),
          root: ROOT,
          spans: new Map([["ses_c1", sawEngine]]),
          animations: true,
          tick: 1,
        })}
      />,
    { width: 90, height: 37 },
  )
  try {
    const grid = gridOf(app)
    const map = repoMapFromGraph({ nodes, edges, files })
    const layout = layoutMap(map, mapRect(90, 37).rect)
    let checked = 0
    for (const tile of layout.tiles) {
      if (tile.files.length !== 1 || tile.rect.w < 3) continue
      const glyph = grid.cell(tile.rect.x, tile.rect.y)!.glyph
      const point = glyph.codePointAt(0) ?? 0
      // A braille dot is U+2800..U+28FF; a label cell must never become one.
      expect(point < 0x2800 || point > 0x28ff, `${tile.key} label at ${tile.rect.x},${tile.rect.y}`).toBe(true)
      checked += 1
    }
    expect(checked).toBeGreaterThan(0)
    // The roots themselves are there: the channel holds braille dots.
    const channel = lines(grid).map((line) => [...line.slice(0, mapRect(90, 37).channel)]).flat()
    expect(channel.some((glyph) => {
      const point = glyph.codePointAt(0) ?? 0
      return point >= 0x2800 && point <= 0x28ff
    })).toBe(true)
  } finally {
    app.renderer.destroy()
  }
})

test("an idle run renders nothing: the frame is identical across ticks", async () => {
  const calm = await mount(() => <RootsLens {...props({ codegraph: graphFiles(), tick: 0 })} />, {
    width: 90,
    height: 37,
  })
  const later = await mount(() => <RootsLens {...props({ codegraph: graphFiles(), tick: 9 })} />, {
    width: 90,
    height: 37,
  })
  try {
    expect(signature(gridOf(later))).toBe(signature(gridOf(calm)))
  } finally {
    calm.renderer.destroy()
    later.renderer.destroy()
  }
})

test("with animations off the roots and heat are already at their final state", async () => {
  const early = await mount(
    () =>
      <RootsLens
        {...props({ codegraph: graphFiles(), root: ROOT, spans: new Map([["ses_c1", sawEngine]]), tick: 0 })}
      />,
    { width: 90, height: 37 },
  )
  const late = await mount(
    () =>
      <RootsLens
        {...props({ codegraph: graphFiles(), root: ROOT, spans: new Map([["ses_c1", sawEngine]]), tick: 20 })}
      />,
    { width: 90, height: 37 },
  )
  try {
    expect(signature(gridOf(late))).toBe(signature(gridOf(early)))
    // No comet: the roots are drawn, but they do not move between ticks.
    const root = lines(gridOf(early)).join("\n")
    expect(root).toContain("engine")
  } finally {
    early.renderer.destroy()
    late.renderer.destroy()
  }
})

test("without a code graph the map is the touched files plus the build hint", async () => {
  const app = await mount(
    () =>
      <RootsLens
        {...props({ root: ROOT, spans: new Map([["ses_c1", sawEngine]]) })}
      />,
    { width: 90, height: 37 },
  )
  try {
    const frame = lines(gridOf(app)).join("\n")
    expect(frame).toContain("/codegraph-build")
    expect(frame).toContain("engine")
    expect(frame).toContain("postinstall")
    // Only the touched files are mapped: a file nobody opened is not there.
    expect(frame).not.toContain("blast-radius")
  } finally {
    app.renderer.destroy()
  }
})

test("b blast radius draws arcs and the same score the tool reports", async () => {
  const plain = props({ codegraph: graphFiles(), root: ROOT, spans: new Map([["ses_c1", sawEngine]]) })
  plain.view.selectFile("packages/core/src/engine.ts")
  const app = await mount(() => <RootsLens {...plain} />, { width: 90, height: 37 })
  try {
    expect(lines(gridOf(app)).join("\n")).not.toContain("BLAST RADIUS")
  } finally {
    app.renderer.destroy()
  }

  const blasting = props({ codegraph: graphFiles(), root: ROOT, spans: new Map([["ses_c1", sawEngine]]), animations: true })
  blasting.view.selectFile("packages/core/src/engine.ts")
  blasting.view.setBlast(true)
  const shown = await mount(() => <RootsLens {...blasting} />, { width: 90, height: 37 })
  try {
    const frame = lines(gridOf(shown)).join("\n")
    expect(frame).toContain("BLAST RADIUS")
    expect(frame).toContain("2 direct")
    expect(frame).toContain("LOW")
  } finally {
    shown.renderer.destroy()
  }
})

test("a stale edit marks the tile, and a re-read clears it", async () => {
  const message = (id: string, at: number, name: string, file: string): SessionMessageInfo =>
    ({
      id,
      type: "assistant",
      time: { created: at, completed: at + 10 },
      agent: "build",
      model: { providerID: "provider", id: "model" },
      content: [
        {
          id: `${id}:0`,
          type: "tool",
          name,
          state: { status: "completed", input: { filePath: file }, output: "", metadata: {} },
          time: { created: at, ran: at },
        },
      ],
    }) as unknown as SessionMessageInfo

  const file = "packages/core/src/postinstall.ts"
  const reader = [message("m1", 10_000, "read", file), message("m3", 30_000, "edit", file)]
  const writer = [message("m0", 5_000, "read", file), message("m2", 20_000, "edit", file)]

  const clean = await mount(
    () => <RootsLens {...props({ codegraph: graphFiles(), root: ROOT })} />,
    { width: 90, height: 37 },
  )
  const stale = await mount(
    () =>
      <RootsLens
        {...props({
          codegraph: graphFiles(),
          root: ROOT,
          messages: (id) => (id === "ses_c1" ? reader : id === "ses_c2" ? writer : []),
        })}
      />,
    { width: 90, height: 37 },
  )
  const reread = await mount(
    () =>
      <RootsLens
        {...props({
          codegraph: graphFiles(),
          root: ROOT,
          messages: (id) =>
            id === "ses_c1"
              ? [...reader, message("m4", 40_000, "read", file)]
              : id === "ses_c2"
                ? writer
                : [],
        })}
      />,
    { width: 90, height: 37 },
  )
  try {
    const rect = tileRect(90, 37, file)
    const cleanCell = gridOf(clean).cell(rect.x, rect.y)!
    const staleCell = gridOf(stale).cell(rect.x, rect.y)!
    expect(staleCell.bg.equals(cleanCell.bg)).toBe(false)
    expect(signature(gridOf(reread))).toBe(signature(gridOf(clean)))
  } finally {
    clean.renderer.destroy()
    stale.renderer.destroy()
    reread.renderer.destroy()
  }
})

test("the lens fits every terminal size the brief lists", async () => {
  for (const [width, height] of [
    [122, 44],
    [90, 37],
    [92, 29],
    [82, 19],
    [68, 15],
  ] as const) {
    const app = await mount(
      () =>
        <RootsLens
          {...props({ width, height, codegraph: graphFiles(), root: ROOT, spans: new Map([["ses_c1", sawEngine]]) })}
        />,
      { width, height },
    )
    try {
      expect(slack(app, width)).toBeLessThanOrEqual(0)
      expect(gridOf(app).lines()).toHaveLength(height)
      expect(lines(gridOf(app)).join("\n")).toContain("read")
    } finally {
      app.renderer.destroy()
    }
  }
})

test("clicking a tile selects its file, and clicking a header zooms", async () => {
  const picked: Array<string | undefined> = []
  const zoomed: Array<string | undefined> = []
  const base = props({ codegraph: graphFiles(), root: ROOT, onFile: (path) => picked.push(path) })
  const app = await mount(
    () => <RootsLens {...base} onMapRoot={(name) => zoomed.push(name)} />,
    { width: 90, height: 37 },
  )
  try {
    const rect = tileRect(90, 37, "packages/core/src/engine.ts")
    await app.mockMouse.click(rect.x + 1, rect.y + 1)
    expect(picked.at(-1)).toBe("packages/core/src/engine.ts")

    const head = layoutMap(repoMapFromGraph({ nodes, edges, files }), mapRect(90, 37).rect).heads[0]!
    await app.mockMouse.click(head.rect.x + 1, head.rect.y)
    expect(zoomed.at(-1)).toBe(head.name)
  } finally {
    app.renderer.destroy()
  }
})
