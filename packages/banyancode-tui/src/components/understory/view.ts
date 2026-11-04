import type { RGBA } from "@opentui/core"
import type { SessionMessageInfo } from "@opencode/client"
import { createSignal, type Accessor } from "solid-js"
import type { RosterRow } from "../../data/understory"
import type { AgentSpan, SessionData } from "../../data/understory-spans"
import type { Palette } from "../../theme"
import {
  followWindow,
  scrollWindow,
  TRACE_SECONDS_PER_COLUMN,
  type RowGeometry,
  type TraceWindow,
} from "./layout"

/**
 * Shared state for the Agents tab. The lenses read it; the shell owns the keys
 * and writes it. Everything here is a signal or a pure function of signals, so
 * the same view state drives every lens and a replay scrubs them together.
 */

export type Lens = "trace" | "roots" | "stream"

export const LENSES: readonly Lens[] = ["trace", "roots", "stream"]

/**
 * The lenses are mouse targets now, so no key maps to one: `lensLabel` names
 * them for the tab strip, and nothing else decides which one is showing.
 */
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
  /** The memoised per-session derivation, so a lens can reuse its buckets. */
  readonly session?: ((sessionID: string) => SessionData) | undefined
  readonly hues: ReadonlyMap<string, RGBA>
  readonly theme: Palette
  readonly view: UnderstoryView
  readonly selected: string | undefined
  readonly width: number
  readonly height: number
  /** Rows the lens has, including the overview and ruler it shares with the roster. */
  readonly geometry: RowGeometry
  readonly animations: boolean
  /**
   * The animation clock: an accessor so a lens that draws no animated cell never
   * reads it, and a tick cannot redraw a still frame. A plain number is accepted
   * for a test or a one-shot render.
   */
  readonly tick: TickInput
  readonly on: LensCallbacks
}

/** The animation clock as a value, for a draw function. */
export type TickInput = Accessor<number> | number

export function readTick(tick: TickInput): number {
  return typeof tick === "function" ? tick() : tick
}

export interface WindowInput {
  readonly start: number
  readonly end?: number | undefined
  readonly columns: number
  /** The playhead the window must follow; defaults to the live clock. */
  readonly now?: number | undefined
  /** Newest event any loaded lane has; a live window follows this, not `now`. */
  readonly newest?: number | undefined
}

export interface ScrollTimeInput {
  readonly start: number
  readonly newest: number
  readonly end?: number | undefined
  /** Fraction of the visible width to move; negative goes back in time. */
  readonly fraction: number
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
  /** True while the live window follows the newest event. */
  readonly following: Accessor<boolean>
  readonly setFollowing: (following: boolean) => void
  /** Resume following the newest event, keeping the current zoom. */
  readonly latest: () => void
  /** Scroll the time axis by a fraction of the visible width; clamps to the run. */
  readonly scrollTime: (input: ScrollTimeInput) => void
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
export const REPLAY_OFF = "back to live first"

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

/**
 * The chosen lens outlives the panel: ctrl+] unmounts the Agents tab, and
 * coming back must not silently change the lens the user was reading. The
 * store is keyed by the host context, so one session keeps its lens and a
 * fresh context (another session, or a test) starts on Trace.
 */
export interface LensStore {
  readonly get: Accessor<Lens>
  readonly set: (lens: Lens) => void
}

const lensStores = new WeakMap<object, LensStore>()

export function lensStore(key: object): LensStore {
  const found = lensStores.get(key)
  if (found !== undefined) return found
  const [get, set] = createSignal<Lens>("trace")
  const store: LensStore = { get, set }
  lensStores.set(key, store)
  return store
}

export function createUnderstoryView(input: { readonly now: () => number; readonly lens?: LensStore | undefined }): UnderstoryView {
  const local = createSignal<Lens>("trace")
  const lens = input.lens?.get ?? local[0]
  const setLens = input.lens?.set ?? local[1]
  const [t, setT] = createSignal<number | undefined>(undefined)
  const [scaleValue, setScaleValue] = createSignal(TRACE_SECONDS_PER_COLUMN)
  const [win, setWin] = createSignal<TraceWindow | undefined>(undefined)
  const [pinned, setPinned] = createSignal<PinnedCall | undefined>(undefined)
  const [file, setFile] = createSignal<string | undefined>(undefined)
  const [blast, setBlast] = createSignal(false)
  const [filter, setFilter] = createSignal(false)
  const [overlay, setOverlay] = createSignal(false)

  const [following, setFollow] = createSignal(true)

  // The last window and column count the lens asked for, so `+`/`-` can zoom
  // around the playhead before the lens has been drawn again.
  let latestWindow: TraceWindow | undefined
  let latestColumns = 1

  const live = () => t() === undefined
  const viewT = () => t() ?? input.now()
  const windowSpan = () => latestColumns * scaleValue() * 1000

  const fit = (start: number, end: number, columns: number): TraceWindow => {
    const span = Math.max(1, end - start)
    return { a: start, b: start + span, scale: span / 1000 / Math.max(1, columns) }
  }

  /** The window a first call can assume before the lens has drawn one. */
  const initial = (start: number): TraceWindow => ({ a: start, b: start + windowSpan(), scale: scaleValue() })

  const computed = (range: WindowInput, fixed: TraceWindow | undefined): TraceWindow => {
    const columns = Math.max(1, Math.floor(range.columns))
    latestColumns = columns
    const start = range.start
    const newest = Math.max(start, range.newest ?? start)
    const nowMs = range.now ?? viewT()
    const whole = range.end === undefined ? undefined : fit(start, Math.max(range.end, start + 1), columns)

    if (!live()) {
      // Replay moves only the playhead. The window holds still until the
      // playhead leaves it, then slides just far enough to bring it back.
      const base = fixed ?? latestWindow ?? initial(start)
      if (nowMs >= base.a && nowMs <= base.b) return base
      const span = Math.max(1, base.b - base.a)
      const ceiling = Math.max(start + 1, range.end ?? newest + span / 4)
      const a = clamp(nowMs < base.a ? nowMs : nowMs - span, start, Math.max(start, ceiling - span))
      return { a, b: a + span, scale: base.scale }
    }

    // An ended, unzoomed run fits whole; a zoom pins an explicit window.
    if (whole !== undefined && fixed === undefined && scaleValue() === TRACE_SECONDS_PER_COLUMN) return whole
    if (fixed !== undefined) return fixed
    if (!following()) return latestWindow ?? followWindow({ start, newest, columns, scale: scaleValue() })
    return followWindow({
      start,
      newest,
      columns,
      scale: scaleValue(),
      ...(latestWindow === undefined ? {} : { anchor: latestWindow.a }),
    })
  }

  return {
    lens,
    setLens,
    t,
    setT: (value) => {
      setT(value)
      setReplaying(value !== undefined)
      // Returning to live also returns the window to the newest event.
      if (value === undefined) {
        setFollow(true)
        setWin(undefined)
      }
    },
    live,
    viewT,
    window: (range) => {
      const next = computed(range, win())
      latestWindow = next
      latestColumns = Math.max(1, Math.floor(range.columns))
      return next
    },
    win,
    setWin,
    following,
    setFollowing: (value) => {
      setFollow(value)
      if (!value && win() === undefined && latestWindow !== undefined) setWin(latestWindow)
    },
    latest: () => {
      setFollow(true)
      setWin(undefined)
    },
    scrollTime: (input) => {
      const base = win() ?? latestWindow ?? initial(input.start)
      const next = scrollWindow({ window: base, start: input.start, newest: input.newest, fraction: input.fraction })
      setWin(next.window)
      setFollow(next.following)
      latestWindow = next.window
      latestColumns = Math.max(1, Math.round((next.window.b - next.window.a) / 1000 / Math.max(0.001, next.window.scale)))
    },
    scale: () => win()?.scale ?? scaleValue(),
    zoom: (direction) => {
      const base =
        win() ??
        latestWindow ?? {
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
      setFollow(false)
    },
    resetZoom: () => {
      setWin(undefined)
      setScaleValue(TRACE_SECONDS_PER_COLUMN)
      setFollow(true)
      latestWindow = undefined
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
