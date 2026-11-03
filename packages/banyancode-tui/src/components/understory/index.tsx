import type { Context } from "@opencode/plugin/tui/context"
import type { SessionMessageInfo } from "@opencode/client"
import { TextAttributes, type RGBA, type ScrollBoxRenderable } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import type { MeshLive } from "../../data/live"
import { canSteer, pendingCount } from "../../data/mesh"
import { formatMoney, formatTokens, truncate } from "../../data/format"
import { returnedSummary } from "../../data/messages"
import {
  agentSheet,
  isLiveState,
  nextAttention,
  rosterRows,
  runSheet,
  shortLabel,
  stateGlyph,
  streamEntries,
  visibleRows,
  type AgentSheet,
  type RosterRow,
  type RunSheet,
  type StreamEntry,
  type StreamSession,
} from "../../data/understory"
import { createTicker, mix, useTickerWhen, type Ticker } from "../../motion"
import { palette, type Palette } from "../../theme"
import { steerSubagent, type AgentTarget } from "../dialogs/actions"
import { PANEL_KEY_MODE, usePanelFocus, usePanelScroll } from "../panels/keys"
import { sproutFrame } from "../status/sprout"
import { branchHue } from "./hue"
import {
  clock,
  costText,
  fitHints,
  INSPECTOR_WIDTH,
  rightAlign,
  rosterAreaRows,
  rosterRowHeight,
  rosterWindow,
  spans,
  stateColor,
  stateCountSpans,
  stateLabel,
  streamClock,
  treePrefix,
  understoryColumns,
  type Span,
} from "./layout"

type Line = readonly Span[]

function LineView(props: { readonly width: number; readonly spans: Line }) {
  return (
    <text width={Math.max(0, props.width)} wrapMode="none">
      <For each={props.spans}>
        {(span) => (
          <span style={{ fg: span.color, attributes: span.bold ? TextAttributes.BOLD : 0 }}>{span.text}</span>
        )}
      </For>
    </text>
  )
}

const KEY_ROWS: ReadonlyArray<readonly [string, string]> = [
  ["j k  ↑ ↓", "move selection"],
  ["w", "next agent needing attention"],
  ["z", "fold finished agents"],
  ["f", "stream: selected agent only"],
  ["i", "inspector overlay"],
  ["s", "steer the selected agent"],
  ["x", "kill (press twice)"],
  ["Enter", "open the agent session"],
  ["a A d", "allow once, always, deny"],
  ["Tab", "focus the composer"],
  ["Esc", "back out one level"],
  ["?", "close this list"],
]

/**
 * D · Understory, first slice: the roster, the merged stream and the inspector.
 * Trace, Roots, replay and the other lenses are deliberately absent.
 */
export function Understory(props: {
  readonly context: Context
  readonly sessionID: string
  readonly mesh: MeshLive
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

  const [selection, setSelection] = createSignal<string>()
  const [folded, setFolded] = createSignal(false)
  const [filtered, setFiltered] = createSignal(false)
  const [overlay, setOverlay] = createSignal(false)
  const [keyList, setKeyList] = createSignal(false)
  const [keyOffset, setKeyOffset] = createSignal(0)
  const [message, setMessage] = createSignal<string>()
  const [armed, setArmed] = createSignal<{ readonly sessionID: string; readonly label: string }>()
  const [rosterOffset, setRosterOffset] = createSignal(0)
  const [following, setFollowing] = createSignal(true)
  const [streamTop, setStreamTop] = createSignal(0)

  const foldedView = createMemo(() => visibleRows(rows(), { folded: folded(), selected: selection() }))
  const visible = createMemo(() => foldedView().rows)
  const selectedID = createMemo(() => foldedView().selected ?? visible()[0]?.sessionID)
  const selected = createMemo(() => rows().find((row) => row.sessionID === selectedID()))

  const focus = usePanelFocus()
  const editing = () => focus === undefined || focus.zone() === "content"

  const cols = createMemo(() => understoryColumns(width()))
  const overlayMode = () => !cols().docked

  const hues = createMemo(() => {
    const mode = props.context.themeMode
    return new Map(rows().map((row, index) => [row.sessionID, branchHue(index, mode)]))
  })
  const hueOf = (sessionID: string): RGBA => hues().get(sessionID) ?? theme().leaf

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

  const currentView = () => visibleRows(rows(), { folded: folded(), selected: selection() })

  const select = (sessionID: string | undefined) => {
    if (sessionID === undefined) return
    disarm()
    clearMessage()
    setSelection(sessionID)
    const list = currentView().rows
    const index = list.findIndex((row) => row.sessionID === sessionID)
    if (index >= 0) {
      const per = rosterRowHeight(list.length, rosterAreaRows(height()))
      const offset = rosterWindow({
        total: list.length,
        areaRows: rosterAreaRows(height()) - (folded() && currentView().hidden > 0 ? 1 : 0),
        rowHeight: per,
        offset: rosterOffset(),
        selected: index,
      })
      setRosterOffset(offset.offset)
    }
  }

  const move = (delta: number) => {
    const view = currentView()
    const list = view.rows
    if (list.length === 0) return
    const current = view.selected ?? selection()
    const index = list.findIndex((row) => row.sessionID === current)
    const next = Math.max(0, Math.min(list.length - 1, (index < 0 ? 0 : index) + delta))
    select(list[next]?.sessionID)
  }

  const jumpAttention = () => {
    const next = nextAttention(rows(), selectedID())
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
    const view = visibleRows(rows(), { folded: next, selected: selection() })
    if (view.selected !== undefined) setSelection(view.selected)
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
    const row = selected()
    if (row === undefined || row.depth === 0) return
    if (!steerable(row)) {
      say(`${row.label} is already finished`)
      return
    }
    void steerSubagent(props.context, props.mesh, root(), targetOf(row))
  }

  const permissions = createMemo(() => {
    const row = selected()
    return row === undefined ? [] : (props.context.data.session.permission.list(row.sessionID) ?? [])
  })
  const forms = createMemo(() => {
    const row = selected()
    return row === undefined ? [] : (props.context.data.session.form.list(row.sessionID) ?? [])
  })
  const waiting = () => selected()?.state === "waiting"
  const ask = createMemo(() => {
    if (!waiting()) return undefined
    const request = permissions()[0]
    if (request !== undefined) {
      return { kind: "permission" as const, title: request.action, target: request.resources[0] ?? "" }
    }
    const form = forms()[0]
    return form === undefined ? undefined : { kind: "form" as const, title: form.title, target: "" }
  })

  const answer = (decision: "once" | "always" | "reject") => {
    const row = selected()
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
    const row = selected()
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

  const focusComposer = () => props.context.keymap.dispatch("pane.focus.left")

  const streamSessions = createMemo((): readonly StreamSession[] =>
    rows().map((row) => {
      const messages = messagesOf(row.sessionID)
      const returned = returnedSummary(messages, 120)
      return {
        sessionID: row.sessionID,
        label: row.label,
        state: row.state,
        messages,
        ...(row.endedAt === undefined ? {} : { endedAt: row.endedAt }),
        ...(returned === undefined ? {} : { returned }),
      }
    }),
  )
  const allStream = createMemo(() =>
    streamEntries(streamSessions(), {
      ...(rows().some((row) => isLiveState(row.state)) ? { now: now() } : {}),
    }),
  )
  const stream = createMemo(() =>
    filtered() ? allStream().filter((entry) => entry.sessionID === selectedID()) : allStream(),
  )
  const newestEntryAt = () => allStream().at(-1)?.at ?? 0
  const streamOrigin = () => rows().find((row) => row.depth === 0)?.startedAt ?? 0
  const streamTruncated = createMemo(() =>
    rows().some((row) => (filtered() ? row.sessionID === selectedID() : true) && row.historyMayBeTruncated),
  )
  usePanelScroll(props.context, () => streamScroll, 6)

  const run = createMemo((): RunSheet | undefined =>
    runSheet({
      rows: rows(),
      root: root(),
      selected: selectedID(),
      messages: messagesOf,
    }),
  )
  const sheet = createMemo((): AgentSheet | undefined =>
    agentSheet({
      rows: rows(),
      root: root(),
      selected: selectedID(),
      messages: messagesOf,
    }),
  )

  const closeOneLevel = () => {
    if (keyList()) {
      setKeyList(false)
      setKeyOffset(0)
      return
    }
    if (overlayMode() && overlay()) {
      setOverlay(false)
      return
    }
    if (filtered()) {
      setFiltered(false)
      return
    }
    if (armed() !== undefined) {
      disarm()
      clearMessage()
    }
  }

  props.context.keymap.layer(() => ({
    mode: PANEL_KEY_MODE,
    priority: 35,
    commands: [
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
        bind: "f",
        title: "Filter the stream",
        group: "Understory",
        enabled: editing,
        run: () => setFiltered((value) => !value),
      },
      {
        bind: "i",
        title: "Toggle inspector overlay",
        group: "Understory",
        enabled: () => editing() && overlayMode(),
        run: () => setOverlay((value) => !value),
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
      {
        bind: "a",
        title: "Allow once",
        group: "Understory",
        enabled: editing,
        run: () => answer("once"),
      },
      {
        bind: "shift+a",
        title: "Always allow",
        group: "Understory",
        enabled: editing,
        run: () => answer("always"),
      },
      { bind: "d", title: "Deny", group: "Understory", enabled: editing, run: () => answer("reject") },
      { bind: "tab", title: "Focus composer", group: "Understory", enabled: editing, run: focusComposer },
      {
        bind: "escape",
        title: "Back out one level",
        group: "Understory",
        enabled: () =>
          editing() && (keyList() || (overlayMode() && overlay()) || filtered() || armed() !== undefined),
        run: closeOneLevel,
      },
    ],
  }))

  const tick = useTickerWhen(ticker, () => rows().some((row) => isLiveState(row.state)))

  const glyphOf = (row: RosterRow, index: number): string => {
    if (row.state !== "running") return stateGlyph(row.state, "⋯")
    return animations() ? sproutFrame(tick(), index) : "⋯"
  }

  const colorOf = (row: RosterRow): RGBA => {
    if (row.state === "waiting" && animations()) {
      const breath = 0.5 + 0.5 * Math.sin(tick() * Math.PI * 2)
      return mix(theme().warning, theme().border, breath * 0.6)
    }
    return stateColor(row.state, theme())
  }

  const runElapsed = createMemo(() => {
    tick()
    const rootRow = rows().find((row) => row.depth === 0)
    if (rootRow === undefined) return "0s"
    // The stream can outlive the root's own turn (a child message lands after
    // the root went idle). RUN must never be shorter than the newest event it
    // contains; an ended run then shows that final duration.
    const end = Math.max(rootRow.endedAt ?? now(), newestEntryAt())
    return clock(end - rootRow.startedAt)
  })

  const rosterLines = createMemo((): Line[] => {
    const list = visible()
    const paneWidth = Math.max(1, cols().roster)
    const reserveFold = folded() && foldedView().hidden > 0 ? 1 : 0
    const areaRows = Math.max(0, rosterAreaRows(height()) - reserveFold)
    const per = rosterRowHeight(list.length, areaRows)
    const selectedIndex = list.findIndex((row) => row.sessionID === selectedID())
    const window = rosterWindow({
      total: list.length,
      areaRows,
      rowHeight: per,
      offset: rosterOffset(),
      selected: selectedIndex < 0 ? undefined : selectedIndex,
    })

    const header: Line[] = [
      spans(paneWidth, [
        { text: " ", color: theme().faint },
        { text: "RUN ", color: theme().faint },
        { text: runElapsed(), color: theme().text, bold: true },
      ]),
      spans(paneWidth, [
        { text: " ", color: theme().faint },
        ...stateCountSpans(paneWidth - 1, rows(), theme()),
      ]),
    ]

    const drawn = list.slice(window.offset, window.offset + window.count)
    const entries = drawn.flatMap((row, index): Line[] => {
      const absolute = window.offset + index
      const isSelected = row.sessionID === selectedID()
      const prefix = treePrefix(list, row)
      const prefixWidth = Math.min(prefix.text.length, Math.max(0, paneWidth - 6))
      const prefixText = prefix.text.slice(0, prefixWidth)
      const glyph = glyphOf(row, absolute)
      const nameWidth = Math.max(1, paneWidth - prefixWidth - 1)
      const prefixSpan: Span[] =
        prefixText === "" ? [] : [{ text: prefixText, color: prefix.depthOnly ? theme().faint : theme().wood }]
      const nameColor = row.depth === 0 ? theme().text : hueOf(row.sessionID)
      const bar: Span = { text: isSelected ? "▌" : " ", color: theme().leaf }

      if (per === 1) {
        const tokens = paneWidth >= 29 && row.tokens > 0 ? formatTokens(row.tokens) : ""
        const labelWidth = Math.min(nameWidth, 14)
        const taskWidth = Math.max(0, paneWidth - prefixWidth - 5 - tokens.length - (tokens === "" ? 0 : 1))
        return [
          spans(paneWidth, [
            bar,
            ...prefixSpan,
            { text: glyph, color: colorOf(row), bold: true },
            { text: ` ${shortLabel(row.label, labelWidth - 2)}`, color: nameColor, bold: isSelected },
            ...(taskWidth > 2 && row.title !== undefined
              ? [{ text: `  ${truncate(row.title, taskWidth)}`, color: theme().muted }]
              : []),
            ...(tokens === "" ? [] : [{ text: ` ${tokens}`, color: theme().faint }]),
          ]),
        ]
      }

      const elapsed = clock((row.endedAt ?? now()) - row.startedAt)
      // The label keeps its number; when the elapsed column would eat into it,
      // drop elapsed instead and give the name the width it needs.
      const label = shortLabel(row.label, nameWidth - 2)
      const nameLine =
        label.length + elapsed.length + 3 <= nameWidth
          ? rightAlign(nameWidth, `${glyph} ${label}`, elapsed)
          : `${glyph} ${label}`
      const shownTokens = row.tokens > 0 ? formatTokens(row.tokens) : ""
      const shownCost = costText(row.cost)
      // The cost is the first thing dropped when it cannot sit next to the
      // token total; never clip a currency value into "$0…".
      const third =
        shownTokens === ""
          ? shownCost
          : shownCost !== "" && shownTokens.length + shownCost.length + 1 <= nameWidth
            ? rightAlign(Math.max(1, nameWidth), shownTokens, shownCost)
            : shownTokens
      return [
        spans(paneWidth, [bar, ...prefixSpan, { text: nameLine, color: nameColor, bold: isSelected }]),
        spans(paneWidth, [
          bar,
          { text: " ".repeat(Math.min(prefixWidth + 2, Math.max(0, paneWidth - 2))), color: theme().faint },
          {
            text:
              row.title === undefined
                ? ""
                : truncate(row.title, Math.max(0, paneWidth - prefixWidth - 3)),
            color: row.state === "done" ? theme().faint : theme().muted,
          },
        ]),
        spans(paneWidth, [
          bar,
          { text: " ".repeat(Math.min(prefixWidth, Math.max(0, paneWidth - 2))), color: theme().faint },
          { text: third, color: theme().faint },
        ]),
      ]
    })

    const foldedLine: Line[] =
      folded() && foldedView().hidden > 0
        ? [
            spans(paneWidth, [
              { text: " ", color: theme().faint },
              { text: `✓ ${foldedView().hidden} finished  ·  z show`, color: theme().done },
            ]),
          ]
        : []
    const marker: Line[] = window.overflow
      ? [
          spans(paneWidth, [
            { text: " ", color: theme().faint },
            { text: `↓ ${window.more} more`, color: theme().faint },
          ]),
        ]
      : []
    return [...header, ...entries, ...foldedLine, ...marker]
  })

  const hintSegments = createMemo((): string[] => {
    if (message() !== undefined) return [message()!]
    const row = selected()
    const segments: string[] = []
    if (armed() !== undefined) segments.push(`press x again to kill ${armed()!.label}`)
    segments.push("j k move", "w next", "z fold", "f filter")
    if (overlayMode()) segments.push("i inspector")
    segments.push("? keys", "Tab composer")
    if (row !== undefined) {
      if (row.depth > 0 && steerable(row))
        segments.push("s steer")
      if (row.depth > 0 && row.state !== "killed") segments.push("x kill")
      segments.push("Enter open")
    }
    if (waiting() && ask()?.kind === "permission") segments.push("a allow · A always · d deny")
    return segments
  })

  const inspectorWidth = () => Math.min(INSPECTOR_WIDTH, width())
  const inspectorLines = createMemo((): Line[] => {
    const inner = Math.max(4, inspectorWidth() - 2)
    const row = selected()
    if (row === undefined) return []
    const lines: Line[] = [
      spans(inner, [
        { text: `${glyphOf(row, 0)} `, color: colorOf(row), bold: true },
        { text: row.label, color: row.depth === 0 ? theme().text : hueOf(row.sessionID), bold: true },
        { text: `  ${stateLabel(row.state)}`, color: stateColor(row.state, theme()) },
      ]),
    ]
    const current = ask()
    if (current !== undefined) {
      const border = animations()
        ? mix(theme().warning, theme().border, (0.5 + 0.5 * Math.sin(tick() * Math.PI * 2)) * 0.6)
        : theme().warning
      const top = `╭─ ${current.kind === "form" ? "QUESTION" : "NEEDS YOU"} `
      const middle = (text: string, color: RGBA = theme().text) =>
        spans(inner, [
          { text: "│ ", color: border },
          { text: truncate(text, Math.max(0, inner - 4)), color },
          { text: " │", color: border },
        ])
      lines.push(
        spans(inner, [
          { text: top, color: border },
          { text: "─".repeat(Math.max(0, inner - top.length - 1)), color: border },
          { text: "╮", color: border },
        ]),
      )
      if (current.kind === "form") {
        lines.push(middle(current.title), middle("Enter opens the session", theme().muted))
      } else {
        lines.push(middle(`${current.title}${current.target === "" ? "" : ` ${current.target}`}`))
        lines.push(
          spans(inner, [
            { text: "│ ", color: border },
            { text: "a", color: theme().warning, bold: true },
            { text: " allow once  ", color: theme().muted },
            { text: "A", color: theme().warning, bold: true },
            { text: " always  ", color: theme().muted },
            { text: "d", color: theme().warning, bold: true },
            { text: " deny", color: theme().muted },
            { text: " │", color: border },
          ]),
        )
      }
      lines.push(spans(inner, [{ text: `╰${"─".repeat(Math.max(0, inner - 2))}╯`, color: border }]))
      lines.push(spans(inner, []))
    }

    const section = (title: string) => lines.push(spans(inner, [{ text: title, color: theme().wood, bold: true }]))
    const para = (text: string, color: RGBA = theme().muted) =>
      lines.push(spans(inner, [{ text: truncate(text.replace(/\s+/g, " ").trim(), inner), color }]))
    const blank = () => lines.push(spans(inner, []))

    const runSheetValue = run()
    if (runSheetValue !== undefined && row.depth === 0) {
      para(row.title ?? "orchestrating the run", theme().text)
      blank()
      section("TOKENS BY BRANCH")
      if (runSheetValue.branches.length === 0) para("No branches yet.")
      for (const branch of runSheetValue.branches) {
        lines.push(
          spans(inner, [
            { text: `${branch.label}  `, color: hueOf(branch.sessionID) },
            { text: formatTokens(branch.tokens), color: theme().muted },
            ...(branch.cost === undefined ? [] : [{ text: `  ${formatMoney(branch.cost)}`, color: theme().faint }]),
          ]),
        )
      }
      blank()
      section("RETURNED")
      const returned = runSheetValue.branches.filter((branch) => branch.returned !== undefined)
      if (returned.length === 0) para("Nothing has returned yet.")
      for (const branch of returned.slice(-8).reverse()) {
        lines.push(
          spans(inner, [
            { text: `${stateGlyph(branch.state, "⋯")} `, color: stateColor(branch.state, theme()) },
            { text: branch.label, color: hueOf(branch.sessionID), bold: true },
          ]),
        )
        para(`  ${branch.returned ?? ""}`, theme().text)
      }
      if (runSheetValue.truncated.length > 0) {
        blank()
        para("earlier activity not loaded for some branches", theme().warning)
      }
      return lines
    }

    const agent = sheet()
    if (agent === undefined) return lines
    if (agent.title !== undefined) para(agent.title, theme().text)
    lines.push(
      spans(inner, [
        { text: agent.model ?? "no model", color: theme().primary },
        { text: `  ${clock((row.endedAt ?? now()) - row.startedAt)}`, color: theme().faint },
        ...(agent.cost === undefined ? [] : [{ text: `  ${formatMoney(agent.cost)}`, color: theme().faint }]),
      ]),
    )
    if (agent.output.length > 0) {
      blank()
      section("OUTPUT")
      for (const line of agent.output) para(line, theme().text)
    }
    if (agent.tools.length > 0) {
      blank()
      section("TOOLS")
      for (const tool of agent.tools) {
        const glyph = tool.status === "error" ? "✕" : tool.status === "running" ? "▸" : "✓"
        lines.push(
          spans(inner, [
            {
              text: `${glyph} `,
              color: tool.error ? theme().error : tool.status === "running" ? theme().leaf : theme().done,
            },
            { text: `${tool.letter} `, color: theme().primary },
            { text: tool.name, color: theme().text },
            ...(tool.target === "" ? [] : [{ text: ` ${tool.target}`, color: theme().muted }]),
            ...(tool.durationMs === undefined ? [] : [{ text: `  ${clock(tool.durationMs)}`, color: theme().faint }]),
          ]),
        )
      }
    }
    if (agent.files.length > 0) {
      blank()
      section("CHANGED")
      for (const file of agent.files.slice(0, 8)) {
        lines.push(
          spans(inner, [
            { text: truncate(file.path, Math.max(4, inner - 12)), color: theme().muted },
            ...(file.added === undefined ? [] : [{ text: ` +${file.added}`, color: theme().diffAdded }]),
            ...(file.removed === undefined ? [] : [{ text: ` −${file.removed}`, color: theme().diffRemoved }]),
          ]),
        )
      }
    }
    blank()
    section("TOKENS")
    lines.push(spans(inner, [{ text: formatTokens(agent.tokens), color: theme().text, bold: true }]))
    if (agent.historyMayBeTruncated) {
      blank()
      para("earlier activity not loaded", theme().warning)
    }
    return lines
  })

  const actionSegments = createMemo((): string[] => {
    const row = selected()
    if (row === undefined) return []
    if (armed() !== undefined && armed()!.sessionID === row.sessionID) return [`x kill ${row.label}`]
    const segments: string[] = []
    if (row.depth > 0 && steerable(row))
      segments.push("s steer")
    if (row.depth > 0 && row.state !== "killed") segments.push("x kill")
    segments.push("Enter open")
    return segments
  })

  const keyWidth = () => Math.min(52, Math.max(6, width() - 2))
  const keyLines = createMemo((): Line[] => {
    const inner = Math.max(6, keyWidth() - 4)
    const total = KEY_ROWS.length
    const visibleCount = Math.max(1, Math.min(total, height() - 7))
    const offset = Math.max(0, Math.min(keyOffset(), Math.max(0, total - visibleCount)))
    const lines: Line[] = [spans(inner, [{ text: "Keys", color: theme().text, bold: true }])]
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
        <box
          flexDirection="column"
          width={cols().roster}
          flexShrink={0}
          minHeight={0}
          overflow="hidden"
        >
          <For each={rosterLines()}>{(line) => <LineView width={cols().roster} spans={line} />}</For>
        </box>

        <StreamView
          width={cols().stream}
          height={Math.max(0, height() - 1)}
          entries={stream()}
          hues={hues()}
          theme={theme()}
          animations={animations()}
          time={tick()}
          truncated={streamTruncated()}
          origin={streamOrigin()}
          filterLabel={filtered() ? `${selected()?.label ?? ""} only` : "All branches"}
          filterHue={filtered() ? hueOf(selectedID() ?? "") : undefined}
          following={following()}
          top={streamTop()}
          onScroll={(scroll, top, follow) => {
            streamScroll = scroll
            setStreamTop(top)
            setFollowing(follow)
          }}
        />

        <Show when={cols().docked}>
          <InspectorView
            width={inspectorWidth()}
            height={Math.max(0, height() - 1)}
            title={selected()?.depth === 0 ? "RUN" : "BRANCH"}
            lines={inspectorLines()}
            actions={actionSegments()}
            theme={theme()}
          />
        </Show>

        <Show when={overlayMode() && overlay()}>
          <box
            position="absolute"
            top={0}
            right={0}
            bottom={0}
            width={inspectorWidth()}
            zIndex={20}
            backgroundColor={theme().surface}
          >
            <InspectorView
              width={inspectorWidth()}
              height={Math.max(0, height() - 1)}
              title={selected()?.depth === 0 ? "RUN" : "BRANCH"}
              lines={inspectorLines()}
              actions={actionSegments()}
              theme={theme()}
            />
          </box>
        </Show>
      </box>

      <box height={1} flexShrink={0} paddingLeft={1}>
        <LineView
          width={Math.max(0, width() - 1)}
          spans={spans(Math.max(0, width() - 1), [
            {
              text: fitHints(Math.max(0, width() - 1), hintSegments()),
              color: message() !== undefined || armed() !== undefined ? theme().warning : theme().faint,
            },
          ])}
        />
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

function StreamView(props: {
  readonly width: number
  readonly height: number
  readonly entries: readonly StreamEntry[]
  readonly hues: ReadonlyMap<string, RGBA>
  readonly theme: Palette
  readonly animations: boolean
  readonly time: number
  readonly truncated: boolean
  readonly origin: number
  readonly filterLabel: string
  readonly filterHue?: RGBA | undefined
  readonly following: boolean
  readonly top: number
  readonly onScroll: (scroll: ScrollBoxRenderable, top: number, following: boolean) => void
}) {
  let scroll: ScrollBoxRenderable | undefined
  const inner = () => Math.max(0, props.width - 1)
  const area = () => Math.max(0, props.height - 1)
  const total = () => props.entries.length
  const start = () => {
    if (props.following) return Math.max(0, total() - area())
    return Math.max(0, Math.min(props.top, Math.max(0, total() - area())))
  }
  const slice = () => props.entries.slice(start(), start() + area())
  const spinner = () => (props.animations ? sproutFrame(props.time) : "⋯")
  const timeWidth = () => (inner() >= 60 ? 7 : 0)
  const tagWidth = () => Math.min(11, Math.max(6, Math.floor(inner() * 0.14)))
  const bodyWidth = () => Math.max(1, inner() - timeWidth() - tagWidth() - 1)

  const lineFor = (entry: StreamEntry): Line => {
    const tag = shortLabel(entry.label, tagWidth())
    const failed = entry.kind === "fail" || entry.detail?.error === true
    const prefix = streamPrefix(entry, props.animations, spinner())
    const summary = truncate(entry.summary, Math.max(1, bodyWidth() - prefix.length - (failed ? 2 : 0)))
    const parts: Span[] = []
    if (timeWidth() > 0)
      parts.push({ text: `${streamClock(Math.max(0, entry.at - props.origin)).padStart(6)} `, color: props.theme.faint })
    parts.push({ text: tag, color: props.hues.get(entry.sessionID) ?? props.theme.text, bold: true })
    parts.push({ text: " ".repeat(Math.max(1, tagWidth() - tag.length + 1)), color: props.theme.faint })
    parts.push({
      text: prefix,
      color: failed ? props.theme.error : entry.kind === "user" ? props.theme.primary : props.theme.done,
    })
    parts.push({ text: summary, color: failed ? props.theme.error : props.theme.text })
    if (failed) parts.push({ text: " !", color: props.theme.error, bold: true })
    return spans(inner(), parts)
  }

  const header = () =>
    spans(inner(), [
      {
        text: props.filterLabel,
        color: props.filterHue ?? (props.filterLabel === "All branches" ? props.theme.muted : props.theme.text),
        bold: props.filterLabel !== "All branches",
      },
      ...(props.following
        ? props.truncated
          ? [{ text: "   earlier activity not loaded", color: props.theme.warning }]
          : []
        : [
            { text: "   ↓ latest", color: props.theme.primary, bold: true },
            ...(props.truncated
              ? [{ text: "   earlier activity not loaded", color: props.theme.warning }]
              : []),
          ]),
    ])

  return (
    <box flexDirection="column" flexGrow={1} minWidth={0} minHeight={0} height={props.height} paddingLeft={1} overflow="hidden">
      <LineView width={inner()} spans={header()} />
      <Show
        when={total() > 0}
        fallback={
          <box flexDirection="column" flexGrow={1} minHeight={0}>
            <LineView width={inner()} spans={spans(inner(), [{ text: "No branches yet", color: props.theme.text }])} />
            <LineView
              width={inner()}
              spans={spans(inner(), [
                { text: "Agents appear here when the agent fans out.", color: props.theme.faint },
              ])}
            />
          </box>
        }
      >
        <scrollbox
          id="banyancode.understory.stream"
          height={area()}
          flexShrink={0}
          width={inner()}
          stickyScroll
          stickyStart="bottom"
          verticalScrollbarOptions={{
            visible: false,
            onChange: (position: number) => {
              if (scroll === undefined) return
              props.onScroll(scroll, position, position + area() >= total() - 0.5)
            },
          }}
          ref={(element: ScrollBoxRenderable) => {
            scroll = element
            props.onScroll(element, start(), props.following)
          }}
        >
          <box position="relative" height={total()} width={inner()} flexDirection="column">
            <For each={slice()}>
              {(entry, index) => (
                <box position="absolute" top={start() + index()} left={0} width={inner()} height={1}>
                  <LineView width={inner()} spans={lineFor(entry)} />
                </box>
              )}
            </For>
          </box>
        </scrollbox>
      </Show>
    </box>
  )
}

function InspectorView(props: {
  readonly width: number
  readonly height: number
  readonly title: string
  readonly lines: readonly Line[]
  readonly actions: readonly string[]
  readonly theme: Palette
}) {
  const inner = () => Math.max(0, props.width - 2)
  return (
    <box flexDirection="column" width={props.width} height={props.height} flexShrink={0} paddingLeft={1} overflow="hidden">
      <LineView width={inner()} spans={spans(inner(), [{ text: props.title, color: props.theme.wood, bold: true }])} />
      <scrollbox id="banyancode.understory.inspector" flexGrow={1} minHeight={0} width={inner()}>
        <box flexDirection="column" width={inner()}>
          <For each={props.lines}>{(line) => <LineView width={inner()} spans={line} />}</For>
        </box>
      </scrollbox>
      <LineView
        width={inner()}
        spans={spans(
          inner(),
          props.actions.flatMap((action, index): Span[] => {
            const kind = action.startsWith("s") ? "steer" : action.startsWith("x") ? "kill" : "open"
            return [
              ...(index === 0 ? [] : [{ text: "  ", color: props.theme.faint }]),
              {
                text: action,
                color: kind === "kill" ? props.theme.error : kind === "steer" ? props.theme.leaf : props.theme.primary,
                bold: true,
              },
            ]
          }),
        )}
      />
    </box>
  )
}

function streamPrefix(entry: StreamEntry, animations: boolean, spinner: string): string {
  const detail = entry.detail
  if (entry.kind === "tool" && detail !== undefined) {
    if (detail.error) return "✕ "
    if (detail.open) return animations ? `${spinner} ` : "⋯ "
    return "✓ "
  }
  if (entry.kind === "spawn") return "┬ "
  if (entry.kind === "return") return "↩ "
  if (entry.kind === "fail") return "✕ "
  if (entry.kind === "kill") return "⊘ "
  if (entry.kind === "user") return "› "
  if (entry.kind === "think") return "∴ "
  if (entry.kind === "text") return "│ "
  return "· "
}
