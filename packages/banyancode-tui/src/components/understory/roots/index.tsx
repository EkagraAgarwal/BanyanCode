import type { CodegraphGraph, CodegraphLive } from "../../../data/live"
import { createEffect, createMemo, createSignal, on, onMount, untrack } from "solid-js"
import {
  fileTouches,
  layoutFlat,
  layoutMap,
  mapRect,
  normalizeRepoPath,
  repoMapFromGraph,
  resolveFile,
  stalePaths,
  touchIndex,
} from "../../../data/understory-map"
import { sessionTouches, staleEditsFrom } from "../../../data/understory-spans"
import { CellGrid, type Grid } from "../cells"
import { readTick, type LensProps } from "../view"
import { drawRoots, type RootsFrame } from "./draw"

/**
 * Roots (brief section 6): the repo as a treemap, with a braille root from each
 * roster row to the file that branch is touching. The lens owns no timers: the
 * playhead, the shared tick and `animations` decide every frame, so an idle run
 * draws the same cells twice and the CellGrid commits nothing.
 *
 * The graph is fetched once, when the lens is first opened, through the shared
 * `CodegraphLive` cache (bounded node/edge limits, invalidated by build events),
 * so a frame never touches the RPC.
 */
export interface RootsLensProps extends LensProps {
  readonly codegraph?: CodegraphLive | undefined
  /** Raw graph, for a test or a caller that already has one. */
  readonly graph?: CodegraphGraph | undefined
  /** Zoomed package; `undefined` is the whole repo. */
  readonly mapRoot?: string | undefined
  readonly onMapRoot?: ((root: string | undefined) => void) | undefined
  /** Repo root, so an absolute tool path lands on its graph key. */
  readonly root?: string | undefined
  /** Wheel over the map scrolls the roster and its lanes together. */
  readonly onScroll?: ((delta: number) => void) | undefined
}

const normalize = (path: string, root: string | undefined): string => normalizeRepoPath(path, root)

/** Heat and ripple read a quarter-second clock; the drawing need not be finer. */
const ROOTS_CLOCK_MS = 250

export function RootsLens(props: RootsLensProps) {
  onMount(() => {
    void props.codegraph?.ensureGraph()
    void props.codegraph?.ensureFiles()
  })

  const [hover, setHover] = createSignal<string>()
  const [blastStart, setBlastStart] = createSignal<number>()

  // A zoom restarts the ripple, and so does picking another file.
  createEffect(
    on(
      () => [props.view.blast(), props.view.file()] as const,
      ([enabled]) => setBlastStart(enabled ? untrack(() => readTick(props.tick)) : undefined),
    ),
  )

  const model = createMemo(() => {
    const graph = props.graph ?? props.codegraph?.graph()
    if (graph === undefined) return undefined
    return repoMapFromGraph({
      nodes: graph.nodes,
      edges: graph.edges,
      files: props.codegraph?.files(),
      ...(props.root === undefined ? {} : { root: props.root }),
    })
  })

  const canonical = createMemo(() => {
    const map = model()
    return (path: string): string => {
      if (map === undefined) return normalize(path, props.root)
      return resolveFile(map, path, props.root)?.path ?? normalize(path, props.root)
    }
  })

  const touches = createMemo(() => fileTouches(props.spans, props.root, canonical()))
  const touchesByPath = createMemo(() => touchIndex(touches()))

  /** Every alert the run raised; the playhead decides which are open. */
  const alerts = createMemo(() =>
    staleEditsFrom(
      props.rows.map(
        (row) =>
          props.session?.(row.sessionID)?.touches ??
          sessionTouches({ sessionID: row.sessionID, label: row.label, messages: props.messages(row.sessionID) }),
      ),
      new Map(props.rows.map((row) => [row.sessionID, row.label])),
    ),
  )

  const layout = createMemo(() => {
    const rect = mapRect(Math.max(1, props.width), Math.max(1, props.height)).rect
    const map = model()
    if (map !== undefined && map.files.length > 0) return layoutMap(map, rect, props.mapRoot)
    const touched = [...new Set(touches().map((touch) => touch.path))]
    return layoutFlat(
      touched.map((path) => ({ path })),
      rect,
      props.root,
    )
  })

  const file = () => {
    const value = props.view.file()
    return value === undefined ? undefined : canonical()(value)
  }

  const draw = (grid: Grid) => {
    // Heat, ripple and the stale window read a coarse clock: they are a slow
    // signal, so a frame never splits a second into twelve different tints.
    const raw = props.view.viewT()
    const t = Math.floor(raw / ROOTS_CLOCK_MS) * ROOTS_CLOCK_MS
    const open = alerts().filter((alert) => alert.editedAt <= t)
    const started = blastStart()
    const ripple = started !== undefined && props.animations
    // The tick is seconds; the frame works in milliseconds, like the spans. It
    // is read only while the blast ripple is actually running.
    const elapsed = ripple
      ? readTick(props.tick) > started
        ? (readTick(props.tick) - started) * 1_000
        : Number.POSITIVE_INFINITY
      : Number.POSITIVE_INFINITY
    const frame: RootsFrame = {
      rows: props.visible ?? props.rows,
      laneTop: Math.max(0, props.geometry.header - 1),
      laneHeight: props.geometry.laneHeight,
      laneOffset: Math.max(0, props.offset ?? 0),
      selected: props.selected,
      hues: props.hues,
      spans: props.spans,
      touches: touches(),
      touchesByPath: touchesByPath(),
      stale: stalePaths(open),
      selectedFile: file(),
      blast: props.view.blast(),
      blastElapsed: elapsed,
      t,
      tick: ripple ? readTick(props.tick) : 0,
      animations: props.animations,
      model: model(),
      layout: layout(),
      hover: hover(),
      mapRoot: props.mapRoot,
      canonical: canonical(),
    }
    drawRoots(grid, frame, props.theme)
  }

  return (
    <CellGrid
      id="banyancode.understory.roots"
      width={Math.max(1, props.width)}
      height={Math.max(1, props.height)}
      background={props.theme.background}
      draw={draw}
      onHit={(region) => {
        if (region.startsWith("pkg:")) {
          const name = region.slice("pkg:".length)
          props.onMapRoot?.(props.mapRoot === undefined ? name : undefined)
          props.on.selectFile(undefined)
          props.view.setBlast(false)
          return
        }
        if (region.startsWith("tile:")) props.on.selectFile(region.slice("tile:".length))
      }}
      onMouseMove={(region) => {
        const next = region?.startsWith("tile:") ? region.slice("tile:".length) : undefined
        if (next !== hover()) setHover(next)
      }}
      onScroll={(direction, delta) => {
        if (props.onScroll === undefined) return
        if (direction === "left" || direction === "right") return
        const steps = Math.max(1, delta)
        props.onScroll(direction === "down" ? steps : -steps)
      }}
    />
  )
}
