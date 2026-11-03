import type { RGBA } from "@opentui/core"
import type { SessionMessageInfo } from "@opencode/client"
import { createSignal, type Accessor } from "solid-js"
import type { RosterRow } from "../../data/understory"
import type { AgentSpan } from "../../data/understory-spans"
import type { Palette } from "../../theme"
import { TRACE_SECONDS_PER_COLUMN, traceWindow, type RowGeometry, type TraceWindow } from "./layout"

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

/**
 * The lens a real digit press selects. A keymap match is not proof of a press:
 * `@opentui/keymap` adds the physical key's base-layout character as an extra
 * match (so a digit-row key can match a bare digit), and the host's ctrl+] tab
 * switch carries that base key. Only the event's own name is proof, so the
 * lens commands pass their `KeyEvent` here and a fallback match is ignored.
 */
export function lensForKey(name: string | undefined): Lens | undefined {
  if (name === "1") return "trace"
  if (name === "2") return "roots"
  if (name === "3") return "stream"
  return undefined
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
  /** The visible time window, in milliseconds, for the run and its columns. */
  readonly window: (input: WindowInput) => TraceWindow
  /** An explicit window, dragged or zoomed; `undefined` uses the fitted one. */
  readonly win: Accessor<TraceWindow | undefined>
  readonly setWin: (window: TraceWindow | undefined) => void
  /** Seconds per column for the window on screen. */
  readonly scale: Accessor<number>
  /** Zoom 30% in or out around the playhead. */
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

/** The playhead is a scrub, so every action that would write to the run is off. */
export const REPLAY_OFF = "return to live (l) first"

/**
 * The lens' replay state, for a surface that has no view of its own: the
 * composer's send guard reads it, so a send while scrubbed is refused with the
 * same words the panel uses.
 */
const [replaying, setReplaying] = createSignal(false)
export const understoryLive = (): boolean => !replaying()

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value))
/** Where the playhead sits in a scrubbed window: the mockup's 60%. */
const PLAYHEAD_LEAD = 0.6
/** A zoom keeps at least five seconds and grows to the run plus fifteen. */
const ZOOM_MIN_MS = 5_000
const ZOOM_SLACK_MS = 15_000
/** The window a zoom starts from before the lens has asked for one: 42 s. */
const DEFAULT_SPAN_MS = 42_000
const ZOOM_STEP_IN = 0.7
const ZOOM_STEP_OUT = 1.4

export function createUnderstoryView(input: { readonly now: () => number }): UnderstoryView {
  const [lens, setLens] = createSignal<Lens>("trace")
  const [t, setT] = createSignal<number | undefined>(undefined)
  const [scaleValue, setScaleValue] = createSignal(TRACE_SECONDS_PER_COLUMN)
  const [win, setWin] = createSignal<TraceWindow | undefined>(undefined)
  const [pinned, setPinned] = createSignal<PinnedCall | undefined>(undefined)
  const [file, setFile] = createSignal<string | undefined>(undefined)
  const [blast, setBlast] = createSignal(false)
  const [filter, setFilter] = createSignal(false)
  const [overlay, setOverlay] = createSignal(false)

  // The last window and column count the lens asked for, so `+`/`-` can zoom
  // around the playhead before the lens has been drawn again.
  let latest: TraceWindow | undefined
  let latestColumns = 1

  const live = () => t() === undefined
  const viewT = () => t() ?? input.now()
  const windowSpan = () => latestColumns * scaleValue() * 1000

  const fit = (start: number, end: number, columns: number): TraceWindow => {
    const span = Math.max(1, end - start)
    return { a: start, b: start + span, scale: span / 1000 / Math.max(1, columns) }
  }

  /** A window around the playhead at the current scale, kept inside the run. */
  const around = (start: number, ceiling: number, columns: number): TraceWindow => {
    const span = windowSpan()
    const a = clamp(viewT() - span * PLAYHEAD_LEAD, start, Math.max(start, ceiling - span))
    return { a, b: a + span, scale: scaleValue() }
  }

  const computed = (range: WindowInput): TraceWindow => {
    const columns = Math.max(1, Math.floor(range.columns))
    latestColumns = columns
    const start = range.start
    const nowMs = range.now ?? viewT()
    if (range.end !== undefined) {
      const whole = fit(start, range.end, columns)
      // An ended run fits whole, until the user zooms: then it is a window
      // around the playhead at the zoomed scale.
      return scaleValue() === TRACE_SECONDS_PER_COLUMN ? whole : around(start, Math.max(range.end, start + 1), columns)
    }
    if (!live()) return around(start, Math.max(nowMs, start + windowSpan()), columns)
    // Live: a fixed scale that pages forward in 30% steps, in seconds, which is
    // the unit `traceWindow` and its tests speak.
    const paged = traceWindow({
      start: start / 1000,
      now: nowMs / 1000,
      columns,
      scale: scaleValue(),
    })
    return { a: paged.a * 1000, b: paged.b * 1000, scale: paged.scale }
  }

  return {
    lens,
    setLens,
    t,
    setT: (value) => {
      setT(value)
      setReplaying(value !== undefined)
    },
    live,
    viewT,
    window: (range) => {
      const fixed = win()
      if (fixed !== undefined) {
        latest = fixed
        latestColumns = Math.max(1, Math.floor(range.columns))
        return fixed
      }
      const next = computed(range)
      latest = next
      return next
    },
    win,
    setWin,
    scale: () => win()?.scale ?? scaleValue(),
    zoom: (direction) => {
      const base =
        win() ??
        latest ?? {
          a: 0,
          b: DEFAULT_SPAN_MS,
          scale: TRACE_SECONDS_PER_COLUMN,
        }
      const ceiling = Math.max(30_000, base.b + ZOOM_SLACK_MS)
      const span = clamp(
        (base.b - base.a) * (direction === 1 ? ZOOM_STEP_IN : ZOOM_STEP_OUT),
        ZOOM_MIN_MS,
        ceiling,
      )
      const columns = Math.max(1, Math.round((base.b - base.a) / 1000 / Math.max(0.001, base.scale)))
      const a = clamp(viewT() - span * PLAYHEAD_LEAD, 0, Math.max(0, ceiling - span))
      setScaleValue(span / 1000 / columns)
      setWin({ a, b: a + span, scale: span / 1000 / columns })
    },
    resetZoom: () => {
      setWin(undefined)
      setScaleValue(TRACE_SECONDS_PER_COLUMN)
    },
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
