import type { AgentSpan, SpanSession, StaleEdit } from "./understory-spans"
import { staleEdits } from "./understory-spans"
import type { CodegraphEdge, CodegraphFile, CodegraphNode } from "./pending-rpc"

/**
 * Pure data for the Roots lens: the repo treemap, the file heat that decays
 * with the playhead, the blast walk and the stale-read check. Nothing here
 * imports Solid and nothing reads the clock: the caller passes the playhead
 * `T`, so replay is the same call with an older `T`.
 *
 * The map mirrors the mockup's model (`specs/tui-redesign-handoff/agents-tab.html`
 * lines 441-486): packages, then directories, then files, weighted by
 * `lines ** 0.7`, split with a binary space partition so the tiles always fill
 * their rectangle exactly. The mockup's baked-in `REPO` constant is mock data
 * and is not ported.
 */

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const stripDrive = (value: string): string => value.replace(/^[A-Za-z]:/, "")

/**
 * One repo-relative key for a file. Tool calls carry absolute paths (and on
 * Windows, backslashes); the code graph carries repo-relative ones. Both land
 * on the same key so a curve reaches its tile.
 */
export function normalizeRepoPath(value: string, root?: string | undefined): string {
  const path = stripDrive(value.trim().replace(/\\/g, "/"))
  const base = root === undefined ? "" : stripDrive(root.trim().replace(/\\/g, "/")).replace(/\/+$/, "")
  const inside = base !== "" && path.toLowerCase().startsWith(`${base.toLowerCase()}/`) ? path.slice(base.length) : path
  return inside.replace(/^\/+/, "").replace(/^(\.\/)+/, "").replace(/\/{2,}/g, "/")
}

// ---------------------------------------------------------------------------
// Files, packages and directories
// ---------------------------------------------------------------------------

export interface MapFileInput {
  readonly path: string
  /** Lines of code; the treemap weight is `lines ** 0.7`. */
  readonly lines?: number | undefined
}

export interface MapEdgeInput {
  /** The importer. */
  readonly from: string
  /** The imported file. */
  readonly to: string
}

export interface RepoMapInput {
  readonly files: readonly MapFileInput[]
  readonly edges?: readonly MapEdgeInput[] | undefined
  /** Repo root, so absolute and relative paths share one key. */
  readonly root?: string | undefined
}

export interface MapFile {
  readonly path: string
  readonly pkg: string
  readonly dir: string
  /** Base name with the code extension dropped, as the tile labels it. */
  readonly name: string
  readonly lines: number
  readonly weight: number
}

export interface MapDir {
  readonly name: string
  /** Position after sorting, which picks the tile shade. */
  readonly index: number
  readonly weight: number
  readonly files: readonly MapFile[]
}

export interface MapPackage {
  readonly name: string
  readonly weight: number
  readonly dirs: readonly MapDir[]
}

export interface RepoMap {
  readonly files: readonly MapFile[]
  readonly byPath: ReadonlyMap<string, MapFile>
  /** Case-folded lookup, so a tool path with different casing still lands. */
  readonly byLowerPath: ReadonlyMap<string, MapFile>
  readonly packages: readonly MapPackage[]
  /** Files that import this one. */
  readonly dependents: ReadonlyMap<string, readonly string[]>
  /** Files this one imports. */
  readonly imports: ReadonlyMap<string, readonly string[]>
}

export const WEIGHT_EXPONENT = 0.7
/** Files under this many lines, or without a line count, weigh the same. */
const MIN_LINES = 1
const CODE_EXTENSION = /\.(tsx?|jsx?|mjs|cjs|mts|cts|py|rb|go|rs|java|kt|cs|php|c|cc|cpp|h|hpp|sh|bash|ps1|sql|zig|swift)$/

export const weightOf = (lines: number | undefined): number => Math.max(MIN_LINES, lines ?? MIN_LINES) ** WEIGHT_EXPONENT

const baseName = (path: string): string => {
  const name = path.slice(path.lastIndexOf("/") + 1)
  return name.replace(CODE_EXTENSION, "")
}

/** The mockup's grouping rule: `packages/<name>/src/...` is package `<name>`, dir `src`. */
function groupPath(path: string): { pkg: string; dir: string } {
  const segments = path.split("/")
  const scoped = segments[0] === "packages"
  const pkg = (scoped ? segments[1] : segments[0]) ?? path
  const rest = scoped ? segments.slice(2) : segments.slice(1)
  const head = rest[0]
  const dir =
    head === "src" ? ((rest.length > 2 ? rest[1] : "src") ?? "src") : rest.length > 1 ? (head ?? ".") : "."
  return { pkg, dir }
}

const byWeightThenName = <T extends { readonly weight: number }>(name: (value: T) => string) => (left: T, right: T) =>
  right.weight - left.weight || name(left).localeCompare(name(right))

/**
 * The repo model the treemap draws. Deterministic for a given input: every sort
 * has a name tie-breaker, so the same graph lays out the same tiles.
 */
export function buildRepoMap(input: RepoMapInput): RepoMap {
  const seen = new Map<string, MapFile>()
  for (const entry of input.files) {
    const path = normalizeRepoPath(entry.path, input.root)
    if (path === "") continue
    if (seen.has(path)) continue
    const { pkg, dir } = groupPath(path)
    const lines = Math.max(0, Math.floor(entry.lines ?? 0))
    seen.set(path, { path, pkg, dir, name: baseName(path), lines, weight: weightOf(lines) })
  }
  const files = [...seen.values()].sort(byWeightThenName((file) => file.path))

  const groups = new Map<string, Map<string, MapFile[]>>()
  for (const file of files) {
    const dirs = groups.get(file.pkg)
    if (dirs === undefined) groups.set(file.pkg, new Map([[file.dir, [file]]]))
    else {
      const list = dirs.get(file.dir)
      if (list === undefined) dirs.set(file.dir, [file])
      else list.push(file)
    }
  }
  const packages = [...groups.entries()]
    .map(([name, dirs]): MapPackage => {
      const resolved = [...dirs.entries()]
        .map(([dir, own], index): MapDir => ({
          name: dir,
          index,
          weight: own.reduce((sum, file) => sum + file.weight, 0),
          files: own,
        }))
        .sort(byWeightThenName((dir) => dir.name))
        .map((dir, index) => ({ ...dir, index }))
      return { name, weight: resolved.reduce((sum, dir) => sum + dir.weight, 0), dirs: resolved }
    })
    .sort(byWeightThenName((pkg) => pkg.name))

  const dependents = new Map<string, string[]>()
  const imports = new Map<string, string[]>()
  const known = (path: string): string | undefined => {
    const direct = seen.get(path)
    if (direct !== undefined) return direct.path
    return undefined
  }
  for (const edge of input.edges ?? []) {
    const from = known(normalizeRepoPath(edge.from, input.root))
    const to = known(normalizeRepoPath(edge.to, input.root))
    if (from === undefined || to === undefined || from === to) continue
    const own = imports.get(from)
    if (own === undefined) imports.set(from, [to])
    else if (!own.includes(to)) own.push(to)
    const inbound = dependents.get(to)
    if (inbound === undefined) dependents.set(to, [from])
    else if (!inbound.includes(from)) inbound.push(from)
  }

  return {
    files,
    byPath: new Map(files.map((file) => [file.path, file])),
    byLowerPath: new Map(files.map((file) => [file.path.toLowerCase(), file])),
    packages,
    dependents,
    imports,
  }
}

/**
 * The file a path names. Exact first, then case-insensitively (models disagree
 * about casing on Windows), then by dropping leading segments: a tool call can
 * carry the worktree's absolute prefix and this still lands on the graph's
 * repo-relative key.
 */
export function resolveFile(map: RepoMap, path: string, root?: string | undefined): MapFile | undefined {
  const normalized = normalizeRepoPath(path, root)
  const direct = map.byPath.get(normalized) ?? map.byLowerPath.get(normalized.toLowerCase())
  if (direct !== undefined) return direct
  const segments = normalized.split("/")
  for (let start = 1; start < segments.length; start += 1) {
    const suffix = segments.slice(start).join("/")
    const match = map.byPath.get(suffix) ?? map.byLowerPath.get(suffix.toLowerCase())
    if (match !== undefined) return match
  }
  return undefined
}

export const lookupFile = resolveFile

// ---------------------------------------------------------------------------
// From the code graph
// ---------------------------------------------------------------------------

/** Lines per byte when a file node is missing, so a weight is still a weight. */
const BYTES_PER_LINE = 40

/**
 * The repo map the graph describes. Every file gets its line count from its
 * file-level node (`kind: "file"`, whose `endLine` is the line count), and the
 * import edges become file-to-file dependents. Paged data is truncated by the
 * caller, so a missing file node falls back to its size.
 */
export function repoMapFromGraph(input: {
  readonly nodes?: readonly CodegraphNode[] | undefined
  readonly edges?: readonly CodegraphEdge[] | undefined
  readonly files?: readonly CodegraphFile[] | undefined
  readonly root?: string | undefined
}): RepoMap {
  const pathByFileID = new Map<string, string>()
  const sizeByFileID = new Map<string, number>()
  for (const file of input.files ?? []) pathByFileID.set(file.id, file.path)
  for (const file of input.files ?? []) if (file.sizeBytes !== undefined) sizeByFileID.set(file.id, file.sizeBytes)

  const linesByFileID = new Map<string, number>()
  const pathByNodeID = new Map<string, string>()
  for (const node of input.nodes ?? []) {
    pathByNodeID.set(node.id, node.fileID)
    if (node.kind !== "file") continue
    if (!pathByFileID.has(node.fileID) && node.signature !== undefined) pathByFileID.set(node.fileID, node.signature)
    linesByFileID.set(node.fileID, node.endLine)
  }

  const entries: MapFileInput[] = []
  for (const [id, path] of pathByFileID) {
    const lines = linesByFileID.get(id)
    const size = sizeByFileID.get(id)
    entries.push({
      path,
      lines: lines ?? (size === undefined ? undefined : Math.max(1, Math.round(size / BYTES_PER_LINE))),
    })
  }

  const introduced = new Set(entries.map((entry) => normalizeRepoPath(entry.path, input.root)))
  const edgeList: MapEdgeInput[] = []
  for (const edge of input.edges ?? []) {
    const from = pathByFileID.get(pathByNodeID.get(edge.fromNodeID) ?? "")
    const to = pathByFileID.get(pathByNodeID.get(edge.toNodeID) ?? "")
    if (from === undefined || to === undefined || from === to) continue
    const fromPath = normalizeRepoPath(from, input.root)
    const toPath = normalizeRepoPath(to, input.root)
    if (!introduced.has(fromPath) || !introduced.has(toPath)) continue
    edgeList.push({ from: fromPath, to: toPath })
  }

  return buildRepoMap({ files: entries, edges: edgeList, ...(input.root === undefined ? {} : { root: input.root }) })
}

// ---------------------------------------------------------------------------
// Treemap
// ---------------------------------------------------------------------------

export interface Rect {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

export interface MapTile {
  /** The first file's path: stable across frames, so a tile can be matched. */
  readonly key: string
  readonly files: readonly string[]
  readonly rect: Rect
  /** Directory position, which picks the shade; 0 for a merged tile. */
  readonly shade: number
}

export interface MapHead {
  readonly name: string
  readonly rect: Rect
}

export interface MapLayout {
  readonly tiles: readonly MapTile[]
  readonly heads: readonly MapHead[]
  readonly byFile: ReadonlyMap<string, MapTile>
}

/** The mockup's channel: curves run in it, tiles start after it. */
export function mapRect(width: number, height: number): { readonly channel: number; readonly rect: Rect } {
  const w = Math.max(0, Math.floor(width))
  const h = Math.max(0, Math.floor(height))
  const upper = Math.max(0, Math.min(18, w - 2))
  const channel = Math.max(0, Math.min(upper, Math.max(6, Math.round(w * 0.17))))
  return { channel, rect: { x: channel, y: 0, w: Math.max(0, w - channel - 1), h: Math.max(0, h - 1) } }
}

const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value))

/**
 * Binary space partition from the mockup (lines 464-473). The first branch
 * takes whole items while it stays under half the weight, then the two halves
 * are split along the longer side, so the tiles exactly fill `x, y, w, h` and
 * never overlap. Too little room for the item count merges the lot into one
 * `merged` tile, which is where `+N` comes from.
 */
function bsp<T>(
  items: readonly T[],
  weightOfItem: (item: T) => number,
  x: number,
  y: number,
  w: number,
  h: number,
  emit: (item: T, x: number, y: number, w: number, h: number) => void,
  merged: (items: readonly T[], x: number, y: number, w: number, h: number) => void,
): void {
  if (items.length === 0 || w < 1 || h < 1) return
  if (items.length === 1) {
    emit(items[0], x, y, w, h)
    return
  }
  if (w * h < items.length * 4) {
    merged(items, x, y, w, h)
    return
  }
  const total = items.reduce((sum, item) => sum + weightOfItem(item), 0)
  let acc = 0
  let k = 0
  while (k < items.length - 1 && (k === 0 || acc + weightOfItem(items[k]) / 2 < total / 2)) {
    acc += weightOfItem(items[k])
    k += 1
  }
  const first = items.slice(0, k)
  const second = items.slice(k)
  const fraction = total > 0 ? acc / total : 0.5
  if ((w >= h * 2.1 && w >= 2) || h < 2) {
    const wa = clamp(Math.round(w * fraction), 1, w - 1)
    bsp(first, weightOfItem, x, y, wa, h, emit, merged)
    bsp(second, weightOfItem, x + wa, y, w - wa, h, emit, merged)
    return
  }
  const ha = clamp(Math.round(h * fraction), 1, h - 1)
  bsp(first, weightOfItem, x, y, w, ha, emit, merged)
  bsp(second, weightOfItem, x, y + ha, w, h - ha, emit, merged)
}

const EMPTY_LAYOUT: MapLayout = { tiles: [], heads: [], byFile: new Map() }

/**
 * Packages split by weight, then directories, then files. `root` zooms the map
 * to one package; when that package is unknown the whole map is drawn instead,
 * so a stale zoom can never blank the lens.
 */
export function layoutMap(map: RepoMap, rect: Rect, root?: string | undefined): MapLayout {
  if (rect.w < 1 || rect.h < 1 || map.files.length === 0) return EMPTY_LAYOUT
  const tiles: MapTile[] = []
  const heads: MapHead[] = []
  const byFile = new Map<string, MapTile>()
  const addTile = (files: readonly MapFile[], x: number, y: number, w: number, h: number, shade: number) => {
    if (files.length === 0 || w < 1 || h < 1) return
    const paths = files.map((file) => file.path)
    const tile: MapTile = { key: paths[0]!, files: paths, rect: { x, y, w, h }, shade }
    tiles.push(tile)
    for (const path of paths) if (!byFile.has(path)) byFile.set(path, tile)
  }
  const pack = (pkg: MapPackage, x: number, y: number, w: number, h: number) => {
    let top = y
    let height = h
    if (height >= 3 && w >= 6) {
      heads.push({ name: pkg.name, rect: { x, y, w, h: 1 } })
      top += 1
      height -= 1
    }
    bsp(
      pkg.dirs,
      (dir) => dir.weight,
      x,
      top,
      w,
      height,
      (dir, X, Y, W, H) =>
        bsp(
          dir.files,
          (file) => file.weight,
          X,
          Y,
          W,
          H,
          (file, a, b, c, d) => addTile([file], a, b, c, d, dir.index),
          (files, a, b, c, d) => addTile(files, a, b, c, d, dir.index),
        ),
      (dirs, X, Y, W, H) => addTile(dirs.flatMap((dir) => dir.files), X, Y, W, H, 0),
    )
  }
  const everything = (items: readonly MapPackage[], X: number, Y: number, W: number, H: number) =>
    addTile(items.flatMap((pkg) => pkg.dirs.flatMap((dir) => dir.files)), X, Y, W, H, 0)

  const picked = root === undefined ? undefined : map.packages.find((pkg) => pkg.name === root)
  if (picked !== undefined) pack(picked, rect.x, rect.y, rect.w, rect.h)
  else
    bsp(
      map.packages,
      (pkg) => pkg.weight,
      rect.x,
      rect.y,
      rect.w,
      rect.h,
      (pkg, X, Y, W, H) => pack(pkg, X, Y, W, H),
      everything,
    )
  return { tiles, heads, byFile }
}

/**
 * The gap-(d) map: no code graph, so only the files an agent touched, as one
 * flat treemap. Small ones still merge into `+N`.
 */
export function layoutFlat(files: readonly MapFileInput[], rect: Rect, root?: string | undefined): MapLayout {
  if (rect.w < 1 || rect.h < 1) return EMPTY_LAYOUT
  const seen = new Map<string, MapFile>()
  for (const entry of files) {
    const path = normalizeRepoPath(entry.path, root)
    if (path === "" || seen.has(path)) continue
    const lines = Math.max(0, Math.floor(entry.lines ?? 0))
    const { pkg, dir } = groupPath(path)
    seen.set(path, { path, pkg, dir, name: baseName(path), lines, weight: weightOf(lines) })
  }
  const ordered = [...seen.values()].sort(byWeightThenName((file) => file.path))
  const tiles: MapTile[] = []
  const byFile = new Map<string, MapTile>()
  const addTile = (group: readonly MapFile[], x: number, y: number, w: number, h: number) => {
    if (group.length === 0 || w < 1 || h < 1) return
    const paths = group.map((file) => file.path)
    const tile: MapTile = { key: paths[0]!, files: paths, rect: { x, y, w, h }, shade: 0 }
    tiles.push(tile)
    for (const path of paths) if (!byFile.has(path)) byFile.set(path, tile)
  }
  bsp(
    ordered,
    (file) => file.weight,
    rect.x,
    rect.y,
    rect.w,
    rect.h,
    (file, x, y, w, h) => addTile([file], x, y, w, h),
    (group, x, y, w, h) => addTile(group, x, y, w, h),
  )
  return { tiles, heads: [], byFile }
}

// ---------------------------------------------------------------------------
// Touches and heat
// ---------------------------------------------------------------------------

export type TouchVerb = "read" | "edit"

export interface FileTouch {
  readonly path: string
  readonly sessionID: string
  readonly verb: TouchVerb
  readonly at: number
  readonly added?: number | undefined
  readonly removed?: number | undefined
}

export interface Heat {
  readonly read: number
  readonly edit: number
}

/**
 * The brief's decay (section 6): a read tints sky with tau 14 s and floor 0.3,
 * an edit tints leaf with tau 45 s and floor 0.42. The floor is why a file
 * stays marked as touched for the whole run. Span timestamps are epoch
 * milliseconds, so the taus are too.
 */
export const HEAT = {
  read: { tau: 14_000, floor: 0.3 },
  edit: { tau: 45_000, floor: 0.42 },
} as const

/** Every read and edit in the span data, oldest first, in repo-relative paths. */
export function fileTouches(
  spans: ReadonlyMap<string, readonly AgentSpan[]>,
  root?: string | undefined,
  canonical?: ((path: string) => string | undefined) | undefined,
): FileTouch[] {
  const touches: FileTouch[] = []
  for (const [sessionID, list] of spans) {
    for (const span of list) {
      if (span.file === undefined) continue
      const verb: TouchVerb | undefined = span.letter === "R" ? "read" : span.letter === "E" ? "edit" : undefined
      if (verb === undefined) continue
      touches.push({
        path: canonical?.(span.file) ?? normalizeRepoPath(span.file, root),
        sessionID,
        verb,
        at: span.t0,
        ...(span.added === undefined ? {} : { added: span.added }),
        ...(span.removed === undefined ? {} : { removed: span.removed }),
      })
    }
  }
  return touches.sort((left, right) => left.at - right.at)
}

/** Group once per frame instead of scanning every touch per file. */
export function touchIndex(touches: readonly FileTouch[]): ReadonlyMap<string, readonly FileTouch[]> {
  const index = new Map<string, FileTouch[]>()
  for (const touch of touches) {
    const list = index.get(touch.path)
    if (list === undefined) index.set(touch.path, [touch])
    else list.push(touch)
  }
  return index
}

/** Heat at the playhead. A touch after `t` does not count, so replay rewinds it. */
export function heatAt(events: readonly FileTouch[], t: number): Heat {
  let read = 0
  let edit = 0
  for (const event of events) {
    if (event.at > t) continue
    const decay = Math.exp(-Math.max(0, t - event.at) / (event.verb === "read" ? HEAT.read.tau : HEAT.edit.tau))
    if (event.verb === "read") read = Math.max(read, HEAT.read.floor, decay)
    else edit = Math.max(edit, HEAT.edit.floor, decay)
  }
  return { read, edit }
}

/** Heat for every file that has been touched by `t`. */
export function heatIndex(touches: readonly FileTouch[], t: number): ReadonlyMap<string, Heat> {
  const heats = new Map<string, Heat>()
  for (const [path, events] of touchIndex(touches)) {
    const heat = heatAt(events, t)
    if (heat.read > 0 || heat.edit > 0) heats.set(path, heat)
  }
  return heats
}

/** Touches inside the comet window, for the trail that runs along a root. */
export const COMET_MS = 1_200

export function recentTouches(
  events: readonly FileTouch[],
  sessionID: string,
  t: number,
): readonly FileTouch[] {
  return events.filter((event) => event.sessionID === sessionID && event.at <= t && t - event.at < COMET_MS)
}

// ---------------------------------------------------------------------------
// Blast radius
// ---------------------------------------------------------------------------

export type BlastScore = "low" | "medium" | "high"

/** The brief's depth (section 6): dependents to depth 3. */
export const BLAST_DEPTH = 3

export interface Blast {
  /** Distance per dependent file; the selected file is 0. */
  readonly dist: ReadonlyMap<string, number>
  readonly direct: number
  readonly transitive: number
  readonly score: BlastScore
}

/**
 * The ladder from `packages/banyancode/src/intel/blast-radius.ts:17-23` (the
 * `change_check op=blast_radius` score). It is not importable from this package (that
 * module is not exported from `@banyancode/plugin`) and the RPC takes a symbol,
 * not a file, so the thresholds live here in one place and nowhere else.
 */
export function blastScore(direct: number, transitive: number): BlastScore {
  if (direct === 0) return "low"
  const total = direct + transitive
  if (total > 25 || direct > 10) return "high"
  if (total > 6 || direct > 3) return "medium"
  return "low"
}

/** Walk the importers of one file. `dependents` is "who imports this". */
export function blastWalk(
  dependents: ReadonlyMap<string, readonly string[]>,
  path: string,
  depth = BLAST_DEPTH,
): Blast {
  const dist = new Map<string, number>([[path, 0]])
  let frontier: string[] = [path]
  for (let hop = 1; hop <= Math.max(0, depth) && frontier.length > 0; hop += 1) {
    const next: string[] = []
    for (const node of frontier) {
      for (const dependent of dependents.get(node) ?? []) {
        if (dist.has(dependent)) continue
        dist.set(dependent, hop)
        next.push(dependent)
      }
    }
    frontier = next
  }
  const direct = (dependents.get(path) ?? []).length
  const transitive = Math.max(0, dist.size - 1 - direct)
  return { dist, direct, transitive, score: blastScore(direct, transitive) }
}

// ---------------------------------------------------------------------------
// Stale edits
// ---------------------------------------------------------------------------

/**
 * The advisory stale-read check from `data/understory-spans.ts`, narrowed to the
 * playhead: an alert raised after `t` is not shown yet during a replay.
 */
export function openStaleEdits(sessions: readonly SpanSession[], t: number): readonly StaleEdit[] {
  return staleEdits(sessions).filter((alert) => alert.editedAt <= t)
}

export function stalePaths(alerts: readonly StaleEdit[]): ReadonlySet<string> {
  return new Set(alerts.map((alert) => alert.path))
}

// ---------------------------------------------------------------------------
// File sheet (inspector)
// ---------------------------------------------------------------------------

export interface FileSheetTouch {
  readonly sessionID: string
  readonly label: string
  readonly verb: TouchVerb
  readonly at: number
  readonly added?: number | undefined
  readonly removed?: number | undefined
}

/**
 * Everything the inspector's File sheet shows, straight from the map and the
 * span data. Returned for a file the graph does not know too: `lines` is 0 and
 * the lists are empty, so a new file still shows its touches.
 */
export interface FileSheet {
  readonly path: string
  readonly name: string
  readonly lines: number
  readonly imports: readonly string[]
  readonly dependents: readonly string[]
  readonly blast: Blast
  /** Every touch at or before `t`, oldest first. */
  readonly touches: readonly FileSheetTouch[]
  readonly stale: readonly StaleEdit[]
}

export function fileSheet(input: {
  readonly map: RepoMap
  readonly path: string
  readonly spans: ReadonlyMap<string, readonly AgentSpan[]>
  readonly labels?: ReadonlyMap<string, string> | undefined
  readonly stale?: readonly StaleEdit[] | undefined
  /** The playhead; defaults to every touch. */
  readonly t?: number | undefined
  readonly depth?: number | undefined
  readonly root?: string | undefined
}): FileSheet | undefined {
  const path = normalizeRepoPath(input.path, input.root)
  if (path === "") return undefined
  const file = lookupFile(input.map, path)
  const key = file?.path ?? path
  const dependents = input.map.dependents.get(key) ?? []
  const observed = input.t ?? Number.POSITIVE_INFINITY
  const touches = fileTouches(input.spans, input.root, (value) => resolveFile(input.map, value, input.root)?.path)
    .filter((touch) => touch.path === key && touch.at <= observed)
    .map(
      (touch): FileSheetTouch => ({
        sessionID: touch.sessionID,
        label: input.labels?.get(touch.sessionID) ?? touch.sessionID,
        verb: touch.verb,
        at: touch.at,
        ...(touch.added === undefined ? {} : { added: touch.added }),
        ...(touch.removed === undefined ? {} : { removed: touch.removed }),
      }),
    )
  return {
    path: key,
    name: file?.name ?? baseName(path),
    lines: file?.lines ?? 0,
    imports: input.map.imports.get(key) ?? [],
    dependents,
    blast: blastWalk(input.map.dependents, key, input.depth ?? BLAST_DEPTH),
    touches,
    stale: (input.stale ?? []).filter((alert) => alert.path === key),
  }
}
