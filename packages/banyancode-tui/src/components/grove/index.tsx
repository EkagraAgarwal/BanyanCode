import type { Context } from "@opencode/plugin/tui/context"
import type { SessionInfo } from "@opencode/client"
import { TextAttributes, type RGBA } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import type { MeshLive } from "../../data/live"
import type { ChildState } from "../../data/mesh"
import { createTicker, gauss, mix, useTickerWhen, type Ticker } from "../../motion"
import { palette, type Palette } from "../../theme"
import { killSubagent, steerSubagent, type AgentTarget } from "../dialogs/actions"
import { groupAgentTreeChildren, type AgentNode } from "../panels/agents"
import { PANEL_KEY_MODE, usePanelFocus, useRowKeys, type PanelRow } from "../panels/keys"
import { buildGrovePanes, groveRootAgent, groveSummary, type GrovePaneView } from "./data"
import {
  GROVE_GAP,
  groveCenterStart,
  groveDropRow,
  groveGeometry,
  groveJunctionRow,
  groveNarrow,
  groveRuns,
  type GroveRowChars,
} from "./layout"
import { attentionColor, branchGrowth, returnPulse, unfoldRows } from "./motion"
import {
  buildGroupRows,
  buildListRow,
  buildPaneRows,
  type GrovePaneColors,
  type GroveRow,
  type GroveSpan,
} from "./pane"
import { groveAges, updateGroveTrace, type GroveTraceEntry } from "./trace"

/** Two rows of vertical arm between the branch row and the panes. */
const DROP_ROWS = 2
const HEADER_ROWS = 3 + 1 + DROP_ROWS

function paneColors(theme: Palette): GrovePaneColors {
  return {
    border: theme.border,
    text: theme.text,
    soft: theme.muted,
    dim: theme.faint,
    faint: theme.faint,
    accent: theme.leaf,
    done: theme.done,
    wood: theme.wood,
    highlight: theme.highlight,
    error: theme.error,
    warning: theme.warning,
    bright: theme.bright,
  }
}

function GroveRowView(props: { readonly row: GroveRow; readonly width: number }) {
  return (
    <text width={props.width} wrapMode="none">
      <For each={props.row.spans}>
        {(span: GroveSpan) => (
          <span style={{ fg: span.color, attributes: span.bold ? TextAttributes.BOLD : 0 }}>{span.text}</span>
        )}
      </For>
    </text>
  )
}

type GroveEntry =
  | { readonly kind: "pane"; readonly pane: GrovePaneView }
  | { readonly kind: "group"; readonly key: string; readonly agent: string; readonly nodes: readonly AgentNode[] }

/**
 * C · Grove. A live tree above one pane per direct subagent. Every value comes
 * from the mesh and the child's own messages; a missing output stays missing
 * rather than becoming placeholder narration.
 */
export function Grove(props: {
  readonly context: Context
  readonly sessionID: string
  readonly mesh: MeshLive
  readonly ticker?: Ticker | undefined
  readonly width?: number | undefined
  readonly now?: (() => number) | undefined
}) {
  const theme = () => palette(props.context.theme)
  const colors = createMemo(() => paneColors(theme()))
  const ownsTicker = props.ticker === undefined
  const ticker = props.ticker ?? createTicker({ animations: () => props.context.ui.animations() })
  if (ownsTicker) onCleanup(ticker.dispose)
  const animations = () => props.context.ui.animations()
  const now = () => props.now?.() ?? Date.now()

  const root = createMemo(() => props.context.data.session.root(props.sessionID))
  const rootSession = createMemo(() => props.context.data.session.get(root()))
  const dimensions = useTerminalDimensions()
  const [area, setArea] = createSignal({ width: props.width ?? 0, height: 0 })
  // The measured panel wins once layout reports it; the terminal is the first
  // frame's fallback, before the panel has been sized.
  const width = () => area().width || props.width || dimensions().width
  const height = () => area().height || dimensions().height
  const narrow = createMemo(() => groveNarrow(width()))
  const geometry = createMemo(() => groveGeometry(width()))

  onMount(() => {
    void props.mesh.ensure(root())
    void props.mesh.refreshLimits()
  })

  const panes = createMemo(() =>
    buildGrovePanes({
      context: props.context,
      root: props.mesh.root(root()),
      sessionID: root(),
      killed: props.mesh.killed(),
    }),
  )

  // Only the agents the panel can show are synced, once each: 20 agents cost
  // 20 bounded requests, never an unbounded stream.
  const synced = new Set<string>()
  createEffect(() => {
    for (const pane of panes()) {
      if (synced.has(pane.sessionID)) continue
      synced.add(pane.sessionID)
      void props.context.data.session.message.sync(pane.sessionID)
    }
  })

  const ordered = createMemo(() => {
    const rank = (pane: GrovePaneView): number =>
      pane.state === "running" ? 0 : pane.state === "waiting" ? 1 : pane.state === "failed" ? 2 : 3
    return [...panes()].sort((left, right) => rank(left) - rank(right) || left.createdAt - right.createdAt)
  })

  const [expanded, setExpanded] = createSignal<ReadonlySet<string>>(new Set())
  const [trace, setTrace] = createSignal<ReadonlyMap<string, GroveTraceEntry>>(new Map())
  createEffect(() => {
    const list = panes()
    const time = animations() ? ticker.time() : undefined
    setTrace((previous) =>
      updateGroveTrace(
        previous,
        list.map((pane) => ({ id: pane.sessionID, state: pane.state })),
        time,
      ),
    )
  })

  // Motion has to keep the clock alive after the last agent finishes, or the
  // return pulse would freeze half-way. Two seconds covers 800 ms + 1.2 s.
  const active = createMemo(() => {
    if (ordered().some((pane) => pane.state === "running" || pane.state === "waiting")) return true
    const time = ticker.time()
    return [...trace().values()].some((entry) => entry.finishedAt !== undefined && time - entry.finishedAt < 2)
  })
  const time = useTickerWhen(ticker, active)
  const entryOf = (sessionID: string) => trace().get(sessionID)
  const agesOf = (pane: GrovePaneView) => groveAges(entryOf(pane.sessionID), time())

  const firstRow = createMemo(() => ordered().slice(0, geometry().columns))
  const overflow = createMemo(() => ordered().slice(geometry().columns))
  const paneByID = createMemo(() => new Map(ordered().map((pane) => [pane.sessionID, pane])))

  const overflowEntries = createMemo<GroveEntry[]>(() => {
    const panesById = paneByID()
    return groupAgentTreeChildren(overflow().map(asNode)).flatMap((entry): GroveEntry[] => {
      if (entry.kind === "node") {
        const pane = panesById.get(entry.node.session.id)
        return pane === undefined ? [] : [{ kind: "pane" as const, pane }]
      }
      if (!expanded().has(entry.key)) {
        return [{ kind: "group" as const, key: entry.key, agent: entry.agentName, nodes: entry.nodes }]
      }
      return entry.nodes.flatMap((node) => {
        const pane = panesById.get(node.session.id)
        return pane === undefined ? [] : [{ kind: "pane" as const, pane }]
      })
    })
  })

  const entries = createMemo<GroveEntry[]>(() =>
    narrow()
      ? ordered().map((pane) => ({ kind: "pane" as const, pane }))
      : [
          ...firstRow().map((pane) => ({ kind: "pane" as const, pane })),
          ...overflowEntries(),
        ],
  )

  const toggleGroup = (key: string) => {
    const next = new Set(expanded())
    if (next.has(key)) next.delete(key)
    else next.add(key)
    setExpanded(next)
  }

  const target = (pane: GrovePaneView): AgentTarget => ({
    sessionID: pane.sessionID,
    agent: pane.agent,
    title: pane.title,
    state:
      pane.state === "running" || pane.state === "waiting"
        ? "running"
        : pane.state === "failed"
          ? "failed"
          : "idle",
    killed: pane.killed,
  })

  const open = (pane: GrovePaneView) =>
    props.context.ui.router.navigate({ type: "session", sessionID: pane.sessionID })
  const steer = (pane: GrovePaneView) =>
    void steerSubagent(props.context, props.mesh, root(), target(pane))
  const kill = (pane: GrovePaneView) => void killSubagent(props.context, props.mesh, root(), target(pane))

  const rows = createMemo<PanelRow[]>(() =>
    entries().map((entry) =>
      entry.kind === "group"
        ? {
            id: entry.key,
            actions: [{ title: "Expand group", run: () => toggleGroup(entry.key) }],
          }
        : {
            id: entry.pane.sessionID,
            actions: [
              { title: "Open agent", run: () => open(entry.pane) },
              { title: "Steer agent", run: () => steer(entry.pane) },
              { title: "Kill agent", run: () => kill(entry.pane) },
            ],
          },
    ),
  )
  const keys = useRowKeys({ context: props.context, rows })
  const current = createMemo(() => entries()[keys.row()])
  const selectedPane = createMemo(() => {
    const entry = current()
    return entry?.kind === "pane" ? entry.pane : undefined
  })

  const selectedEnabled = () => selectedPane() !== undefined
  const focus = usePanelFocus()
  const editing = () => focus === undefined || focus.zone() === "content"
  props.context.keymap.layer(() => ({
    mode: PANEL_KEY_MODE,
    priority: 21,
    commands: [
      {
        bind: "s",
        title: "Steer selected agent",
        group: "Grove",
        enabled: () => editing() && selectedEnabled(),
        run: () => {
          const pane = selectedPane()
          if (pane) steer(pane)
        },
      },
      {
        bind: "k",
        title: "Kill selected agent",
        group: "Grove",
        enabled: () => editing() && selectedEnabled(),
        run: () => {
          const pane = selectedPane()
          if (pane) kill(pane)
        },
      },
      {
        bind: "c",
        title: "Collapse agent groups",
        group: "Grove",
        enabled: () => editing() && expanded().size > 0,
        run: () => setExpanded(new Set()),
      },
    ],
  }))

  const summary = createMemo(() => groveSummary(ordered()))
  const anyAgents = createMemo(() => ordered().length > 0)
  const busy = createMemo(() => ordered().some((pane) => pane.state === "running"))
  const rootGlyph = () => (anyAgents() ? "◉" : "○")
  const rootColor = () =>
    busy() ? mix(theme().leaf, theme().highlight, 0.5 + 0.5 * Math.sin(time() * 5)) : theme().done
  const trunkColor = () =>
    busy() ? mix(theme().faded, theme().highlight, 0.5 + 0.5 * Math.sin(time() * 9)) : theme().faded

  const centeredRow = (text: string, color: RGBA): GroveRow => {
    const start = groveCenterStart(width(), text.length)
    return {
      spans: [
        { text: " ".repeat(start), color },
        { text, color },
      ],
    }
  }

  const rootRow = createMemo<GroveRow>(() => {
    const name = groveRootAgent(rootSession())
    const text = `${rootGlyph()} ${name}`
    const start = groveCenterStart(width(), text.length)
    return {
      spans: [
        { text: " ".repeat(start), color: theme().done },
        { text: `${rootGlyph()} `, color: rootColor() },
        { text: name, color: theme().text, bold: true },
      ],
    }
  })

  const junctionRow = createMemo<GroveRowChars | undefined>(() => {
    if (narrow()) return undefined
    const geo = geometry()
    const panes = firstRow()
    const growth = panes.map((pane) => branchGrowth(agesOf(pane).spawn).horizontal)
    return groveJunctionRow({
      width: geo.width,
      centers: geo.centers.slice(0, panes.length),
      mid: Math.floor(geo.width / 2),
      growth,
    })
  })

  const dropRows = createMemo<GroveRowChars[]>(() => {
    if (narrow()) return []
    const geo = geometry()
    const panes = firstRow()
    return Array.from({ length: DROP_ROWS }, (_, row) => {
      const growth = panes.map((pane) => {
        const drop = branchGrowth(agesOf(pane).spawn).drop
        return drop >= (row + 1) / DROP_ROWS ? 1 : 0
      })
      return groveDropRow({
        width: geo.width,
        centers: geo.centers.slice(0, panes.length),
        rows: 1,
        growth,
      })
    })
  })

  const paneColor = (pane: GrovePaneView): RGBA => {
    if (pane.state === "waiting") return theme().warning
    if (pane.state === "failed") return theme().error
    if (pane.state === "running") return theme().accent
    return mix(theme().accent, theme().faint, returnPulse(agesOf(pane).finish).dim)
  }

  const borderColor = (pane: GrovePaneView): RGBA => {
    if (pane.state === "waiting") return attentionColor(theme().warning, theme().border, time())
    if (pane.state === "failed") return theme().error
    if (pane.state === "running") return theme().accent
    return mix(theme().accent, theme().border, returnPulse(agesOf(pane).finish).dim)
  }

  const pulseAt = (pane: GrovePaneView, position: number): number => {
    const age = agesOf(pane).finish
    if (!Number.isFinite(age)) return 0
    const distance = returnPulse(age).travel * (DROP_ROWS + 1) - position
    return gauss(distance, 0.8)
  }

  const ownerColor = (owner: number, position: number): RGBA => {
    const pane = firstRow()[owner]
    if (pane === undefined) return theme().wood
    return mix(paneColor(pane), theme().highlight, pulseAt(pane, position) * 0.85)
  }

  const areaRows = () => Math.max(0, height() - (narrow() ? 3 : HEADER_ROWS))
  const showOverflow = createMemo(() => !narrow() && overflow().length > 0 && areaRows() >= 16)
  const secondRowHeight = createMemo(() =>
    showOverflow() ? Math.max(8, Math.min(14, Math.floor(areaRows() / 2))) : 0,
  )
  const listHeight = createMemo(() => Math.max(3, Math.min(10, Math.floor(areaRows() / 3))))
  const firstRowHeight = createMemo(() =>
    narrow()
      ? Math.max(3, areaRows() - listHeight())
      : Math.max(3, areaRows() - (showOverflow() ? secondRowHeight() : overflow().length > 0 ? 1 : 0)),
  )

  const elapsed = (pane: GrovePaneView): number | undefined => {
    if (pane.runStartedAt === undefined) return undefined
    if (pane.runEndedAt !== undefined) return Math.max(0, pane.runEndedAt - pane.runStartedAt)
    time()
    return Math.max(0, now() - pane.runStartedAt)
  }

  const paneRow = (pane: GrovePaneView, paneWidth: number, paneHeight: number): GroveRow[] => {
    const unfold = branchGrowth(agesOf(pane).spawn).unfold
    const rows = buildPaneRows({
      pane,
      width: paneWidth,
      height: paneHeight,
      selected: selectedPane()?.sessionID === pane.sessionID,
      tick: time(),
      animations: animations(),
      colors: colors(),
      border: borderColor(pane),
      stateColor: paneColor(pane),
      titleColor: pane.state === "done" ? theme().faint : theme().text,
      elapsedMs: elapsed(pane),
    })
    return rows.slice(0, unfoldRows(rows.length, unfold))
  }

  const groupRow = (entry: Extract<GroveEntry, { kind: "group" }>, groupWidth: number, groupHeight: number) => {
    const selected = current()
    return buildGroupRows({
      width: groupWidth,
      height: groupHeight,
      agent: entry.agent,
      count: entry.nodes.length,
      states: entry.nodes.map((node) => nodeState(node)),
      tokens: entry.nodes.reduce((sum, node) => sum + node.totalTokens, 0),
      cost: entry.nodes.reduce((sum, node) => sum + node.totalCost, 0),
      selected: selected?.kind === "group" && selected.key === entry.key,
      colors: colors(),
    })
  }

  const selectAt = (index: number) => (index >= 0 ? keys.setRow(index) : undefined)

  const overflowPaneWidth = () => geometry().widths[0] ?? 40

  const narrowPane = createMemo(() => {
    const entry = current()
    if (entry?.kind === "pane") return entry.pane
    return ordered()[0]
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
      <box flexDirection="column" flexShrink={0} width={geometry().width}>
        <GroveRowView row={rootRow()} width={geometry().width} />
        <GroveRowView row={centeredRow(summary(), theme().faint)} width={geometry().width} />
        <text wrapMode="none" width={geometry().width}>
          <span style={{ fg: trunkColor() }}>{" ".repeat(Math.floor(geometry().width / 2)) + "│"}</span>
        </text>
        <Show when={!narrow() && junctionRow()}>
          {(row) => (
            <text wrapMode="none" width={geometry().width}>
              <For each={groveRuns(row())}>
                {(run) => (
                  <span style={{ fg: run.owner >= 0 ? ownerColor(run.owner, DROP_ROWS) : trunkColor() }}>
                    {run.text}
                  </span>
                )}
              </For>
            </text>
          )}
        </Show>
        <For each={dropRows()}>
          {(row, index) => (
            <text wrapMode="none" width={geometry().width}>
              <For each={groveRuns(row)}>
                {(run) => (
                  <span style={{ fg: run.owner >= 0 ? ownerColor(run.owner, DROP_ROWS - 1 - index()) : trunkColor() }}>
                    {run.text}
                  </span>
                )}
              </For>
            </text>
          )}
        </For>
      </box>

      <Show when={narrow()}>
        <box flexDirection="column" flexGrow={1} minHeight={0} width={geometry().width}>
          <Show when={narrowPane()}>
            {(pane) => (
              <box flexDirection="column" flexShrink={0} width={geometry().width} height={firstRowHeight()}>
                <For each={paneRow(pane(), geometry().width, firstRowHeight())}>
                  {(row) => <GroveRowView row={row} width={geometry().width} />}
                </For>
              </box>
            )}
          </Show>
          <scrollbox id="banyancode.grove.list" height={listHeight()} flexShrink={0}>
            <For each={entries()}>
              {(entry, index) => (
                <box onMouseDown={() => selectAt(index())}>
                  <GroveRowView
                    row={
                      entry.kind === "group"
                        ? buildListRow({
                            width: geometry().width,
                            agent: `${entry.agent} ×${entry.nodes.length}`,
                            state: groupState(entry),
                            title: undefined,
                            selected: keys.row() === index(),
                            colors: colors(),
                          })
                        : buildListRow({
                            width: geometry().width,
                            agent: entry.pane.agent,
                            state: entry.pane.state,
                            title: entry.pane.title,
                            selected: keys.row() === index(),
                            colors: colors(),
                          })
                    }
                    width={geometry().width}
                  />
                </box>
              )}
            </For>
          </scrollbox>
        </box>
      </Show>

      <Show when={!narrow()}>
        <box
          flexDirection="row"
          flexGrow={1}
          minHeight={0}
          width={geometry().width}
          gap={GROVE_GAP}
        >
          <For each={firstRow()}>
            {(pane, index) => (
              <box
                flexDirection="column"
                flexShrink={0}
                width={geometry().widths[index()] ?? 40}
                height={firstRowHeight()}
                overflow="hidden"
                onMouseDown={() => selectAt(index())}
              >
                <For each={paneRow(pane, geometry().widths[index()] ?? 40, firstRowHeight())}>
                  {(row) => <GroveRowView row={row} width={geometry().widths[index()] ?? 40} />}
                </For>
              </box>
            )}
          </For>
        </box>
        <Show when={showOverflow()}>
          <scrollbox
            id="banyancode.grove.overflow"
            height={secondRowHeight()}
            flexShrink={0}
            width={geometry().width}
            scrollX
          >
            <box flexDirection="row" gap={GROVE_GAP} height={secondRowHeight()}>
              <For each={overflowEntries()}>
                {(entry, index) => (
                  <box
                    flexDirection="column"
                    flexShrink={0}
                    width={overflowPaneWidth()}
                    height={secondRowHeight()}
                    overflow="hidden"
                    onMouseDown={() => selectAt(firstRow().length + index())}
                  >
                    <For
                      each={
                        entry.kind === "group"
                          ? groupRow(entry, overflowPaneWidth(), secondRowHeight())
                          : paneRow(entry.pane, overflowPaneWidth(), secondRowHeight())
                      }
                    >
                      {(row) => <GroveRowView row={row} width={overflowPaneWidth()} />}
                    </For>
                  </box>
                )}
              </For>
            </box>
          </scrollbox>
        </Show>
        <Show when={!showOverflow() && overflow().length > 0}>
          <text wrapMode="none" width={geometry().width}>
            <span style={{ fg: theme().faint }}>
              {`+${overflow().length} more agent${overflow().length === 1 ? "" : "s"}`}
            </span>
          </text>
        </Show>
      </Show>

      <Show when={!anyAgents() && height() > 0}>
        <text wrapMode="none" width={geometry().width}>
          <span style={{ fg: theme().faint }}>{" ".repeat(groveCenterStart(geometry().width, 31))}No subagents for this session</span>
        </text>
      </Show>
    </box>
  )
}

function groupState(entry: Extract<GroveEntry, { kind: "group" }>): ChildState {
  const states = entry.nodes.map((node) => nodeState(node))
  if (states.includes("failed")) return "failed"
  if (states.includes("waiting")) return "waiting"
  if (states.includes("running")) return "running"
  return "done"
}

function nodeState(node: AgentNode): ChildState {
  if (node.killed || node.status === "error") return "failed"
  if (node.status === "queued") return "waiting"
  if (node.status === "running") return "running"
  return "done"
}

/**
 * `groupAgentTreeChildren` reads only `session.agent`; the rest of the node is
 * filled from the pane's own totals so grouping can reuse the panel's rule.
 */
function asNode(pane: GrovePaneView): AgentNode {
  return {
    session: pane.session ?? stubSession(pane),
    children: [],
    totalCost: pane.cost,
    totalTokens: pane.tokens,
    status:
      pane.state === "running" ? "running" : pane.state === "waiting" ? "queued" : pane.state === "failed" ? "error" : "done",
    killed: pane.killed,
    isPathToRunning: pane.state === "running",
  }
}

function stubSession(pane: GrovePaneView): SessionInfo {
  return {
    id: pane.sessionID,
    projectID: "",
    agent: pane.agent,
    title: pane.title,
    cost: pane.cost,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: pane.createdAt, updated: pane.createdAt },
    location: { directory: "" },
  } as SessionInfo
}
