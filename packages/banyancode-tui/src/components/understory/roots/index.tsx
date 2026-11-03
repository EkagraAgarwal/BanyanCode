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
import { staleEdits } from "../../../data/understory-spans"
import { CellGrid, type Grid } from "../cells"
import type { LensProps } from "../view"
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
}

const normalize = (path: string, root: string | undefined): string => normalizeRepoPath(path, root)

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
      ([enabled]) => setBlastStart(enabled ? untrack(() => props.tick) : undefined),
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

  const sessions = createMemo(() =>
    props.rows.map((row) => ({ sessionID: row.sessionID, label: row.label, messages: props.messages(row.sessionID) })),
  )
  /** Every alert the run raised; the playhead decides which are open. */
  const alerts = createMemo(() => staleEdits(sessions()))

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
    const t = props.view.viewT()
    const open = alerts().filter((alert) => alert.editedAt <= t)
    const started = blastStart()
    // The tick is seconds; the frame works in milliseconds, like the spans.
    const elapsed =
      started === undefined
        ? 0
        : props.animations
          ? props.tick > started
            ? (props.tick - started) * 1_000
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
      tick: props.tick,
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
    />
  )
}
