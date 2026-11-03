import type { RGBA } from "@opentui/core"
import type { SessionMessageInfo } from "@opencode/client"
import { createSignal, type Accessor } from "solid-js"
import type { RosterRow } from "../../data/understory"
import type { AgentSpan } from "../../data/understory-spans"
import type { Palette } from "../../theme"
import { TRACE_SECONDS_PER_COLUMN, traceWindow, zoomScale, type RowGeometry, type TraceWindow } from "./layout"

/**
 * Shared state for the Agents tab. The lenses read it; the shell owns the keys
 * and writes it. Everything here is a signal or a pure function of signals, so
 * the same view state drives every lens and a replay scrubs them together.
 */

export type Lens = "trace" | "roots" | "stream"

export const LENSES: readonly Lens[] = ["trace", "roots", "stream"]

export function lensLabel(lens: Lens): string {
  if (lens === "trace") return "Trace"
  if (lens === "roots") return "Roots"
  return "Stream"
}

/** A tool span pinned in Trace; the inspector's Call sheet reads it. */
export interface PinnedCall {
  readonly sessionID: string
  readonly spanID: string
}

export interface LensCallbacks {
  readonly selectAgent: (sessionID: string) => void
  readonly pinCall: (call: PinnedCall | undefined) => void
  readonly selectFile: (path: string | undefined) => void
}

/** What every lens receives. The shell mounts one of them; they differ only in drawing. */
export interface LensProps {
  readonly rows: readonly RosterRow[]
  /** Rows after folding, the same list the roster draws; `rows` when omitted. */
  readonly visible?: readonly RosterRow[] | undefined
  /** First visible entry, so lanes scroll with the roster. */
  readonly offset?: number | undefined
  /** One line of the pending ask for a session, so every waiting lane carries it. */
  readonly ask?: ((sessionID: string) => string | undefined) | undefined
  /** Spans per session, oldest first, for the time T the lens draws. */
  readonly spans: ReadonlyMap<string, readonly AgentSpan[]>
  readonly messages: (sessionID: string) => readonly SessionMessageInfo[]
  readonly hues: ReadonlyMap<string, RGBA>
  readonly theme: Palette
  readonly view: UnderstoryView
  readonly selected: string | undefined
  readonly width: number
  readonly height: number
  /** Rows the lens has, including the overview and ruler it shares with the roster. */
  readonly geometry: RowGeometry
  readonly animations: boolean
  readonly tick: number
  readonly on: LensCallbacks
}

export interface WindowInput {
  readonly start: number
  readonly end?: number | undefined
  readonly columns: number
  /** The playhead the window must follow; defaults to the live clock. */
  readonly now?: number | undefined
}

export interface UnderstoryView {
  readonly lens: Accessor<Lens>
  readonly setLens: (lens: Lens) => void
  /** Playhead; `undefined` follows the live clock. */
  readonly t: Accessor<number | undefined>
  readonly setT: (t: number | undefined) => void
  readonly live: Accessor<boolean>
  /** The playhead a lens draws: the scrubbed time, else `now()`. */
  readonly viewT: Accessor<number>
  /** The visible time window for a run; fixed scale while live, fitted once ended. */
  readonly window: (input: WindowInput) => TraceWindow
  readonly scale: Accessor<number>
  readonly zoom: (direction: 1 | -1) => void
  readonly resetZoom: () => void
  readonly pinned: Accessor<PinnedCall | undefined>
  readonly pinCall: (call: PinnedCall | undefined) => void
  readonly file: Accessor<string | undefined>
  readonly selectFile: (path: string | undefined) => void
  readonly blast: Accessor<boolean>
  readonly setBlast: (on: boolean) => void
  /** Stream: one agent only. */
  readonly filter: Accessor<boolean>
  readonly setFilter: (on: boolean) => void
  /** Inspector overlay, used below the docked width. */
  readonly overlay: Accessor<boolean>
  readonly setOverlay: (on: boolean) => void
}

export function createUnderstoryView(input: { readonly now: () => number }): UnderstoryView {
  const [lens, setLens] = createSignal<Lens>("trace")
  const [t, setT] = createSignal<number | undefined>(undefined)
  const [scale, setScale] = createSignal(TRACE_SECONDS_PER_COLUMN)
  const [pinned, setPinned] = createSignal<PinnedCall | undefined>(undefined)
  const [file, setFile] = createSignal<string | undefined>(undefined)
  const [blast, setBlast] = createSignal(false)
  const [filter, setFilter] = createSignal(false)
  const [overlay, setOverlay] = createSignal(false)
  return {
    lens,
    setLens,
    t,
    setT,
    live: () => t() === undefined,
    viewT: () => t() ?? input.now(),
    // `traceWindow` pages in seconds, the unit its tests pin; the whole UI
    // speaks milliseconds, so the conversion lives at this one boundary.
    window: (range) => {
      const win = traceWindow({
        start: range.start / 1000,
        ...(range.end === undefined ? {} : { end: range.end / 1000 }),
        now: (range.now ?? t() ?? input.now()) / 1000,
        columns: range.columns,
        scale: scale(),
      })
      return { a: win.a * 1000, b: win.b * 1000, scale: win.scale }
    },
    scale,
    zoom: (direction) => setScale(zoomScale(scale(), direction)),
    resetZoom: () => setScale(TRACE_SECONDS_PER_COLUMN),
    pinned,
    pinCall: setPinned,
    file,
    selectFile: setFile,
    blast,
    setBlast,
    filter,
    setFilter,
    overlay,
    setOverlay,
  }
}
