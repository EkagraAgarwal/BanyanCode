import type { Context } from "@opencode/plugin/tui/context"
import type { SessionMessageInfo } from "@opencode/client"
import type { RGBA, ScrollBoxRenderable } from "@opentui/core"
import type { KeyEvent } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show, untrack } from "solid-js"
import type { CodegraphLive, MeshLive } from "../../data/live"
import { truncate } from "../../data/format"
import { canSteer, pendingCount } from "../../data/mesh"
import {
  agentSheet,
  isLiveState,
  nextAttention,
  rosterRows,
  runSheet,
  visibleRows,
  type AgentSheet,
  type RosterRow,
  type RunSheet,
} from "../../data/understory"
import {
  agentSpans,
  messagesAt,
  rowAt,
  sparkValues,
  staleEdits,
  tokenRate,
  type AgentSpan,
  type StaleEdit,
} from "../../data/understory-spans"
import { createTicker, ease, spring, useTickerWhen, type Ticker } from "../../motion"
import { palette } from "../../theme"
import { steerSubagent, type AgentTarget } from "../dialogs/actions"
import { PANEL_KEY_MODE, usePanelFocus, usePanelScroll } from "../panels/keys"
import { buildGraphData, fileName, type GraphData } from "./graph-data"
import {
  composerPlaceholder,
  registerComposerRouting,
} from "./composer-route"
import { branchHue } from "./hue"
import { Inspector, type FileTouch, type InspectorAsk } from "./inspector"
import { LensTabs } from "./lens-tabs"
import {
  fitHints,
  INSPECTOR_WIDTH,
  rosterAreaRows,
  rosterRowHeight,
  rosterWindow,
  runClock,
  runStateColor,
  runStateLabel,
  rowGeometry,
  spans,
  understoryColumns,
} from "./layout"
import { LineView, type Line } from "./line"
import { Roster, rowColor, rowGlyph } from "./roster"
import { StreamLens } from "./stream"
import { TraceLens } from "./trace"
import { RootsLens } from "./roots"
import { createUnderstoryView, lensForKey, REPLAY_OFF, type Lens, type LensProps } from "./view"

const KEY_ROWS: ReadonlyArray<readonly [string, string]> = [
  ["1 2 3", "Trace, Roots, Stream"],
  ["j k  ↑ ↓", "move selection"],
  ["← →", "scrub 2 seconds"],
  ["+ - 0", "zoom the time axis"],
  ["w", "next agent needing attention"],
  ["z", "fold finished agents"],
  ["f", "stream: selected agent only"],
  ["i", "inspector overlay"],
  ["s", "steer the selected agent"],
  ["x", "kill (press twice)"],
  ["Enter", "open the agent session"],
  ["a A d", "allow once, always, deny"],
  ["Tab @", "focus the composer"],
  ["Esc", "back out one level"],
  ["?", "close this list"],
]

/**
 * D · Understory: the shell. It owns the roster, the keys, the layout and the
 * shared view state; the active lens is one seam below the lens tabs. The
 * lenses read real span data and draw themselves.
 */
export function Understory(props: {
  readonly context: Context
  readonly sessionID: string
  readonly mesh: MeshLive
  /** The code graph Roots draws; omitted means the gap-(d) flat map. */
  readonly codegraph?: CodegraphLive | undefined
  readonly ticker?: Ticker | undefined
  readonly width?: number | undefined
  readonly now?: (() => number) | undefined
  readonly timers?: { readonly setTimeout: typeof setTimeout; readonly clearTimeout: typeof clearTimeout } | undefined
}) {
  const theme = () => palette(props.context.theme)
  const dimensions = useTerminalDimensions()
  const [area, setArea] = createSignal({ width: props.width ?? 0, height: 0 })
  const width = () => Math.max(1, area().width || props.width || dimensions().width)
  const height = () => Math.max(1, area().height || dimensions().height)

  const ownsTicker = props.ticker === undefined
  const ticker = props.ticker ?? createTicker({ animations: () => props.context.ui.animations() })
  if (ownsTicker) onCleanup(ticker.dispose)
  const animations = () => props.context.ui.animations()
  const now = () => props.now?.() ?? Date.now()
  const timers = props.timers ?? { setTimeout, clearTimeout }

  const root = createMemo(() => props.context.data.session.root(props.sessionID))
  onMount(() => {
    void props.mesh.ensure(root())
    void props.mesh.refreshLimits()
    // The File sheet reads the graph's files and edges; ask once, and leave the
    // lens offline when the host has no codegraph namespace.
    if (props.codegraph !== undefined) {
      void props.codegraph.ensureFiles()
      void props.codegraph.ensureGraph()
    }
  })

  const messagesOf = (sessionID: string): readonly SessionMessageInfo[] =>
    props.context.data.session.message.list(sessionID)

  const rows = createMemo(() =>
    rosterRows({
      root: root(),
      sessions: props.context.data.session.list(),
      mesh: props.mesh.root(root()),
      killed: props.mesh.killed(),
      pending: (sessionID) => pendingCount(props.context, sessionID),
      status: (sessionID) => props.context.data.session.status(sessionID),
      messages: messagesOf,
    }),
  )

  // Every roster agent is synced once. Twenty agents cost twenty bounded
  // requests, never an unbounded stream.
  const synced = new Set<string>()
  createEffect(() => {
    for (const row of rows()) {
      if (synced.has(row.sessionID)) continue
      synced.add(row.sessionID)
      void props.context.data.session.message.sync(row.sessionID)
      void props.context.data.session.permission.sync(row.sessionID)
    }
  })

  const view = createUnderstoryView({ now })

  const [selection, setSelection] = createSignal<string>()
  const [folded, setFolded] = createSignal(false)
  const [keyList, setKeyList] = createSignal(false)
  const [keyOffset, setKeyOffset] = createSignal(0)
  const [message, setMessage] = createSignal<string>()
  const [armed, setArmed] = createSignal<{ readonly sessionID: string; readonly label: string }>()
  const [rosterOffset, setRosterOffset] = createSignal(0)
  const [following, setFollowing] = createSignal(true)
  const [streamTop, setStreamTop] = createSignal(0)
  /** Roots zoom: the package the map is showing, if any. */
  const [rootsRoot, setRootsRoot] = createSignal<string | undefined>(undefined)

  /**
   * The time every pane draws at: the scrubbed playhead, else the live clock.
   * Replay is the same history read at an earlier T, so each pane derives its
   * own rows from this one value instead of testing the clock itself.
   */
  const at = () => view.viewT()

  /** What a row is waiting for, as the lane and now column show it: `shell: npm pack --dry-run`. */
  const askOf = (sessionID: string): string | undefined => {
    const request = props.context.data.session.permission.list(sessionID)?.[0]
    if (request !== undefined) {
      const resource = request.resources[0]
      return resource === undefined || resource === "" ? request.action : `${request.action}: ${resource}`
    }
    return props.context.data.session.form.list(sessionID)?.[0]?.title
  }

  /** The permission's own target, which is what the status row names. */
  const pendingTarget = (sessionID: string): string | undefined => {
    const request = props.context.data.session.permission.list(sessionID)?.[0]
    if (request === undefined) return props.context.data.session.form.list(sessionID)?.[0]?.title
    const resource = request.resources[0]
    return resource === undefined || resource === "" ? request.action : resource
  }

  const spansBySession = createMemo((): ReadonlyMap<string, readonly AgentSpan[]> => {
    const map = new Map<string, readonly AgentSpan[]>()
    for (const row of rows()) {
      const ask = row.state === "waiting" ? askOf(row.sessionID) : undefined
      map.set(
        row.sessionID,
        agentSpans(messagesOf(row.sessionID), {
          state: row.state,
          start: row.startedAt,
          ...(ask === undefined ? {} : { ask }),
        }),
      )
    }
    return map
  })

  /**
   * The roster with every time-dependent field re-derived at `at`: state,
   * tokens and whether the row had ended. Everything downstream (roster,
   * lanes, map, inspector, status row) reads this list, so a scrub moves them
   * all together. Live rows are already "at now", so they pass through.
   */
  const displayRows = createMemo((): readonly RosterRow[] => {
    if (view.live()) return rows()
    const spans = spansBySession()
    const time = at()
    return rows().map((row) => rowAt(row, spans.get(row.sessionID) ?? [], messagesOf(row.sessionID), time))
  })

  /**
   * The horizon an "as of" filter uses: everything while live (the host's clock
   * is a display clock, not a filter), the playhead while replaying.
   */
  const horizon = () => (view.live() ? Number.POSITIVE_INFINITY : at())

  const foldState = createMemo(() => visibleRows(displayRows(), { folded: folded(), selected: selection() }))
  const visible = createMemo(() => foldState().rows)
  const selectedID = createMemo(() => foldState().selected ?? visible()[0]?.sessionID)
  const selected = createMemo(() => displayRows().find((row) => row.sessionID === selectedID()))
  /** The live row behind the selection, for the actions that only exist live. */
  const selectedLive = createMemo(() => rows().find((row) => row.sessionID === selectedID()))

  const focus = usePanelFocus()
  const editing = () => focus === undefined || focus.zone() === "content"

  const cols = createMemo(() => understoryColumns(width()))
  const overlayMode = () => !cols().docked
  const geometry = createMemo(() => rowGeometry(height(), visible().length))
  const lensHeight = () => Math.max(0, height() - 1 - geometry().tabs)

  const hues = createMemo(() => {
    const mode = props.context.themeMode
    return new Map(rows().map((row, index) => [row.sessionID, branchHue(index, mode)]))
  })
  const hueOf = (sessionID: string | undefined): ReturnType<typeof branchHue> =>
    (sessionID === undefined ? undefined : hues().get(sessionID)) ?? theme().leaf

  /** Tokens per second one session streamed up to the playhead; zero with no signal. */
  const rateOf = (sessionID: string): number => {
    tick()
    return tokenRate(messagesAt(messagesOf(sessionID), at()), { to: at() })
  }

  /** Sparkline steps for one roster row, oldest first, ending at the playhead. */
  const sparkFor = (row: RosterRow): readonly number[] => {
    tick()
    return sparkValues(messagesAt(messagesOf(row.sessionID), at()), { to: at(), columns: 14 })
  }

  /** The advisory stale-read check across every branch, as far as the playhead reached. */
  const stale = createMemo((): readonly StaleEdit[] =>
    staleEdits(
      rows().map((row) => ({ sessionID: row.sessionID, label: row.label, messages: messagesOf(row.sessionID) })),
      20,
      horizon(),
    ),
  )

  /** The code graph, when the host has loaded one; absent means "not built". */
  const graph = createMemo((): GraphData | undefined => {
    const codegraph = props.codegraph
    if (codegraph === undefined) return undefined
    const files = codegraph.files()
    const data = codegraph.graph()
    if (files === undefined || data === undefined) return undefined
    return buildGraphData({ files, nodes: data.nodes, edges: data.edges })
  })

  /** Every real touch of one file, from the tool calls that named it by the playhead. */
  const touches = (path: string): readonly FileTouch[] => {
    const wanted = fileName(path)
    const time = horizon()
    const found: FileTouch[] = []
    for (const row of rows()) {
      for (const span of spansBySession().get(row.sessionID) ?? []) {
        if (span.kind !== "tool" || span.file === undefined) continue
        if (span.t0 > time) continue
        if (span.file !== path && fileName(span.file) !== wanted) continue
        found.push({
          at: span.t0,
          label: row.label,
          sessionID: row.sessionID,
          verb: span.letter === "E" ? "w" : "r",
          summary: span.target === "" ? span.name : `${span.name} ${span.target}`,
          ...(span.added === undefined ? {} : { added: span.added }),
          ...(span.removed === undefined ? {} : { removed: span.removed }),
        })
      }
    }
    return found.sort((left, right) => left.at - right.at)
  }

  let messageTimer: ReturnType<typeof setTimeout> | undefined
  let killTimer: ReturnType<typeof setTimeout> | undefined
  let streamScroll: ScrollBoxRenderable | undefined

  const clearMessage = () => {
    if (messageTimer !== undefined) timers.clearTimeout(messageTimer)
    messageTimer = undefined
    setMessage(undefined)
  }
  const say = (text: string, ms = 4_000) => {
    clearMessage()
    setMessage(text)
    messageTimer = timers.setTimeout(() => setMessage(undefined), ms)
  }
  const disarm = () => {
    if (killTimer !== undefined) timers.clearTimeout(killTimer)
    killTimer = undefined
    setArmed(undefined)
  }
  onCleanup(() => {
    if (messageTimer !== undefined) timers.clearTimeout(messageTimer)
    if (killTimer !== undefined) timers.clearTimeout(killTimer)
  })

  const select = (sessionID: string | undefined) => {
    if (sessionID === undefined) return
    disarm()
    clearMessage()
    setSelection(sessionID)
    const list = foldState().rows
    const index = list.findIndex((row) => row.sessionID === sessionID)
    if (index >= 0) {
      const areaRows = rosterAreaRows(height())
      const per = rosterRowHeight(list.length, areaRows, geometry().laneHeight)
      const offset = rosterWindow({
        total: list.length,
        areaRows: areaRows - (folded() && foldState().hidden > 0 ? 1 : 0),
        rowHeight: per,
        offset: rosterOffset(),
        selected: index,
      })
      setRosterOffset(offset.offset)
    }
  }

  const move = (delta: number) => {
    const current = foldState()
    const list = current.rows
    if (list.length === 0) return
    const active = current.selected ?? selection()
    const index = list.findIndex((row) => row.sessionID === active)
    const next = Math.max(0, Math.min(list.length - 1, (index < 0 ? 0 : index) + delta))
    select(list[next]?.sessionID)
  }

  /** ← → move the playhead two seconds inside the loaded run, from wherever it is. */
  const scrub = (delta: number) => {
    const rootRow = rows().find((row) => row.depth === 0)
    if (rootRow === undefined) return
    const clock = now()
    const next = Math.max(rootRow.startedAt, Math.min(clock, view.viewT() + delta))
    view.setT(next >= clock - 150 ? undefined : next)
  }

  /**
   * `[` and `]` step the playhead event by event on the selected agent: the
   * previous or next span start. `]` past the last event returns to live.
   */
  const stepEvent = (delta: 1 | -1) => {
    const row = selected()
    if (row === undefined) return
    const times = (spansBySession().get(row.sessionID) ?? [])
      .map((span) => span.t0)
      .filter((time, index, list) => time <= now() && list.indexOf(time) === index)
      .sort((left, right) => left - right)
    const time = view.viewT()
    const next =
      delta < 0
        ? [...times].reverse().find((candidate) => candidate < time - 10)
        : times.find((candidate) => candidate > time + 10)
    if (next !== undefined) view.setT(next)
    else if (delta > 0) view.setT(undefined)
  }

  /** Nothing that writes to the run may fire while the playhead is scrubbed. */
  const needLive = (): boolean => {
    if (view.live()) return true
    say(REPLAY_OFF)
    return false
  }

  const jumpAttention = () => {
    const next = nextAttention(displayRows(), selectedID())
    if (next === undefined) {
      say("nothing needs you right now")
      return
    }
    select(next)
  }

  const toggleFold = () => {
    const next = !folded()
    setFolded(next)
    setKeyOffset(0)
    setRosterOffset(0)
    const result = visibleRows(displayRows(), { folded: next, selected: selection() })
    if (result.selected !== undefined) setSelection(result.selected)
  }

  const targetOf = (row: RosterRow): AgentTarget => ({
    sessionID: row.sessionID,
    agent: row.agent,
    title: row.title ?? undefined,
    state:
      row.state === "running" || row.state === "waiting" || row.state === "blocked" || row.state === "retry"
        ? "running"
        : row.state === "failed" || row.state === "killed"
          ? "interrupted"
          : "idle",
    killed: props.mesh.killed().has(row.sessionID),
  })

  const open = (row: RosterRow | undefined) => {
    if (row === undefined) return
    props.context.ui.router.navigate({ type: "session", sessionID: row.sessionID })
  }

  const steerable = (row: RosterRow): boolean =>
    canSteer(row.state === "blocked" ? "running" : row.state === "killed" ? "interrupted" : row.state, {
      killed: props.mesh.killed().has(row.sessionID),
    })

  const steer = () => {
    const row = selectedLive()
    if (row === undefined || row.depth === 0) return
    if (!needLive()) return
    if (!steerable(row)) {
      say(`${row.label} is already finished`)
      return
    }
    void steerSubagent(props.context, props.mesh, root(), targetOf(row))
  }

  const permissions = createMemo(() => {
    const row = selectedLive()
    return row === undefined ? [] : (props.context.data.session.permission.list(row.sessionID) ?? [])
  })
  const forms = createMemo(() => {
    const row = selectedLive()
    return row === undefined ? [] : (props.context.data.session.form.list(row.sessionID) ?? [])
  })
  /** A pending ask only exists live: a scrubbed run has nothing to answer. */
  const waiting = () => view.live() && selectedLive()?.state === "waiting"
  const ask = createMemo((): InspectorAsk | undefined => {
    if (!waiting()) return undefined
    const request = permissions()[0]
    if (request !== undefined) {
      return { kind: "permission", title: request.action, target: request.resources[0] ?? "" }
    }
    const form = forms()[0]
    return form === undefined ? undefined : { kind: "form", title: form.title, target: "" }
  })

  const answer = (decision: "once" | "always" | "reject") => {
    const row = selectedLive()
    if (!needLive()) return
    if (row === undefined) {
      say("press w to jump to the next waiting agent")
      return
    }
    if (!waiting()) {
      say("press w to jump to the next waiting agent")
      return
    }
    const request = permissions()[0]
    if (request === undefined) {
      if (forms().length > 0) say("questions need Enter; open the session to answer")
      else say("press w to jump to the next waiting agent")
      return
    }
    void props.context.client.permission.reply({ sessionID: row.sessionID, requestID: request.id, decision }).then(
      () => say(`replied to ${row.label}`),
      () => say(`could not reply to ${row.label}`),
    )
  }

  const kill = () => {
    const row = selectedLive()
    if (!needLive()) return
    if (row === undefined || row.depth === 0) {
      say("select a subagent first")
      return
    }
    if (props.mesh.killed().has(row.sessionID) || row.state === "killed") {
      say(`${row.label} is already finished`)
      return
    }
    if (armed()?.sessionID === row.sessionID) {
      disarm()
      clearMessage()
      void props.mesh
        .kill({ parentSessionID: root(), targetSessionID: row.sessionID, reason: "User requested kill" })
        .then(
          (result) => say(result.ok ? `kill sent to ${row.label}` : (result.message ?? `could not kill ${row.label}`)),
          () => say(`could not kill ${row.label}`),
        )
      return
    }
    disarm()
    setArmed({ sessionID: row.sessionID, label: row.label })
    say(`press x again to kill ${row.label}`, 3_000)
    killTimer = timers.setTimeout(() => {
      setArmed(undefined)
      killTimer = undefined
      setMessage((value) => (value === `press x again to kill ${row.label}` ? undefined : value))
    }, 3_000)
  }

  const focusComposer = (text?: string) => {
    // The host hook focuses the real prompt and can type the first key, so `@`
    // arrives already typed instead of being handled twice.
    if (props.context.ui.composer.focus(text)) return
    props.context.keymap.dispatch("pane.focus.left")
  }

  usePanelScroll(props.context, () => streamScroll, 6)

  /** Messages a sheet may read: only what had arrived by the playhead. */
  const sheetMessages = (sessionID: string): readonly SessionMessageInfo[] => messagesAt(messagesOf(sessionID), at())

  const run = createMemo((): RunSheet | undefined =>
    runSheet({
      rows: displayRows(),
      root: root(),
      selected: selectedID(),
      messages: sheetMessages,
    }),
  )
  const sheet = createMemo((): AgentSheet | undefined =>
    agentSheet({
      rows: displayRows(),
      root: root(),
      selected: selectedID(),
      messages: sheetMessages,
    }),
  )

  /** Wheel over the roster or a lens scrolls both together, one lane at a time. */
  const scrollRoster = (delta: number) => {
    const list = foldState().rows
    const areaRows = rosterAreaRows(height()) - (folded() && foldState().hidden > 0 ? 1 : 0)
    const lane = geometry().laneHeight
    const max = Math.max(0, list.length * lane - areaRows)
    setRosterOffset((value) => Math.max(0, Math.min(max, value + delta)))
  }

  const closeOneLevel = () => {
    if (keyList()) {
      setKeyList(false)
      setKeyOffset(0)
      return
    }
    // Roots: Esc backs out of a package zoom before it closes anything else.
    if (view.lens() === "roots" && rootsRoot() !== undefined) {
      setRootsRoot(undefined)
      return
    }
    if (overlayMode() && view.overlay()) {
      view.setOverlay(false)
      return
    }
    if (view.filter()) {
      view.setFilter(false)
      return
    }
    if (armed() !== undefined) {
      disarm()
      clearMessage()
    }
  }

  /**
   * Switch to `wanted` only when the key really is that digit. A programmatic
   * dispatch carries no event and is allowed; a keyboard match must name the
   * digit, so a base-layout fallback match never changes the lens.
   */
  const lensCommand = (wanted: Lens, event: KeyEvent | undefined): false | void => {
    if (event !== undefined && lensForKey(event.name) !== wanted) return false
    view.setLens(wanted)
  }

  props.context.keymap.layer(() => ({
    mode: PANEL_KEY_MODE,
    priority: 35,
    commands: [
      {
        // The lens keys are named so the handler sees the key it was dispatched
        // for. `@opentui/keymap` adds the physical key's base-layout character
        // as an extra match, so a bare `3` can appear for a key that is not a
        // digit (the host's ctrl+] tab switch carries its own base key); only
        // the event's name proves a real digit press.
        id: "understory.lens.trace",
        bind: "1",
        title: "Trace lens",
        group: "Understory",
        enabled: editing,
        run: (_input, event) => lensCommand("trace", event),
      },
      {
        id: "understory.lens.roots",
        bind: "2",
        title: "Roots lens",
        group: "Understory",
        enabled: editing,
        run: (_input, event) => lensCommand("roots", event),
      },
      {
        id: "understory.lens.stream",
        bind: "3",
        title: "Stream lens",
        group: "Understory",
        enabled: editing,
        run: (_input, event) => lensCommand("stream", event),
      },
      {
        bind: "=",
        title: "Zoom in",
        group: "Understory",
        enabled: editing,
        run: () => view.zoom(1),
      },
      {
        bind: "shift+=",
        title: "Zoom in",
        group: "Understory",
        enabled: editing,
        run: () => view.zoom(1),
      },
      {
        bind: "-",
        title: "Zoom out",
        group: "Understory",
        enabled: editing,
        run: () => view.zoom(-1),
      },
      {
        bind: "0",
        title: "Reset zoom",
        group: "Understory",
        enabled: editing,
        run: view.resetZoom,
      },
      {
        bind: "left",
        title: "Scrub back",
        group: "Understory",
        enabled: editing,
        run: () => scrub(-2_000),
      },
      {
        bind: "right",
        title: "Scrub forward",
        group: "Understory",
        enabled: editing,
        run: () => scrub(2_000),
      },
      {
        bind: "[",
        title: "Previous event",
        group: "Understory",
        enabled: editing,
        run: () => stepEvent(-1),
      },
      {
        bind: "]",
        title: "Next event",
        group: "Understory",
        enabled: editing,
        run: () => stepEvent(1),
      },
      { bind: "l", title: "Return to live", group: "Understory", enabled: editing, run: () => view.setT(undefined) },
      {
        // `End` returns to live while scrubbed, and keeps its panel-scroll
        // meaning otherwise (the shell's own lower-priority binding).
        bind: "end",
        title: "Return to live",
        group: "Understory",
        enabled: () => editing() && !view.live(),
        run: () => view.setT(undefined),
      },
      { bind: "j", title: "Next agent", group: "Understory", enabled: editing, run: () => move(1) },
      { bind: "k", title: "Previous agent", group: "Understory", enabled: editing, run: () => move(-1) },
      {
        bind: "down",
        title: "Next row",
        group: "Understory",
        enabled: () => editing() && !keyList(),
        run: () => move(1),
      },
      {
        bind: "up",
        title: "Previous row",
        group: "Understory",
        enabled: () => editing() && !keyList(),
        run: () => move(-1),
      },
      {
        bind: "down",
        title: "Scroll keys down",
        group: "Understory",
        enabled: () => editing() && keyList(),
        run: () => setKeyOffset((value) => value + 1),
      },
      {
        bind: "up",
        title: "Scroll keys up",
        group: "Understory",
        enabled: () => editing() && keyList(),
        run: () => setKeyOffset((value) => Math.max(0, value - 1)),
      },
      { bind: "w", title: "Next waiting agent", group: "Understory", enabled: editing, run: jumpAttention },
      { bind: "z", title: "Fold finished agents", group: "Understory", enabled: editing, run: toggleFold },
      {
        // Roots: blast radius for the selected tile (brief section 11, `b`).
        bind: "b",
        title: "Roots blast radius",
        group: "Understory",
        enabled: () => editing() && view.lens() === "roots" && view.file() !== undefined,
        run: () => view.setBlast(!view.blast()),
      },
      {
        bind: "f",
        title: "Filter the stream",
        group: "Understory",
        enabled: editing,
        run: () => view.setFilter(!view.filter()),
      },
      {
        bind: "i",
        title: "Toggle inspector overlay",
        group: "Understory",
        enabled: () => editing() && overlayMode(),
        run: () => view.setOverlay(!view.overlay()),
      },
      {
        bind: "?",
        title: "Show keys",
        group: "Understory",
        enabled: editing,
        run: () => {
          setKeyOffset(0)
          setKeyList((value) => !value)
        },
      },
      {
        bind: "s",
        title: "Steer selected agent",
        group: "Understory",
        enabled: () => editing() && (selected()?.depth ?? 0) > 0,
        run: steer,
      },
      {
        bind: "x",
        title: "Kill selected agent",
        group: "Understory",
        enabled: () => editing() && (selected()?.depth ?? 0) > 0,
        run: kill,
      },
      {
        bind: "enter",
        title: "Open agent session",
        group: "Understory",
        enabled: () => editing() && selected() !== undefined,
        run: () => open(selected()),
      },
      { bind: "a", title: "Allow once", group: "Understory", enabled: editing, run: () => answer("once") },
      { bind: "shift+a", title: "Always allow", group: "Understory", enabled: editing, run: () => answer("always") },
      { bind: "d", title: "Deny", group: "Understory", enabled: editing, run: () => answer("reject") },
      { bind: "tab", title: "Focus composer", group: "Understory", enabled: editing, run: () => focusComposer() },
      {
        bind: "@",
        title: "Focus composer and pick a branch",
        group: "Understory",
        enabled: editing,
        run: () => focusComposer("@"),
      },
      {
        bind: "escape",
        title: "Back out one level",
        group: "Understory",
        enabled: () =>
          editing() &&
          (keyList() ||
            (view.lens() === "roots" && rootsRoot() !== undefined) ||
            (overlayMode() && view.overlay()) ||
            view.filter() ||
            armed() !== undefined),
        run: closeOneLevel,
      },
    ],
  }))

  /**
   * The inspector overlay's spring. Opening takes 700 ms with a slight
   * overshoot, closing 500 ms ease-out; with animations off it just appears and
   * disappears, and no timer runs.
   */
  const [overlayMotion, setOverlayMotion] = createSignal<{ readonly at: number; readonly open: boolean } | undefined>(
    undefined,
  )
  let overlayWasOpen = view.overlay()
  createEffect(() => {
    const open = view.overlay()
    if (open === overlayWasOpen) return
    overlayWasOpen = open
    if (!animations()) {
      setOverlayMotion(undefined)
      return
    }
    setOverlayMotion({ at: untrack(tick), open })
  })
  const overlayDuration = (open: boolean): number => (open ? 0.7 : 0.5)
  const overlayAnimating = (): boolean => {
    const motion = overlayMotion()
    if (motion === undefined || !animations()) return false
    return tick() - motion.at < overlayDuration(motion.open)
  }
  const overlayValue = (): number => {
    const motion = overlayMotion()
    if (motion === undefined) return view.overlay() ? 1 : 0
    const progress = Math.max(0, Math.min(1, (tick() - motion.at) / overlayDuration(motion.open)))
    return motion.open ? Math.min(1, spring(progress)) : 1 - ease(progress)
  }
  const overlayVisible = (): boolean =>
    view.overlay() || (overlayMotion()?.open === false && overlayValue() < 1)

  const tick = useTickerWhen(ticker, () => rows().some((row) => isLiveState(row.state)) || overlayAnimating())

  // The Agents tab owns the composer's routing for as long as it is mounted:
  // `@coder-1 fix this` steers that one branch, plain text stays root text, and
  // replay refuses every send. Chat registers none of this.
  onCleanup(
    registerComposerRouting({
      context: props.context,
      rows,
      root,
      mesh: props.mesh,
      live: view.live,
      tell: (text) => say(text),
      glyph: (row, index) => rowGlyph(row, index, tick(), animations()),
    }),
  )
  createEffect(() => props.context.ui.composer.setPlaceholder(composerPlaceholder(rows())))
  onCleanup(() => props.context.ui.composer.setPlaceholder(undefined))

  const runElapsed = createMemo(() => {
    tick()
    const rootRow = rows().find((row) => row.depth === 0)
    if (rootRow === undefined) return "0:00"
    // The stream can outlive the root's own turn (a child message lands after
    // the root went idle). RUN must never be shorter than the newest event it
    // contains; an ended run then shows that final duration. Replaying shows
    // the playhead instead, so the clock reads the scrubbed time.
    const end = view.live() ? Math.max(rootRow.endedAt ?? now(), newestEventAt()) : view.viewT()
    return runClock(Math.max(0, end - rootRow.startedAt))
  })

  function newestEventAt(): number {
    return rows().reduce((newest, row) => Math.max(newest, newestMessageAt(messagesOf(row.sessionID))), 0)
  }

  const runClockText = createMemo(() => {
    tick()
    const rootRow = rows().find((row) => row.depth === 0)
    if (rootRow === undefined) return "0:00"
    const end = view.viewT()
    return runClock(Math.max(0, end - rootRow.startedAt))
  })

  /** Everything the roster header reports about the run, as of the playhead. */
  const summary = createMemo(() => {
    tick()
    const list = displayRows()
    const tokens = list.reduce((total, row) => total + row.tokens, 0)
    const cost = list.reduce((total, row) => total + row.cost, 0)
    const limit = props.mesh.limits()?.maxSubagents
    return {
      clock: runElapsed(),
      state: runStateLabel(list),
      stateColor: runStateColor(list, theme()),
      tokens,
      ...(tokens > 0 ? { rate: list.reduce((total, row) => total + rateOf(row.sessionID), 0) } : {}),
      cost,
      ...(limit === undefined ? {} : { limit }),
    }
  })

  /** What the status row says on the left: this turn's message, else attention. */
  const statusLeft = createMemo((): { readonly text: string; readonly color: RGBA } | undefined => {
    if (message() !== undefined) return { text: message()!, color: theme().warning }
    const waitingRows = displayRows().filter((row) => row.state === "waiting")
    if (waitingRows.length > 0) {
      const first = waitingRows[0]!
      const target = pendingTarget(first.sessionID)
      const more = waitingRows.length > 1 ? ` (+${waitingRows.length - 1})` : ""
      return {
        text: `▲ ${first.label} needs you${target === undefined ? "" : `: ${target}`}${more} · a allow`,
        color: theme().warning,
      }
    }
    const alert = stale()[0]
    if (alert !== undefined) {
      return {
        text: `▲ ${alert.readerLabel} is editing ${fileName(alert.path)} from a stale read`,
        color: theme().error,
      }
    }
    return undefined
  })

  /** The mockup's right-aligned key hints on the status row. */
  const statusHints = createMemo((): string[] => {
    const segments: string[] = []
    if (width() >= 120) {
      segments.push("1-3 lens")
      if (view.lens() === "trace") segments.push(view.live() ? "drag ruler to rewind" : "l back to live")
    }
    segments.push("w next")
    if (overlayMode()) segments.push("i inspector")
    segments.push("? keys")
    return segments
  })

  const statusLine = createMemo((): Line => {
    const inner = Math.max(0, width() - 1)
    const left = statusLeft()
    const hints = fitHints(left === undefined ? inner : Math.max(0, inner - [...left.text].length - 2), statusHints())
    if (left === undefined) return spans(inner, [{ text: " ".repeat(Math.max(0, inner - hints.length)), color: theme().faint }, { text: hints, color: theme().faint }])
    const room = Math.max(0, inner - hints.length - 1)
    return spans(inner, [
      { text: truncate(left.text, room), color: left.color, bold: true },
      { text: " ".repeat(Math.max(0, inner - Math.min(room, [...left.text].length) - hints.length)), color: theme().faint },
      { text: hints, color: theme().faint },
    ])
  })

  const actionSegments = createMemo((): string[] => {
    if (!view.live()) return ["l back to live"]
    const row = selected()
    if (row === undefined) return []
    if (armed() !== undefined && armed()!.sessionID === row.sessionID) return [`x kill ${row.label}`]
    const segments: string[] = []
    if (row.depth > 0 && steerable(row)) segments.push("s steer")
    if (row.depth > 0 && row.state !== "killed") segments.push("x kill")
    segments.push("↵ open session")
    return segments
  })

  const inspectorWidth = () => Math.min(INSPECTOR_WIDTH, width())
  const inspector = (width: number) => (
    <Inspector
      width={width}
      height={Math.max(0, height() - 1)}
      row={selected()}
      hue={hueOf(selectedID())}
      glyph={selected() === undefined ? "⋯" : rowGlyph(selected()!, 0, tick(), animations())}
      glyphColor={
        selected() === undefined ? theme().faint : rowColor(selected()!, theme(), tick(), animations())
      }
      ask={ask()}
      sheet={sheet()}
      run={run()}
      hues={hues()}
      theme={theme()}
      animations={animations()}
      tick={tick()}
      now={at}
      actions={actionSegments()}
      file={view.lens() === "roots" ? view.file() : undefined}
      graph={graph()}
      pinned={view.pinned()}
      spans={spansBySession()}
      stale={stale()}
      touches={touches}
      rate={rateOf}
    />
  )

  const lensProps = (): LensProps => ({
    rows: displayRows(),
    visible: visible(),
    offset: rosterOffset(),
    ask: askOf,
    spans: spansBySession(),
    messages: messagesOf,
    hues: hues(),
    theme: theme(),
    view,
    selected: selectedID(),
    width: cols().stream,
    height: lensHeight(),
    geometry: geometry(),
    animations: animations(),
    tick: tick(),
    on: { selectAgent: select, pinCall: view.pinCall, selectFile: view.selectFile },
  })

  const keyWidth = () => Math.min(52, Math.max(6, width() - 2))
  const keyLines = createMemo(() => {
    const inner = Math.max(6, keyWidth() - 4)
    const total = KEY_ROWS.length
    const visibleCount = Math.max(1, Math.min(total, height() - 7))
    const offset = Math.max(0, Math.min(keyOffset(), Math.max(0, total - visibleCount)))
    const lines = [spans(inner, [{ text: "Keys", color: theme().text, bold: true }])]
    for (const [key, description] of KEY_ROWS.slice(offset, offset + visibleCount)) {
      lines.push(
        spans(inner, [
          { text: key, color: theme().leaf, bold: true },
          { text: " ".repeat(Math.max(1, 14 - key.length)), color: theme().muted },
          { text: description, color: theme().muted },
        ]),
      )
    }
    if (offset + visibleCount < total) {
      lines.push(spans(inner, [{ text: `↓ ${total - offset - visibleCount} more`, color: theme().faint }]))
    }
    return lines
  })

  return (
    <box
      flexDirection="column"
      flexGrow={1}
      minWidth={0}
      minHeight={0}
      onSizeChange={function () {
        setArea({ width: this.width, height: this.height })
      }}
    >
      <box flexDirection="row" flexGrow={1} minHeight={0} position="relative">
        <Roster
          rows={rows()}
          visible={visible()}
          hidden={foldState().hidden}
          folded={folded()}
          selected={selectedID()}
          hues={hues()}
          theme={theme()}
          width={cols().roster}
          height={height()}
          animations={animations()}
          live={view.live() && rows().some((row) => isLiveState(row.state))}
          tick={tick()}
          at={at}
          summary={summary()}
          spark={sparkFor}
          offset={rosterOffset()}
          header={geometry().header}
          laneHeight={geometry().laneHeight}
          onSelect={select}
          onScroll={scrollRoster}
        />

        <box flexDirection="column" flexGrow={1} minWidth={0} minHeight={0}>
          <LensTabs
            width={cols().stream}
            lens={view.lens()}
            onSelect={view.setLens}
            theme={theme()}
            clock={runClockText()}
            live={view.live()}
          />
          <box flexDirection="column" flexGrow={1} minHeight={0} minWidth={0}>
            {view.lens() === "trace" ? (
              <TraceLens {...lensProps()} onScroll={scrollRoster} />
            ) : view.lens() === "roots" ? (
              <RootsLens
                {...lensProps()}
                codegraph={props.codegraph}
                mapRoot={rootsRoot()}
                onMapRoot={setRootsRoot}
                root={props.context.location?.directory}
                onScroll={scrollRoster}
              />
            ) : (
              <StreamLens
                {...lensProps()}
                following={following()}
                top={streamTop()}
                onScroll={(scroll, top, follow) => {
                  streamScroll = scroll
                  setStreamTop(top)
                  setFollowing(follow)
                }}
              />
            )}
          </box>
        </box>

        <Show when={cols().docked}>{inspector(inspectorWidth())}</Show>

        <Show when={overlayMode() && overlayVisible()}>
          <box
            position="absolute"
            top={0}
            right={-Math.round(inspectorWidth() * (1 - overlayValue()))}
            bottom={0}
            width={inspectorWidth()}
            zIndex={20}
            backgroundColor={theme().surface}
          >
            {inspector(inspectorWidth())}
          </box>
        </Show>
      </box>

      <box height={1} flexShrink={0} paddingLeft={1}>
        <LineView width={Math.max(0, width() - 1)} spans={statusLine()} />
      </box>

      <Show when={keyList()}>
        <box
          position="absolute"
          left={Math.max(0, Math.floor((width() - keyWidth()) / 2))}
          top={Math.max(0, Math.floor((height() - Math.min(KEY_ROWS.length + 4, height() - 2)) / 2))}
          width={keyWidth()}
          height={Math.min(KEY_ROWS.length + 4, Math.max(6, height() - 2))}
          border
          borderColor={theme().primary}
          backgroundColor={theme().surface}
          flexDirection="column"
          paddingLeft={1}
          paddingRight={1}
          paddingTop={1}
          zIndex={30}
        >
          <For each={keyLines()}>{(line) => <LineView width={keyWidth() - 4} spans={line} />}</For>
        </box>
      </Show>
    </box>
  )
}

/** The newest message any loaded session has, so RUN never shrinks below its own stream. */
function newestMessageAt(messages: readonly SessionMessageInfo[]): number {
  return messages.reduce((newest, message) => Math.max(newest, message.time.created), 0)
}
