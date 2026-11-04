import { RGBA } from "@opentui/core"
import { truncate } from "../../../data/format"
import type { RosterRow } from "../../../data/understory"
import { stateAt, type AgentSpan } from "../../../data/understory-spans"
import {
  blastWalk,
  heatAt,
  mapRect,
  recentTouches,
  type FileTouch,
  type MapLayout,
  type RepoMap,
} from "../../../data/understory-map"
import { ease, mix } from "../../../motion"
import type { Palette } from "../../../theme"
import type { Grid } from "../cells"
import { BrailleLayer, drawCurve } from "./braille"

/** Everything the Roots frame draws. A pure function of this plus the grid. */
export interface RootsFrame {
  /** Rows in the order the roster draws them (folded rows are already gone). */
  readonly rows: readonly RosterRow[]
  /** Grid row of the first lane. */
  readonly laneTop: number
  readonly laneHeight: number
  /** Index of the first drawn lane, from the roster's scroll window. */
  readonly laneOffset: number
  readonly selected: string | undefined
  readonly hues: ReadonlyMap<string, RGBA>
  readonly spans: ReadonlyMap<string, readonly AgentSpan[]>
  readonly touches: readonly FileTouch[]
  readonly touchesByPath: ReadonlyMap<string, readonly FileTouch[]>
  /** Files with an open stale-read alert at this playhead. */
  readonly stale: ReadonlySet<string>
  readonly selectedFile: string | undefined
  readonly blast: boolean
  /**
   * Milliseconds since `b`, for the hop ripple. `Infinity` draws the final
   * state (animations off, or a clock that is not running).
   */
  readonly blastElapsed: number
  readonly t: number
  readonly tick: number
  readonly animations: boolean
  readonly model: RepoMap | undefined
  readonly layout: MapLayout
  readonly hover: string | undefined
  readonly mapRoot: string | undefined
  /** Canonical map key for a path a tool call reported. */
  readonly canonical: (path: string) => string
}

/** The mockup's tile shades, by directory position (lines 1191-1193). */
const SHADES = [0.1, 0.55, 0.95] as const
/** An edit pulses its direct dependents for this long (brief section 12: 1.4 s). */
const RIPPLE_MS = 1_400
/** A root grows over 450 ms. */
const GROW_MS = 450
/** A blast hop ripples every 180 ms (brief section 12). */
const BLAST_HOP_MS = 180
const BLAST_GROW_MS = 350
/** The comet travels the root in 1.2 s. */
const COMET_MS = 1_200
const BLAST_DEPTH = 3
const READ_LABEL = 0.28
const EDIT_LABEL = 0.2

const DARK_INK = RGBA.fromInts(10, 14, 11)
const LIGHT_INK = RGBA.fromInts(246, 250, 242)

const linear = (value: number): number =>
  value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4

const luminance = (color: RGBA): number =>
  0.2126 * linear(color.r) + 0.7152 * linear(color.g) + 0.0722 * linear(color.b)

/** Text on a heat tint: the mockup flips to dark ink once the tile is bright. */
const ink = (background: RGBA): RGBA => (luminance(background) > 0.2 ? DARK_INK : LIGHT_INK)

const fit = (text: string, width: number): string => (width <= 0 ? "" : truncate(text, width))

const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value))

const clamp01 = (value: number): number => clamp(value, 0, 1)

/**
 * Draws one Roots frame. The map, the heat, the roots, the stale pulse, the
 * blast arcs and the legend all land on one cell grid; curves go through a
 * braille layer flushed only over blanks and block elements, so no label is
 * ever overdrawn.
 */
export function drawRoots(grid: Grid, frame: RootsFrame, theme: Palette): void {
  const width = grid.width
  const height = grid.height
  if (width < 6 || height < 2) return
  const { rect } = mapRect(width, height)
  const laneTop = frame.laneTop
  const laneHeight = Math.max(1, frame.laneHeight)

  // The legend owns the last row; the braille layer covers everything above it.
  const layer = new BrailleLayer(width, Math.max(0, height - 1))

  // A ripple from each edit inside the window reaches the file's direct dependents.
  const ripple = new Map<string, number>()
  if (frame.animations && frame.model !== undefined) {
    for (const touch of frame.touches) {
      if (touch.verb !== "edit" || touch.at > frame.t) continue
      const progress = (frame.t - touch.at) / RIPPLE_MS
      if (progress >= 1) continue
      for (const dependent of frame.model.dependents.get(touch.path) ?? []) {
        ripple.set(dependent, Math.max(ripple.get(dependent) ?? 0, Math.sin(Math.PI * clamp01(progress)) * 0.6))
      }
    }
  }

  const blast =
    frame.blast && frame.selectedFile !== undefined && frame.model !== undefined
      ? blastWalk(frame.model.dependents, frame.selectedFile, BLAST_DEPTH)
      : undefined

  // --- package headers -----------------------------------------------------
  for (const head of frame.layout.heads) {
    const { x, y, w } = head.rect
    grid.fill(x, y, w, 1, theme.background)
    const label = frame.mapRoot === undefined ? head.name : `‹ back`
    grid.text(x, y, fit(label, w - 1), theme.wood, theme.background, true)
    grid.hit(x, y, w, 1, `pkg:${head.name}`)
  }

  // --- tiles ---------------------------------------------------------------
  const breath = 0.5 + 0.5 * Math.sin(frame.tick * Math.PI * 2)
  for (const tile of frame.layout.tiles) {
    const { x, y, w, h } = tile.rect
    if (w < 1 || h < 1) continue
    const one = tile.files.length === 1
    const path = tile.files[0]!
    let heat = { read: 0, edit: 0 }
    for (const file of tile.files) {
      const own = heatAt(frame.touchesByPath.get(file) ?? [], frame.t)
      heat = { read: Math.max(heat.read, own.read), edit: Math.max(heat.edit, own.edit) }
    }
    let bg = mix(theme.background, theme.surface, 0.35 + SHADES[tile.shade % 3]! * 0.6)
    bg = mix(bg, theme.sky, heat.read * 0.62)
    bg = mix(bg, theme.leaf, heat.edit * 0.85)
    const pulse = ripple.get(path)
    if (pulse !== undefined) bg = mix(bg, theme.lime, pulse * 0.55)
    if (blast !== undefined && one) {
      const distance = blast.dist.get(path)
      if (distance !== undefined && frame.blastElapsed > distance * BLAST_HOP_MS) {
        bg = mix(bg, theme.warning, distance === 0 ? 0.9 : 0.72 / (distance + 0.2))
      }
    }
    const stale = one && frame.stale.has(path)
    if (stale) bg = mix(bg, theme.error, 0.6 + (frame.animations ? 0.3 * breath : 0))
    const isSelected = one && frame.selectedFile === path
    const isHover = one && frame.hover === path
    if (isSelected || isHover) bg = mix(bg, theme.text, 0.14)

    grid.fill(x, y, w, h, bg)
    // Separators cost no cells: a right one-eighth and a lower one-eighth hairline.
    const edge = mix(theme.border, theme.faint, 0.5)
    if (w >= 2) for (let row = y; row < y + h; row += 1) grid.setCell(x + w - 1, row, "▕", edge, bg)
    if (h >= 2) {
      for (let column = x; column < x + w; column += 1) {
        const corner = column === x + w - 1 && w >= 2
        grid.setCell(column, y + h - 1, corner ? "▕" : "▁", edge, bg)
      }
    }

    const hot = heat.read > READ_LABEL || heat.edit > EDIT_LABEL || stale || isSelected
    const color = hot ? ink(bg) : w >= 8 ? theme.muted : theme.faint
    if (w >= 3) {
      grid.text(x, y, fit(one ? tileLabel(frame.model, path) : `+${tile.files.length}`, w - 1), color, undefined, hot)
      if (one && h >= 3 && w >= 9) {
        const lines = frame.model?.byPath.get(path)?.lines ?? 0
        if (lines > 0) grid.text(x, y + 1, fit(String(lines), w - 1), hot ? color : theme.faint)
      }
    }
    if (one) grid.hit(x, y, w, h, `tile:${path}`)
  }

  if (frame.layout.tiles.length === 0) grid.text(rect.x, rect.y, fit("no files in the graph", rect.w), theme.faint)

  // --- roots ---------------------------------------------------------------
  const focused = frame.rows.find((row) => row.sessionID === frame.selected)
  frame.rows.forEach((row, index) => {
    if (row.depth === 0) return
    const lane = laneTop + (index - frame.laneOffset) * laneHeight
    if (lane < 0 || lane >= height - 1) return
    const spans = frame.spans.get(row.sessionID) ?? []
    const state = stateAt(row, spans, frame.t)
    const focus = row.sessionID === frame.selected
    const hue = frame.hues.get(row.sessionID) ?? theme.leaf
    const startY = lane * 4 + 2
    if (state === "running" || state === "waiting" || state === "retry") grid.setCell(0, lane, "╶", hue)
    const tools = spans.filter((span) => span.file !== undefined && span.t0 <= frame.t)
    const seen = new Set<string>()
    for (let slot = tools.length - 1; slot >= 0 && seen.size < 3; slot -= 1) {
      const span = tools[slot]!
      const path = frame.canonical(span.file!)
      if (seen.has(path)) continue
      seen.add(path)
      const tile = frame.layout.byFile.get(path)
      if (tile === undefined) continue
      const age = frame.t - (span.t1 ?? frame.t)
      const current = span.t1 === undefined || span.t1 > frame.t
      let alpha = current ? 1 : clamp(1 - age / 24_000, 0.3, 0.8)
      if (state === "done" || state === "failed" || state === "killed") {
        const since = row.endedAt === undefined ? 0 : frame.t - row.endedAt
        alpha *= clamp(1 - since / 10_000, 0, 0.55)
        if (alpha <= 0.02) continue
      }
      if (!focus && focused !== undefined && focused.depth > 0) alpha *= 0.62
      const targetX = tile.rect.x * 2 + 1
      const targetY = Math.round((tile.rect.y + Math.min(tile.rect.h, 2) / 2) * 4)
      const comets: number[] = []
      if (frame.animations) {
        for (const touch of recentTouches(frame.touchesByPath.get(path) ?? [], row.sessionID, frame.t)) {
          comets.push(touch.verb === "edit" ? (frame.t - touch.at) / COMET_MS : 1 - (frame.t - touch.at) / COMET_MS)
        }
      }
      drawCurve(layer, 0, startY, targetX, targetY, {
        color: span.kind === "ask" ? theme.warning : mix(theme.background, hue, clamp01(alpha + 0.08)),
        alpha,
        grow: frame.animations ? ease((frame.t - span.t0) / GROW_MS) : 1,
        comets,
        cometColor: theme.lime,
        bold: current || focus,
      })
      if (current && tile.rect.w >= 2) {
        grid.setCell(tile.rect.x + tile.rect.w - 2, tile.rect.y, "●", hue, undefined, true)
      }
    }
    const asking = spans.findLast((span) => span.t0 <= frame.t && (span.t1 === undefined || span.t1 > frame.t))
    if (asking?.kind === "ask" && asking.file !== undefined) {
      const tile = frame.layout.byFile.get(frame.canonical(asking.file))
      if (tile !== undefined) {
        drawCurve(layer, 0, startY, tile.rect.x * 2 + 1, Math.round((tile.rect.y + 0.5) * 4), {
          color: theme.warning,
          alpha: 1,
          dash: true,
        })
      }
    }
  })

  // --- blast arcs to the direct dependents ---------------------------------
  if (blast !== undefined && frame.selectedFile !== undefined && frame.blastElapsed > 100) {
    const source = frame.layout.byFile.get(frame.selectedFile)
    if (source !== undefined) {
      for (const dependent of frame.model?.dependents.get(frame.selectedFile) ?? []) {
        const tile = frame.layout.byFile.get(dependent)
        if (tile === undefined) continue
        drawCurve(
          layer,
          source.rect.x * 2 + source.rect.w,
          Math.round((source.rect.y + source.rect.h / 2) * 4),
          tile.rect.x * 2 + tile.rect.w,
          Math.round((tile.rect.y + tile.rect.h / 2) * 4),
          {
            color: mix(theme.warning, theme.background, 0.15),
            alpha: 0.9,
            grow:
              frame.blastElapsed === Number.POSITIVE_INFINITY
                ? 1
                : clamp01((frame.blastElapsed - 100) / BLAST_GROW_MS),
          },
        )
      }
    }
  }

  // --- flush: labels are never overdrawn -----------------------------------
  layer.flush(grid)

  // --- legend --------------------------------------------------------------
  drawLegend(grid, frame, theme)
}

function tileLabel(model: RepoMap | undefined, path: string): string {
  const known = model?.byPath.get(path)
  if (known !== undefined) return known.name
  // The gap-(d) fallback has no graph to ask, so strip the extension here.
  return path.slice(path.lastIndexOf("/") + 1).replace(/\.[^.]+$/, "")
}

function drawLegend(grid: Grid, frame: RootsFrame, theme: Palette): void {
  const y = grid.height - 1
  grid.fill(0, y, grid.width, 1, theme.background)
  const x = 1
  const hovered = frame.hover === undefined ? undefined : frame.layout.byFile.get(frame.hover)
  if (hovered !== undefined && hovered.files.length === 1 && frame.model !== undefined) {
    const path = hovered.files[0]!
    const file = frame.model.byPath.get(path)
    let at = grid.text(x, y, fit(path, Math.min(46, Math.max(0, grid.width - 30))), theme.muted)
    at = grid.text(at + 2, y, `${file?.lines ?? 0} lines`, theme.faint)
    at = grid.text(at + 2, y, `${(frame.model.dependents.get(path) ?? []).length} dependents`, theme.faint)
    const who = [
      ...new Set(
        (frame.touchesByPath.get(path) ?? [])
          .filter((touch) => touch.at <= frame.t)
          .map((touch) => frame.rows.find((row) => row.sessionID === touch.sessionID)?.label ?? touch.sessionID),
      ),
    ]
    if (who.length > 0 && at + who.join(", ").length + 2 < grid.width - 1) {
      grid.text(at + 2, y, who.join(", "), theme.leaf)
    }
    return
  }
  if (frame.blast && frame.selectedFile !== undefined && frame.model !== undefined) {
    const blast = blastWalk(frame.model.dependents, frame.selectedFile, BLAST_DEPTH)
    let at = grid.text(x, y, "BLAST RADIUS ", theme.warning, undefined, true)
    at = grid.text(
      at,
      y,
      fit(
        `${tileLabel(frame.model, frame.selectedFile)}: ${blast.direct} direct, ${blast.transitive} transitive · ${blast.score.toUpperCase()}`,
        grid.width - at - 1,
      ),
      theme.muted,
    )
    return
  }
  let at = x
  const swatch = (background: RGBA, label: string) => {
    grid.setCell(at, y, " ", theme.text, background)
    at = grid.text(at + 2, y, label, theme.faint) + 2
  }
  swatch(mix(theme.background, theme.sky, 0.62), "read")
  swatch(mix(theme.background, theme.leaf, 0.85), "edited")
  swatch(theme.error, "stale edit")
  if (frame.model === undefined) {
    if (at < grid.width) grid.text(at, y, fit("/codegraph-build", grid.width - at), theme.faint)
    return
  }
  if (grid.width >= 60) grid.right(grid.width - 1, y, "click a tile", theme.faint)
}
