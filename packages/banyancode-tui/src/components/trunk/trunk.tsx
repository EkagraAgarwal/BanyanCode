import type { Context } from "@opencode/plugin/tui/context"
import type { RGBA } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { createEffect, createMemo, createSignal, For, Match, onCleanup, onMount, Show, Switch } from "solid-js"
import { createDismissedBranches, type DismissedBranches } from "../../data/dismissed"
import type { MeshLive } from "../../data/live"
import { directChildren, type ChildState } from "../../data/mesh"
import { createTicker, mix, useTickerWhen, type Ticker } from "../../motion"
import { palette, type Palette } from "../../theme"
import { openView } from "../panels/nav"
import { PANEL } from "../../constants"
import { Sprout } from "../status/sprout"
import {
  branchLabelLayout,
  connectorCells,
  connectorRuns,
  dimProgress,
  labelOpacity,
  motionRemaining,
  TRUNK_RAIL_MIN_WIDTH,
  trunkBranches,
  trunkLevel,
  trunkRows,
  type TrunkBranch,
  type TrunkRow,
} from "./layout"

const TRUNK = "│"
const JUNCTION = "┤"
const ROOT = "◉"
const DONE = "✓"
const FAILED = "✕"
const WAITING = "!"

type BranchRow = Extract<TrunkRow, { kind: "branch" }>
type DetailRow = Extract<TrunkRow, { kind: "detail" }>
type MoreRow = Extract<TrunkRow, { kind: "more" }>

const asBranch = (row: TrunkRow): BranchRow | undefined => (row.kind === "branch" ? row : undefined)
const asDetail = (row: TrunkRow): DetailRow | undefined => (row.kind === "detail" ? row : undefined)
const asMore = (row: TrunkRow): MoreRow | undefined => (row.kind === "more" ? row : undefined)

/** The state glyph beside a branch name. Running agents get the spinner instead. */
export function branchGlyph(state: ChildState): string | undefined {
  if (state === "running") return undefined
  if (state === "waiting") return WAITING
  if (state === "failed") return FAILED
  return DONE
}

/** Pills order: what needs you, then what is working, then failures and the finished tail. */
export function pillRank(state: ChildState): number {
  if (state === "waiting") return 0
  if (state === "running") return 1
  if (state === "failed") return 2
  return 3
}

/**
 * The **B · Trunk** rail: one column from the top of the transcript to the
 * composer, a root node at the top, and one branch per direct mesh child.
 *
 * It is the left side column's content, so the host's resize, collapse and
 * persisted width all still apply. Everything moves through the shared
 * `Ticker`: no branch, no work and no finished farewell leaves a timer behind.
 */
export function TrunkRail(props: {
  readonly context: Context
  readonly sessionID: string
  readonly mesh: MeshLive
  readonly ticker?: Ticker | undefined
  /** Columns the rail occupies. Supplied by the host slot; measured otherwise. */
  readonly width?: number | undefined
  /** Rows available. Measured from the column's own layout when omitted. */
  readonly height?: number | undefined
  /** Injectable clock, for tests. */
  readonly now?: (() => number) | undefined
  /** Shared dismissal set. Omitted, the rail keeps its own for its lifetime. */
  readonly dismissed?: DismissedBranches | undefined
}) {
  const theme = (): Palette => palette(props.context.theme)
  const animations = () => props.context.ui.animations()
  const ownsTicker = props.ticker === undefined
  const ticker = props.ticker ?? createTicker({ animations })
  if (ownsTicker) onCleanup(ticker.dispose)
  const dimensions = useTerminalDimensions()
  const now = () => props.now?.() ?? Date.now()
  const dismissed = props.dismissed ?? createDismissedBranches()
  const [measured, setMeasured] = createSignal<{ readonly width: number; readonly height: number }>()

  const width = () => Math.max(8, Math.floor(props.width ?? measured()?.width ?? 34))
  const height = () => Math.max(2, Math.floor(props.height ?? measured()?.height ?? dimensions().height - 3))
  /** Columns left of the trunk cell. */
  const area = () => Math.max(1, width() - 1)
  const detailArea = () => Math.max(1, area() - 1)

  const rootSessionID = createMemo(() => props.context.data.session.root(props.sessionID))
  const root = createMemo(() => props.mesh.root(rootSessionID()))

  onMount(() => {
    void props.mesh.ensure(rootSessionID())
    void props.mesh.refreshLimits()
  })

  // Bumped by the settle deadline so the branch list re-reads the clock after
  // the last farewell, even though the mesh itself did not change.
  const [epoch, setEpoch] = createSignal(0)

  const children = createMemo(() =>
    directChildren({
      context: props.context,
      sessionID: props.sessionID,
      root: root(),
      killed: props.mesh.killed(),
    }),
  )

  const branches = createMemo(() => {
    epoch()
    return trunkBranches({
      children: children(),
      killed: props.mesh.killed(),
      messages: (sessionID) => props.context.data.session.message.list(sessionID),
      now: now(),
      maxDetail: detailArea(),
    }).filter((branch) => !dismissed.isDismissed(rootSessionID(), branch.child.sessionID))
  })

  // End a dismissal when its branch stops being failed or leaves the mesh. The
  // mesh root is undefined before the first successful status response; a
  // failed poll keeps the last tree, so this never prunes from a transient miss.
  createEffect(() => {
    if (root() === undefined) return
    dismissed.prune(
      rootSessionID(),
      children()
        .filter((child) => child.state === "failed")
        .map((child) => child.sessionID),
    )
  })

  // Work in progress: the root turn, or any child that is running.
  const busy = createMemo(
    () =>
      props.context.data.session.status(props.sessionID) === "running" ||
      children().some((child) => child.state === "running"),
  )

  // A branch's second line is the child's own conversation, which the host only
  // loads for sessions it has opened. Ask once per branch, for the rows that
  // have something real to say.
  const synced = new Set<string>()
  createEffect(() => {
    for (const branch of branches()) {
      if (branch.child.state !== "running" && branch.child.state !== "done") continue
      if (synced.has(branch.child.sessionID)) continue
      synced.add(branch.child.sessionID)
      void props.context.data.session.message.sync(branch.child.sessionID)
    }
  })

  // Re-check the one-shot settle deadline so the clock stops when the last
  // farewell ends, instead of ticking forever behind a quiet rail.
  let settleTimer: ReturnType<typeof setTimeout> | undefined
  onCleanup(() => settleTimer !== undefined && clearTimeout(settleTimer))
  createEffect(() => {
    epoch()
    const remaining = branches()
      .map((branch) => motionRemaining(branch, now()))
      .filter((value) => Number.isFinite(value))
      .reduce((max, value) => Math.max(max, value), 0)
    if (settleTimer !== undefined) {
      clearTimeout(settleTimer)
      settleTimer = undefined
    }
    if (remaining <= 0) return
    settleTimer = setTimeout(() => setEpoch((value) => value + 1), remaining + 50)
  })

  const moving = createMemo(() => {
    epoch()
    if (!animations()) return false
    const current = now()
    return busy() || branches().some((branch) => motionRemaining(branch, current) > 0)
  })
  const time = useTickerWhen(ticker, moving)
  /** Ages have to advance on every tick, so this re-reads the clock after the shared one. */
  const clock = () => {
    time()
    return now()
  }

  const rows = createMemo(() => trunkRows({ height: height(), branches: branches() }))
  const open = (sessionID: string) => props.context.ui.router.navigate({ type: "session", sessionID })
  const dismiss = (branch: TrunkBranch) => dismissed.dismiss(rootSessionID(), [branch.child.sessionID])

  const trunkColor = (y: number): RGBA => mix(theme().faded, theme().highlight, busy() ? trunkLevel(y, time(), height()) : 0)
  const trunkGlyph = (row: TrunkRow) => (row.kind === "root" ? ROOT : row.kind === "branch" ? JUNCTION : TRUNK)

  const rootColor = () => (busy() ? theme().leaf : theme().done)

  /** The state colour every part of one branch shares, breathe included. */
  const branchColor = (branch: TrunkBranch, settledMs = branch.settledMs): RGBA => {
    if (branch.child.state === "waiting")
      return mix(theme().warning, theme().border, 0.35 + 0.35 * Math.sin(time() * 6))
    if (branch.child.state === "failed") return theme().error
    if (branch.child.state === "running") return theme().leaf
    return mix(theme().done, theme().faded, dimProgress(settledMs, animations()))
  }

  const BranchLine = (line: { readonly branch: TrunkBranch }) => {
    const age = () => Math.max(0, clock() - line.branch.child.createdAt)
    const settled = () => Math.max(0, clock() - (line.branch.child.lastActivityAt ?? line.branch.child.createdAt))
    // Only a failed or killed branch can be dismissed. Its row reserves the
    // last two columns (` ×`) from the label area so the width stays exact.
    const dismissable = () => line.branch.child.state === "failed"
    const layout = createMemo(() =>
      branchLabelLayout({
        name: line.branch.child.agent,
        cells: connectorCells(age(), animations()),
        area: area() - (dismissable() ? 2 : 0),
      }),
    )
    const opacity = () => labelOpacity(age(), animations())
    const color = () => branchColor(line.branch, settled())
    const nameColor = () =>
      mix(theme().background, line.branch.child.state === "running" ? theme().text : color(), opacity())
    const connectorBase = () => color()
    const runs = createMemo(() =>
      connectorRuns({
        cells: layout().cells,
        tick: time(),
        index: line.branch.child.createdAt % 7,
        running: line.branch.child.state === "running" && animations(),
      }),
    )
    const [hover, setHover] = createSignal(false)
    return (
      <box
        flexDirection="row"
        width="100%"
        backgroundColor={hover() ? theme().surfaceHigh : undefined}
        onMouseOver={() => setHover(true)}
        onMouseOut={() => setHover(false)}
        onMouseDown={() => open(line.branch.child.sessionID)}
      >
        <box width={layout().pad} flexShrink={0} />
        <text fg={nameColor()} wrapMode="none" flexShrink={0}>
          {line.branch.child.state === "running" ? <b>{layout().name}</b> : layout().name}
        </text>
        <text fg={color()} wrapMode="none" flexShrink={0}>
          {" "}
        </text>
        <Show
          when={branchGlyph(line.branch.child.state)}
          fallback={
            <Sprout
              tick={time()}
              color={theme().leaf}
              animations={animations()}
              offset={line.branch.child.createdAt % 13}
            />
          }
        >
          {(glyph) => (
            <text fg={color()} wrapMode="none" flexShrink={0}>
              {glyph()}
            </text>
          )}
        </Show>
        <text wrapMode="none" flexShrink={0}>
          {" "}
        </text>
        <For each={runs()}>
          {(run) => (
            <text fg={mix(connectorBase(), theme().highlight, run.level)} wrapMode="none" flexShrink={0}>
              {run.text}
            </text>
          )}
        </For>
        <Show when={dismissable()}>
          <text
            fg={theme().error}
            wrapMode="none"
            flexShrink={0}
            onMouseDown={(event) => {
              // Keep the row's own "open the session" handler from firing too.
              event.stopPropagation()
              dismiss(line.branch)
            }}
          >
            {" ×"}
          </text>
        </Show>
      </box>
    )
  }

  const DetailLine = (line: { readonly branch: TrunkBranch }) => {
    const color = () => {
      if (line.branch.child.state === "failed") return theme().error
      if (line.branch.child.state === "waiting") return theme().warning
      return theme().muted
    }
    return (
      <box paddingLeft={1} minWidth={0} flexGrow={1}>
        <Show when={line.branch.detail.length > 0}>
          <text fg={color()} wrapMode="none">
            {line.branch.detail}
          </text>
        </Show>
      </box>
    )
  }

  return (
    <box
      width="100%"
      height="100%"
      flexDirection="column"
      onSizeChange={function () {
        setMeasured({ width: this.width, height: this.height })
      }}
    >
      <For each={rows()}>
        {(row, y) => (
          <box flexDirection="row" width="100%" height={1} flexShrink={0}>
            <box flexGrow={1} minWidth={0} flexDirection="row">
              <Switch>
                <Match when={asBranch(row)}>{(branch) => <BranchLine branch={branch().branch} />}</Match>
                <Match when={asDetail(row)}>{(detail) => <DetailLine branch={detail().branch} />}</Match>
                <Match when={asMore(row)}>
                  {(more) => (
                    <box paddingLeft={1} onMouseDown={() => openView(props.context, PANEL.agents)}>
                      <text fg={theme().muted} wrapMode="none">
                        {`+${more().count} more`}
                      </text>
                    </box>
                  )}
                </Match>
              </Switch>
            </box>
            <text
              fg={row.kind === "root" ? rootColor() : row.kind === "branch" ? branchColor(row.branch) : trunkColor(y())}
              flexShrink={0}
              wrapMode="none"
            >
              {trunkGlyph(row)}
            </text>
          </box>
        )}
      </For>
    </box>
  )
}

/**
 * The narrow-terminal form: agent status as one row of pills above the
 * composer, replacing the rail below `TRUNK_RAIL_MIN_WIDTH` columns.
 */
export function TrunkPills(props: {
  readonly context: Context
  readonly sessionID: string
  readonly mesh: MeshLive
  readonly ticker?: Ticker | undefined
  readonly width?: number | undefined
  /** Shared dismissal set, so the narrow row agrees with the rail. */
  readonly dismissed?: DismissedBranches | undefined
}) {
  const theme = (): Palette => palette(props.context.theme)
  const animations = () => props.context.ui.animations()
  const ownsTicker = props.ticker === undefined
  const ticker = props.ticker ?? createTicker({ animations })
  if (ownsTicker) onCleanup(ticker.dispose)
  const dimensions = useTerminalDimensions()
  const dismissed = props.dismissed ?? createDismissedBranches()
  const rootSessionID = createMemo(() => props.context.data.session.root(props.sessionID))

  onMount(() => void props.mesh.ensure(rootSessionID()))

  const children = createMemo(() =>
    directChildren({
      context: props.context,
      sessionID: props.sessionID,
      root: props.mesh.root(rootSessionID()),
      killed: props.mesh.killed(),
    }),
  )
  // Dismissed branches stop counting here too, so `+N` matches the rail.
  const showing = createMemo(() =>
    children().filter(
      (child) => child.state !== "failed" || !dismissed.isDismissed(rootSessionID(), child.sessionID),
    ),
  )

  createEffect(() => {
    if (props.mesh.root(rootSessionID()) === undefined) return
    dismissed.prune(
      rootSessionID(),
      children()
        .filter((child) => child.state === "failed")
        .map((child) => child.sessionID),
    )
  })

  const time = useTickerWhen(ticker, () =>
    animations() && children().some((child) => child.state === "running" || child.state === "waiting"),
  )
  const area = () => Math.max(0, (props.width ?? dimensions().width) - 2)

  const visible = createMemo(() => {
    const ordered = [...showing()].sort(
      (a, b) => pillRank(a.state) - pillRank(b.state) || a.createdAt - b.createdAt,
    )
    const pills: Array<{
      readonly sessionID: string
      readonly running: boolean
      readonly glyph: string
      readonly label: string
      readonly color: RGBA
    }> = []
    let used = 0
    for (const child of ordered) {
      const size = child.agent.length + 3
      if (used + size > area()) break
      used += size
      const color =
        child.state === "waiting"
          ? theme().warning
          : child.state === "failed"
            ? theme().error
            : child.state === "running"
              ? theme().leaf
              : theme().done
      pills.push({
        sessionID: child.sessionID,
        running: child.state === "running",
        glyph: branchGlyph(child.state) ?? DONE,
        label: child.agent,
        color,
      })
    }
    return { pills, rest: ordered.length - pills.length }
  })

  return (
    <Show when={showing().length > 0}>
      <box flexDirection="row" height={1} flexShrink={0} paddingLeft={1} paddingRight={1} gap={1}>
        <For each={visible().pills}>
          {(pill) => (
            <box
              flexDirection="row"
              flexShrink={0}
              gap={1}
              onMouseDown={() => props.context.ui.router.navigate({ type: "session", sessionID: pill.sessionID })}
            >
              <Show
                when={pill.running}
                fallback={
                  <text fg={pill.color} wrapMode="none">
                    {pill.glyph}
                  </text>
                }
              >
                <Sprout tick={time()} color={pill.color} animations={animations()} />
              </Show>
              <text fg={pill.color} wrapMode="none">
                {pill.label}
              </text>
            </box>
          )}
        </For>
        <Show when={visible().rest > 0}>
          <text fg={theme().muted} wrapMode="none">
            {`+${visible().rest}`}
          </text>
        </Show>
      </box>
    </Show>
  )
}

/**
 * Rail above `TRUNK_RAIL_MIN_WIDTH`, pills below it, in a column the width the
 * host gives its left side column. The story and tests compose the surface this
 * way so the threshold and the column width are exercised, not restated.
 */
export function TrunkSurface(props: {
  readonly context: Context
  readonly sessionID: string
  readonly mesh: MeshLive
  readonly ticker?: Ticker | undefined
  readonly terminalWidth: number
  readonly terminalHeight: number
  /** Share of the terminal the rail column takes; the host's default is 22%. */
  readonly railPercent?: number | undefined
  readonly now?: (() => number) | undefined
  /** Shared dismissal set, so a width change does not bring a row back. */
  readonly dismissed?: DismissedBranches | undefined
}) {
  const railWidth = () => Math.max(12, Math.round(((props.railPercent ?? 22) / 100) * props.terminalWidth))
  return (
    <Show
      when={props.terminalWidth >= TRUNK_RAIL_MIN_WIDTH}
      fallback={
        <TrunkPills
          context={props.context}
          sessionID={props.sessionID}
          mesh={props.mesh}
          width={props.terminalWidth}
          dismissed={props.dismissed}
        />
      }
    >
      <box width={railWidth()} height={props.terminalHeight} flexDirection="column">
        <TrunkRail
          context={props.context}
          sessionID={props.sessionID}
          mesh={props.mesh}
          width={railWidth()}
          height={props.terminalHeight}
          now={props.now}
          dismissed={props.dismissed}
        />
      </box>
    </Show>
  )
}
