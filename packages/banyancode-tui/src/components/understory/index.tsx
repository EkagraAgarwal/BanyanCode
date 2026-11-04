import type { Context } from "@opencode/plugin/tui/context"
import type { SessionMessageInfo } from "@opencode/client"
import type { ScrollBoxRenderable } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { createEffect, createMemo, createSignal, onCleanup, onMount, Show, untrack } from "solid-js"
import type { CodegraphLive, MeshLive } from "../../data/live"
import { setAgentsStatus, type AgentsStatus } from "../../data/agents-status"
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
import { CellGrid } from "./cells"
import { buildGraphData, fileName, type GraphData } from "./graph-data"
import {
  composerPlaceholder,
  registerComposerRouting,
} from "./composer-route"
import { branchHue } from "./hue"
import { Inspector, type FileTouch, type InspectorAction, type InspectorAsk } from "./inspector"
import { LensTabs } from "./lens-tabs"
import {
  INSPECTOR_WIDTH,
  PAGE_FRACTION,
  rosterAreaRows,
  rosterRowHeight,
  rosterWindow,
  runClock,
  runStateColor,
  runStateLabel,
  rowGeometry,
  understoryColumns,
} from "./layout"
import { Roster, rowColor, rowGlyph } from "./roster"
import { StreamLens } from "./stream"
import { TraceLens } from "./trace"
import { RootsLens } from "./roots"
import { createUnderstoryView, lensStore, REPLAY_OFF, type LensProps } from "./view"
/**
 * D · Understory: the shell. It owns the roster, the layout and the shared view
 * state; the active lens is one seam below the lens tabs. The lenses read real
 * span data and draw themselves.
 *
 * The tab is click-first: every action has a visible target, and the only keys
 * left are the ones a list has always had (arrows, Enter, Esc, Tab). A typed
 * printable character goes to the composer instead of being swallowed here.
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
      more: (sessionID) => props.context.data.session.message.more?.(sessionID),
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

  const view = createUnderstoryView({ now, lens: lensStore(props.context) })
  // The live clock the lanes draw is coarse: one step per second, so a ticker
  // frame never needs to repaint the timeline. It only advances when the
  // ticker itself is running (animations on and work live).
  let lastClockSecond = Math.floor(now() / 1000)
  const [clockSecond, setClockSecond] = createSignal(lastClockSecond)

  const [selection, setSelection] = createSignal<string>()
  const [folded, setFolded] = createSignal(false)
  const [message, setMessage] = createSignal<string>()
  const [armed, setArmed] = createSignal<{ readonly sessionID: string; readonly label: string }>()
  const [rosterOffset, setRosterOffset] = createSignal(0)
  const [following, setFollowing] = createSignal(true)
  const [streamTop, setStreamTop] = createSignal(0)
  /** Last stream scroll position, so reaching the top loads once, not per event. */
  let streamTopWas = -1
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
  // The panel's row count is the whole area: the status row moved to the host
  // footer, so only the lens tabs sit above the lens.
  const lensHeight = () => Math.max(0, height() - geometry().tabs)

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

  /** The run bounds the time window is clamped to from the shell's keys. */
  const traceBounds = () => {
    const rootRow = rows().find((row) => row.depth === 0)
    const start = Math.max(0, rootRow?.startedAt ?? rows()[0]?.startedAt ?? 0)
    let newest = start
    for (const row of rows()) {
      newest = Math.max(newest, row.startedAt, row.endedAt ?? 0, newestMessageAt(messagesOf(row.sessionID)))
      for (const span of spansBySession().get(row.sessionID) ?? []) newest = Math.max(newest, span.t0, span.t1 ?? 0)
    }
    return { start, newest }
  }

  /** ← → scroll the timeline by a page; they no longer move the playhead. */
  const traceScroll = (fraction: number) => {
    const bounds = traceBounds()
    view.scrollTime({ ...bounds, fraction })
  }

  /** Fetch one older page of a session, if the host exposes paging. */
  const loadOlderPage = (sessionID: string) => {
    const load = props.context.data.session.message.loadMore
    if (load === undefined) return
    void load(sessionID).catch(() => undefined)
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

  /** The footer's attention line: pick the agent it names. */
  const selectWaiting = () => {
    const waiting = displayRows().find((row) => row.state === "waiting")
    if (waiting === undefined) {
      jumpAttention()
      return
    }
    select(waiting.sessionID)
  }

  const toggleFold = () => {
    const next = !folded()
    setFolded(next)
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
    if (row === undefined || !waiting()) {
      say("select the agent that is waiting")
      return
    }
    const request = permissions()[0]
    if (request === undefined) {
      if (forms().length > 0) say("answer this question in its session")
      else say("select the agent that is waiting")
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
    say(`kill ${row.label}? use kill again to confirm`, 3_000)
    killTimer = timers.setTimeout(() => {
      setArmed(undefined)
      killTimer = undefined
      setMessage((value) => (value === `kill ${row.label}? use kill again to confirm` ? undefined : value))
    }, 3_000)
  }

  const focusComposer = (text?: string) => {
    // The host hook focuses the real prompt and can type the first key, so a
    // typed character arrives already inserted instead of being handled twice.
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
   * Every key the tab still owns is a list key: arrows pick and scroll, Enter
   * opens, Esc backs out, Tab hands the keyboard to the composer. Everything
   * else is a mouse target on screen.
   */
  props.context.keymap.layer(() => ({
    mode: PANEL_KEY_MODE,
    priority: 35,
    commands: [
      {
        bind: "down",
        title: "Next row",
        group: "Understory",
        enabled: editing,
        run: () => move(1),
      },
      {
        bind: "up",
        title: "Previous row",
        group: "Understory",
        enabled: editing,
        run: () => move(-1),
      },
      {
        bind: "pagedown",
        title: "Scroll lanes down",
        group: "Understory",
        enabled: editing,
        run: () => scrollRoster(Math.max(1, geometry().visibleLanes)),
      },
      {
        bind: "pageup",
        title: "Scroll lanes up",
        group: "Understory",
        enabled: editing,
        run: () => scrollRoster(-Math.max(1, geometry().visibleLanes)),
      },
      {
        bind: "left",
        title: "Scroll time back",
        group: "Understory",
        enabled: () => editing() && view.lens() === "trace",
        run: () => traceScroll(-PAGE_FRACTION),
      },
      {
        bind: "right",
        title: "Scroll time forward",
        group: "Understory",
        enabled: () => editing() && view.lens() === "trace",
        run: () => traceScroll(PAGE_FRACTION),
      },
      {
        bind: "enter",
        title: "Open agent session",
        group: "Understory",
        enabled: () => editing() && selected() !== undefined,
        run: () => open(selected()),
      },
      { bind: "tab", title: "Focus composer", group: "Understory", enabled: editing, run: () => focusComposer() },
      {
        bind: "escape",
        title: "Back out one level",
        group: "Understory",
        enabled: () =>
          editing() &&
          ((view.lens() === "roots" && rootsRoot() !== undefined) ||
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

  // Quantise the ticker to whole seconds for the clock and the now line. The
  // signal changes once per second, so no lane repaints on the frames between.
  createEffect(() => {
    tick()
    // Data changes also re-read the clock, so an idle ticker with animations
    // off still shows the current second when new work lands.
    rows()
    const next = Math.floor(now() / 1000)
    if (next === lastClockSecond) return
    lastClockSecond = next
    setClockSecond(next)
  })

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
    const rootRow = rows().find((row) => row.depth === 0)
    if (rootRow === undefined) return "0:00"
    // Coarse while live: the tab strip is not a lane and must not repaint it.
    const end = view.live() ? clockSecond() * 1000 : view.viewT()
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
  const statusLeft = createMemo((): { readonly text: string; readonly tone: "warning" | "error" } | undefined => {
    if (message() !== undefined) return { text: message()!, tone: "warning" }
    const waitingRows = displayRows().filter((row) => row.state === "waiting")
    if (waitingRows.length > 0) {
      const first = waitingRows[0]!
      const target = pendingTarget(first.sessionID)
      const more = waitingRows.length > 1 ? ` (+${waitingRows.length - 1})` : ""
      return {
        text: `▲ ${first.label} needs you${target === undefined ? "" : `: ${target}`}${more}`,
        tone: "warning",
      }
    }
    const alert = stale()[0]
    if (alert !== undefined) {
      // A finished branch keeps its alert until something re-reads the file,
      // so the tense follows the branch rather than the alert.
      const reader = displayRows().find((row) => row.sessionID === alert.reader)
      const ended = reader !== undefined && !isLiveState(reader.state)
      return {
        text: `▲ ${alert.readerLabel} ${ended ? "edited" : "is editing"} ${fileName(alert.path)} from a stale read`,
        tone: "error",
      }
    }
    return undefined
  })

  /**
   * The tab's status row, published to the host footer: the panel spends no
   * row of its own on it, so the row under the composer carries the message.
   * Clicking that message picks the agent it names. One signal, read by
   * `session.footer`; cleared when the panel unmounts.
   */
  const statusRow = createMemo((): AgentsStatus => {
    const left = statusLeft()
    return {
      ...(left === undefined ? {} : { text: left.text, tone: left.tone }),
      hints: [],
      onAttention: selectWaiting,
    }
  })
  createEffect(() => setAgentsStatus(statusRow()))
  onCleanup(() => setAgentsStatus(undefined))

  /** The sheet's action row: a button per action, never a key hint. */
  const actions = createMemo((): readonly InspectorAction[] => {
    if (view.lens() === "roots" && view.file() !== undefined) {
      return [
        {
          id: "blast",
          label: view.blast() ? "hide blast radius" : "blast radius",
          tone: "primary",
          run: () => view.setBlast(!view.blast()),
        },
      ]
    }
    if (!view.live()) return [{ id: "live", label: "back to live", tone: "primary", run: () => view.setT(undefined) }]
    const row = selected()
    if (row === undefined) return []
    const buttons: InspectorAction[] = []
    if (armed() !== undefined && armed()!.sessionID === row.sessionID) {
      buttons.push({ id: "kill", label: "confirm kill?", tone: "error", run: kill })
      return buttons
    }
    if (row.depth > 0 && steerable(row)) {
      buttons.push({
        id: "steer",
        label: "steer",
        tone: "leaf",
        run: () => {
          const live = selectedLive()
          if (live !== undefined && live.depth > 0) focusComposer(`@${live.label} `)
          else steer()
        },
      })
    }
    if (row.depth > 0 && row.state !== "killed") {
      buttons.push({ id: "kill", label: "kill", tone: "error", run: kill })
    }
    buttons.push({ id: "open", label: "open session", tone: "primary", run: () => open(selected()) })
    return buttons
  })

  const inspectorWidth = () => Math.min(INSPECTOR_WIDTH, width())
  const inspector = (width: number) => (
    <Inspector
      width={width}
      height={Math.max(0, height())}
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
      actions={actions()}
      onAnswer={answer}
      onOpenSession={() => open(selectedLive())}
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

  /**
   * Typing goes to the composer. The panel holds the keyboard on this tab, and
   * with the single-letter commands gone a printable character has no other
   * meaning: it focuses the prompt and arrives already inserted. Modifier
   * chords (ctrl+p, ctrl+]) are left alone, and paste follows the same path.
   */
  onMount(() => {
    const input = props.context.renderer?.keyInput
    if (input === undefined) return
    const onKey = (event: {
      readonly name: string
      readonly ctrl: boolean
      readonly meta: boolean
      readonly option: boolean
      readonly super?: boolean
      readonly hyper?: boolean
      readonly eventType?: string
      preventDefault?(): void
    }) => {
      if (!editing()) return
      if (event.eventType !== undefined && event.eventType !== "press") return
      if (event.ctrl || event.meta || event.option || event.super === true || event.hyper === true) return
      if (props.context.renderer?.currentFocusedEditor != null) return
      // A base-layout fallback rewrites the name but keeps the sequence, so a
      // chord like ctrl+] arrives as `]` with sequence `3`. Only an event whose
      // sequence is the character itself is a real press.
      const sequence = (event as { readonly sequence?: string }).sequence
      const char = sequence !== undefined && [...sequence].length === 1 ? sequence : event.name
      if ([...char].length !== 1) return
      if (char !== event.name && event.name !== "space") return
      if (char < " " || char === "\u007f") return
      // The character is inserted here, so the rest of the dispatch must not
      // type it a second time into the prompt that just took focus.
      event.preventDefault?.()
      focusComposer(char)
    }
    const onPaste = (event: { readonly bytes: Uint8Array; preventDefault?(): void }) => {
      if (!editing()) return
      if (props.context.renderer?.currentFocusedEditor != null) return
      const text = new TextDecoder().decode(event.bytes)
      if (text === "") return
      event.preventDefault?.()
      focusComposer(text)
    }
    input.on("keypress", onKey)
    input.on("paste", onPaste)
    onCleanup(() => {
      input.off("keypress", onKey)
      input.off("paste", onPaste)
    })
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
          onOpen={(sessionID) => open(rows().find((row) => row.sessionID === sessionID))}
          onFold={toggleFold}
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
            following={view.following()}
            onLatest={view.latest}
            onLive={() => view.setT(undefined)}
            overlay={overlayMode() ? { open: view.overlay(), toggle: () => view.setOverlay(!view.overlay()) } : undefined}
          />
          <box flexDirection="column" flexGrow={1} minHeight={0} minWidth={0}>
            {view.lens() === "trace" ? (
              <TraceLens
                {...lensProps()}
                onScroll={scrollRoster}
                playhead={view.live() ? clockSecond() * 1000 : undefined}
                historyMore={(sessionID) => props.context.data.session.message.more?.(sessionID)}
                historyLoading={(sessionID) => props.context.data.session.message.loading?.(sessionID) ?? false}
                loadOlder={loadOlderPage}
              />
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
                onFilter={() => view.setFilter(!view.filter())}
                onScroll={(scroll, top, follow) => {
                  streamScroll = scroll
                  setStreamTop(top)
                  setFollowing(follow)
                  // Reaching the oldest loaded entry asks each visible branch
                  // for one older page, once per crossing rather than per event.
                  if (top === 0 && streamTopWas !== 0) {
                    for (const row of visible()) {
                      if (props.context.data.session.message.more?.(row.sessionID) === true) loadOlderPage(row.sessionID)
                    }
                  }
                  streamTopWas = top
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
            flexDirection="column"
          >
            {/* The overlay's own close control: the lens tabs' chip is behind it. */}
            <CellGrid
              id="banyancode.understory.overlay.chrome"
              width={Math.max(1, inspectorWidth())}
              height={1}
              background={theme().surface}
              draw={(grid) => {
                const close = "close ×"
                const start = Math.max(0, inspectorWidth() - close.length - 2)
                grid.text(start, 0, close, theme().muted)
                grid.hit(start, 0, close.length, 1, "overlay:close")
              }}
              onHit={(region) => {
                if (region === "overlay:close") view.setOverlay(false)
              }}
            />
            {inspector(inspectorWidth())}
          </box>
        </Show>
      </box>
    </box>
  )
}

/** The newest message any loaded session has, so RUN never shrinks below its own stream. */
function newestMessageAt(messages: readonly SessionMessageInfo[]): number {
  return messages.reduce((newest, message) => Math.max(newest, message.time.created), 0)
}
