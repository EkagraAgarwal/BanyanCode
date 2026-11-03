import { expect, test } from "bun:test"
import type { SessionMessageInfo } from "@opencode/client"
import type { CodegraphEdge, CodegraphFile, CodegraphNode } from "../src/data/pending-rpc"
import {
  BLAST_DEPTH,
  blastScore,
  blastWalk,
  buildRepoMap,
  fileTouches,
  fileSheet,
  HEAT,
  heatAt,
  heatIndex,
  layoutFlat,
  layoutMap,
  mapRect,
  normalizeRepoPath,
  openStaleEdits,
  recentTouches,
  repoMapFromGraph,
  resolveFile,
  type FileTouch,
  type MapFileInput,
} from "../src/data/understory-map"
import type { AgentSpan, SpanSession } from "../src/data/understory-spans"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Lens sizes measured from the mockup's own frames at the five brief sizes. */
const LENSES = [
  { width: 122, height: 44, terminal: "200x55" },
  { width: 90, height: 37, terminal: "168x48" },
  { width: 92, height: 29, terminal: "120x40" },
  { width: 82, height: 19, terminal: "100x30" },
  { width: 68, height: 15, terminal: "80x24" },
] as const

const FILES: MapFileInput[] = [
  { path: "packages/core/src/a.ts", lines: 400 },
  { path: "packages/core/src/b.ts", lines: 120 },
  { path: "packages/core/src/deep/c.ts", lines: 80 },
  { path: "packages/core/src/deep/deeper/d.ts", lines: 12 },
  { path: "packages/core/test/a.test.ts", lines: 60 },
  { path: "packages/tui/src/x.tsx", lines: 240 },
  { path: "packages/tui/src/y.tsx", lines: 40 },
  { path: "packages/tui/src/frame/z.tsx", lines: 90 },
  { path: "packages/banyancode/src/intel/blast-radius.ts", lines: 93 },
  { path: "packages/banyancode/src/codegraph/codegraph-repo.ts", lines: 1200 },
  { path: "docs/readme.md", lines: 120 },
  { path: "scripts/build.ts", lines: 200 },
  { path: "AGENTS.md", lines: 300 },
]

const EDGES = [
  { from: "packages/core/src/b.ts", to: "packages/core/src/a.ts" },
  { from: "packages/core/src/deep/c.ts", to: "packages/core/src/b.ts" },
  { from: "packages/tui/src/x.tsx", to: "packages/core/src/a.ts" },
  { from: "packages/tui/src/frame/z.tsx", to: "packages/tui/src/x.tsx" },
]

const touch = (path: string, verb: "read" | "edit", at: number, sessionID = "ses_a"): FileTouch => ({
  path,
  sessionID,
  verb,
  at,
})

const span = (input: Partial<AgentSpan> & { readonly t0: number; readonly letter: AgentSpan["letter"] }): AgentSpan => ({
  id: `span-${input.t0}-${input.letter}`,
  kind: "tool",
  name: "read",
  target: "",
  ...input,
})

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

test("a tool path lands on the graph's repo-relative key at any casing or separator", () => {
  expect(normalizeRepoPath("packages/core/src/a.ts")).toBe("packages/core/src/a.ts")
  expect(normalizeRepoPath("packages\\core\\src\\a.ts")).toBe("packages/core/src/a.ts")
  expect(normalizeRepoPath("D:\\repo\\packages\\core\\src\\a.ts", "D:\\repo")).toBe("packages/core/src/a.ts")
  expect(normalizeRepoPath("d:/repo/packages/core/src/a.ts", "D:\\REPO")).toBe("packages/core/src/a.ts")
  expect(normalizeRepoPath("./packages/core/src/a.ts")).toBe("packages/core/src/a.ts")
  expect(normalizeRepoPath("D:\\repo\\AGENTS.md", "D:/repo")).toBe("AGENTS.md")
  expect(normalizeRepoPath("AGENTS.md", "D:/repo")).toBe("AGENTS.md")

  // No root to compare against: the suffix walk still finds the file.
  const map = buildRepoMap({ files: FILES, edges: EDGES })
  expect(resolveFile(map, "D:\\somewhere\\else\\packages\\core\\src\\a.ts")?.path).toBe("packages/core/src/a.ts")
  expect(resolveFile(map, "PACKAGES/CORE/SRC/A.TS")?.path).toBe("packages/core/src/a.ts")
  expect(resolveFile(map, "packages/core/src/missing.ts")).toBeUndefined()
})

// ---------------------------------------------------------------------------
// Treemap
// ---------------------------------------------------------------------------

test("the treemap exactly fills its rect and never overlaps, at all five sizes", () => {
  const map = buildRepoMap({ files: FILES, edges: EDGES })
  for (const lens of LENSES) {
    const { rect } = mapRect(lens.width, lens.height)
    const { tiles, heads } = layoutMap(map, rect)
    expect(tiles.length).toBeGreaterThan(0)
    let area = 0
    for (const tile of tiles) {
      const { x, y, w, h } = tile.rect
      expect(w).toBeGreaterThan(0)
      expect(h).toBeGreaterThan(0)
      expect(x).toBeGreaterThanOrEqual(rect.x)
      expect(y).toBeGreaterThanOrEqual(rect.y)
      expect(x + w).toBeLessThanOrEqual(rect.x + rect.w)
      expect(y + h).toBeLessThanOrEqual(rect.y + rect.h)
      area += w * h
    }
    // Every cell of the map is a tile or a package header row: nothing is lost
    // and nothing is drawn twice.
    for (const head of heads) area += head.rect.w * head.rect.h
    expect(area).toBe(rect.w * rect.h)
    // No overlap is implied by the exact fill plus containment, but check the
    // rectangles pairwise too, so a future splitter bug cannot hide.
    const boxes = [...tiles.map((tile) => tile.rect), ...heads.map((head) => head.rect)]
    for (let left = 0; left < boxes.length; left += 1) {
      for (let right = left + 1; right < boxes.length; right += 1) {
        const a = boxes[left]!
        const b = boxes[right]!
        const overlap = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) *
          Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y))
        expect(overlap, `${lens.terminal} box ${left} vs ${right}`).toBe(0)
      }
    }
  }
})

test("every file gets a tile, and the small ones merge into one +N tile", () => {
  const map = buildRepoMap({ files: FILES, edges: EDGES })
  const { byFile } = layoutMap(map, mapRect(122, 44).rect)
  expect(byFile.size).toBe(FILES.length)

  const many: MapFileInput[] = Array.from({ length: 60 }, (_, index) => ({ path: `packages/big/src/f${index}.ts`, lines: 10 }))
  const cramped = layoutFlat(many, mapRect(40, 8).rect)
  expect(cramped.tiles.some((tile) => tile.files.length > 1)).toBe(true)
  // A merged tile carries every file it swallowed, and each maps back to it.
  const merged = cramped.tiles.find((tile) => tile.files.length > 1)!
  expect(merged.files.length).toBeGreaterThan(1)
  for (const path of merged.files) expect(cramped.byFile.get(path)).toBe(merged)
})

test("the layout is deterministic, and zooming keeps one package", () => {
  const first = layoutMap(buildRepoMap({ files: FILES, edges: EDGES }), mapRect(90, 37).rect)
  const second = layoutMap(buildRepoMap({ files: FILES, edges: EDGES }), mapRect(90, 37).rect)
  expect(first.tiles.map((tile) => [tile.key, tile.rect])).toEqual(second.tiles.map((tile) => [tile.key, tile.rect]))

  const map = buildRepoMap({ files: FILES, edges: EDGES })
  const zoomed = layoutMap(map, mapRect(90, 37).rect, "tui")
  expect(zoomed.heads.map((head) => head.name)).toEqual(["tui"])
  const inPackage = new Set(zoomed.tiles.flatMap((tile) => tile.files))
  expect([...inPackage].every((path) => path.startsWith("packages/tui/"))).toBe(true)

  // A zoom on a package that no longer exists draws the whole map.
  expect(layoutMap(map, mapRect(90, 37).rect, "gone").tiles.length).toBe(first.tiles.length)
})

test("packages and directories split by weight, biggest first", () => {
  const map = buildRepoMap({ files: FILES, edges: EDGES })
  expect(map.packages.map((pkg) => pkg.name)).toEqual(["banyancode", "core", "tui", "AGENTS.md", "scripts", "docs"])
  const core = map.packages.find((pkg) => pkg.name === "core")!
  expect(core.dirs.map((dir) => dir.name)).toEqual(["src", "deep", "test"])
  // Weight is `lines ** 0.7`.
  expect(map.byPath.get("packages/core/src/a.ts")!.weight).toBeCloseTo(400 ** 0.7, 6)
})

test("the graph becomes a repo map: file nodes carry the line counts, edges the dependents", () => {
  const files: CodegraphFile[] = [
    { id: "f1", path: "packages/core/src/a.ts", contentHash: "h", language: "typescript", indexedAt: 1 },
    { id: "f2", path: "packages/core/src/b.ts", contentHash: "h", language: "typescript", indexedAt: 1 },
    { id: "f3", path: "packages/core/src/c.ts", contentHash: "h", language: "typescript", indexedAt: 1, sizeBytes: 400 },
  ]
  const node = (id: string, fileID: string, kind: string, endLine: number, signature?: string): CodegraphNode => ({
    id,
    fileID,
    kind,
    name: id,
    startLine: 1,
    endLine,
    ...(signature === undefined ? {} : { signature }),
  })
  const nodes: CodegraphNode[] = [
    node("f1:file", "f1", "file", 400, "packages/core/src/a.ts"),
    node("f1:fn", "f1", "function", 20),
    node("f2:file", "f2", "file", 120, "packages/core/src/b.ts"),
    node("f2:fn", "f2", "function", 40),
    node("f3:file", "f3", "file", 50, "packages/core/src/c.ts"),
  ]
  const edges: CodegraphEdge[] = [
    { id: "e1", fromNodeID: "f2:fn", toNodeID: "f1:fn", kind: "imports" },
    { id: "e2", fromNodeID: "f1:fn", toNodeID: "f2:file", kind: "imports" },
  ]
  const map = repoMapFromGraph({ files, nodes, edges })
  expect(map.files.map((file) => file.path).sort()).toEqual([
    "packages/core/src/a.ts",
    "packages/core/src/b.ts",
    "packages/core/src/c.ts",
  ])
  expect(map.byPath.get("packages/core/src/a.ts")!.lines).toBe(400)
  expect(map.dependents.get("packages/core/src/a.ts")).toEqual(["packages/core/src/b.ts"])
  expect(map.dependents.get("packages/core/src/b.ts")).toEqual(["packages/core/src/a.ts"])
  // A file node missing from the paged list still gets a weight from its size.
  expect(map.byPath.get("packages/core/src/c.ts")!.lines).toBe(50)
})

// ---------------------------------------------------------------------------
// Heat
// ---------------------------------------------------------------------------

test("heat decays with the brief's taus and floors", () => {
  const events = [touch("packages/core/src/a.ts", "read", 0), touch("packages/core/src/a.ts", "edit", 0)]

  expect(heatAt(events, 0)).toEqual({ read: 1, edit: 1 })
  expect(HEAT.read.tau).toBe(14_000)
  expect(HEAT.edit.tau).toBe(45_000)

  const atFourteen = heatAt(events, 14_000)
  expect(atFourteen.read).toBeCloseTo(Math.exp(-1), 6)
  expect(atFourteen.edit).toBeCloseTo(Math.exp(-14_000 / 45_000), 6)

  // Neither ever falls under its floor, which is what keeps a file marked.
  expect(heatAt(events, 42_000).read).toBe(HEAT.read.floor)
  // exp(-45/45) is 0.368, under the edit floor, so the floor wins.
  expect(heatAt(events, 45_000).edit).toBe(HEAT.edit.floor)
  expect(heatAt(events, 30_000).edit).toBeCloseTo(Math.exp(-30_000 / 45_000), 6)
  expect(heatAt(events, 4_500_000).edit).toBe(HEAT.edit.floor)

  // A replay earlier than the touch shows no heat at all.
  expect(heatAt(events, -1)).toEqual({ read: 0, edit: 0 })
  const index = heatIndex(events, -1)
  expect(index.size).toBe(0)
  expect(heatIndex(events, 0).get("packages/core/src/a.ts")).toEqual({ read: 1, edit: 1 })
})

test("touches come from the spans' own letters, and a comet only from the last 1.2 s", () => {
  const spans = new Map([
    [
      "ses_a",
      [
        span({ t0: 1_000, t1: 1_200, letter: "R", file: "D:\\repo\\packages\\core\\src\\a.ts" }),
        span({ t0: 2_000, letter: "E", file: "D:\\repo\\packages\\core\\src\\a.ts", added: 3, removed: 1 }),
        span({ t0: 3_000, letter: "S", file: "packages/core/src/b.ts" }),
        span({ t0: 4_000, letter: "R" }),
      ],
    ],
  ])
  const touches = fileTouches(spans, "D:\\repo")
  expect(touches).toHaveLength(2)
  expect(touches[0]).toMatchObject({ path: "packages/core/src/a.ts", verb: "read", at: 1_000 })
  expect(touches[1]).toMatchObject({ verb: "edit", added: 3, removed: 1 })

  expect(recentTouches(touches, "ses_a", 2_000)).toHaveLength(2)
  expect(recentTouches(touches, "ses_a", 2_300)).toHaveLength(1)
  expect(recentTouches(touches, "ses_a", 3_400)).toHaveLength(0)
  expect(recentTouches(touches, "ses_b", 2_000)).toHaveLength(0)
})

// ---------------------------------------------------------------------------
// Stale reads
// ---------------------------------------------------------------------------

const message = (id: string, at: number, tools: ReadonlyArray<{ readonly name: string; readonly file: string }>): SessionMessageInfo =>
  ({
    id,
    type: "assistant",
    time: { created: at, completed: at + 10 },
    agent: "build",
    model: { providerID: "provider", id: "model" },
    content: tools.map((tool, index) => ({
      id: `${id}:${index}`,
      type: "tool",
      name: tool.name,
      state: { status: "completed", input: { filePath: tool.file }, output: "", metadata: {} },
      time: { created: at, ran: at },
    })),
  }) as unknown as SessionMessageInfo

test("a later sibling edit raises a stale read, and a re-read clears it", () => {
  const reader: SpanSession = {
    sessionID: "ses_reader",
    label: "coder-1",
    messages: [
      message("m1", 10_000, [{ name: "read", file: "packages/core/src/a.ts" }]),
      message("m3", 30_000, [{ name: "edit", file: "packages/core/src/a.ts" }]),
    ],
  }
  const writer: SpanSession = {
    sessionID: "ses_writer",
    label: "coder-2",
    messages: [
      message("m0", 5_000, [{ name: "read", file: "packages/core/src/a.ts" }]),
      message("m2", 20_000, [{ name: "edit", file: "packages/core/src/a.ts" }]),
    ],
  }

  // Before the reader's own edit there is nothing to warn about.
  expect(openStaleEdits([reader, writer], 15_000)).toHaveLength(0)
  expect(openStaleEdits([reader, writer], 25_000)).toHaveLength(0)
  const raised = openStaleEdits([reader, writer], 35_000)
  expect(raised).toHaveLength(1)
  expect(raised[0]).toMatchObject({
    path: "packages/core/src/a.ts",
    reader: "ses_reader",
    readerLabel: "coder-1",
    writer: "ses_writer",
    writerLabel: "coder-2",
    readAt: 10_000,
    editedAt: 30_000,
  })

  // A replay before the edit does not show the alert yet.
  expect(openStaleEdits([reader, writer], 29_000)).toHaveLength(0)

  // The reader re-reads: the warning is over.
  const reread: SpanSession = {
    ...reader,
    messages: [...reader.messages, message("m4", 40_000, [{ name: "read", file: "packages/core/src/a.ts" }])],
  }
  expect(openStaleEdits([reread, writer], 45_000)).toHaveLength(0)
})

// ---------------------------------------------------------------------------
// Blast radius
// ---------------------------------------------------------------------------

const dependents = (graph: Readonly<Record<string, readonly string[]>>) => new Map(Object.entries(graph))

test("the blast walk stops at depth 3 and scores with the tool's ladder", () => {
  const map = dependents({ a: ["b", "c"], b: ["d"], d: ["e"], e: ["f"] })
  const blast = blastWalk(map, "a")
  expect(BLAST_DEPTH).toBe(3)
  expect(blast.dist.get("b")).toBe(1)
  expect(blast.dist.get("d")).toBe(2)
  expect(blast.dist.get("e")).toBe(3)
  expect(blast.dist.has("f")).toBe(false)
  expect(blast.direct).toBe(2)
  expect(blast.transitive).toBe(2)
  expect(blast.score).toBe("low")

  // The ladder from intel/blast-radius.ts.
  expect(blastScore(0, 0)).toBe("low")
  expect(blastScore(3, 3)).toBe("low")
  expect(blastScore(4, 0)).toBe("medium")
  expect(blastScore(2, 5)).toBe("medium")
  expect(blastScore(11, 0)).toBe("high")
  expect(blastScore(2, 25)).toBe("high")
})

// ---------------------------------------------------------------------------
// File sheet
// ---------------------------------------------------------------------------

test("the file sheet carries lines, imports, dependents, the score and the touches", () => {
  const map = buildRepoMap({ files: FILES, edges: EDGES })
  const spans = new Map([
    ["ses_a", [span({ t0: 1_000, t1: 1_200, letter: "R", file: "packages/core/src/a.ts" })]],
    ["ses_b", [span({ t0: 2_000, letter: "E", file: "packages/core/src/a.ts", added: 6, removed: 1 })]],
  ])
  const sheet = fileSheet({
    map,
    path: "D:\\repo\\packages\\core\\src\\a.ts",
    root: "D:\\repo",
    spans,
    labels: new Map([
      ["ses_a", "explore-1"],
      ["ses_b", "coder-2"],
    ]),
    t: 1_500,
  })
  expect(sheet).toBeDefined()
  expect(sheet!.path).toBe("packages/core/src/a.ts")
  expect(sheet!.name).toBe("a")
  expect(sheet!.lines).toBe(400)
  expect([...sheet!.dependents].sort()).toEqual(["packages/core/src/b.ts", "packages/tui/src/x.tsx"])
  expect(sheet!.imports).toEqual([])
  expect(sheet!.blast.direct).toBe(2)
  expect(sheet!.blast.score).toBe("low")
  // Only the touch at or before the playhead is on the sheet.
  expect(sheet!.touches).toHaveLength(1)
  expect(sheet!.touches[0]).toMatchObject({ label: "explore-1", verb: "read", at: 1_000 })

  const every = fileSheet({ map, path: "packages/core/src/a.ts", spans })
  expect(every!.touches.map((item) => item.verb)).toEqual(["read", "edit"])
  expect(every!.touches[1]).toMatchObject({ added: 6, removed: 1 })

  // A file the graph has never indexed still gets a sheet.
  const unknown = fileSheet({ map, path: "packages/core/src/new.ts", spans })
  expect(unknown).toMatchObject({ lines: 0, dependents: [], imports: [] })
})
