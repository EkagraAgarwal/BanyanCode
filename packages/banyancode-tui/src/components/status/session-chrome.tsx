import type { Context } from "@opencode/plugin/tui/context"
import type { RGBA } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { createMemo, For, onCleanup, onMount, Show, Switch, Match } from "solid-js"
import type { CodegraphLive, MeshLive, SystemLive } from "../../data/live"
import { agentsStatus, fitAgentsStatusRow } from "../../data/agents-status"
import { PANEL } from "../../constants"
import { categorizeTokens } from "../../data/tokens"
import { createTicker, mix, useTickerWhen, type Ticker } from "../../motion"
import { palette } from "../../theme"
import { selectView, tabColumns, tabsEnd, viewKeyForPanel, SessionTabs, VIEW_TABS, type TabColumn, type ViewKey } from "../panels/nav"
import { canopyRuns } from "./canopy"
import { attentionBreakdown } from "./attention"
import { activeAgentCount, activePeers, graphPill, severityColor, type PillSeverity } from "./pills"

const BANYAN_GLYPH = "⣴⣿⣦"
const BRAND_NAME = "banyancode"
const BRAND_NAME_MIN_WIDTH = 62
const PROJECT_MIN_WIDTH = 90
const PROJECT_MAX_CHARS = 20
/** Columns between two right-hand status labels. */
const STATUS_GAP = 3

const folderName = (directory: string | undefined) => directory?.split(/[\\/]/).filter(Boolean).at(-1) ?? "BanyanCode"

export interface ChromeStatus {
  readonly text: string
  readonly tone: PillSeverity
}

export interface ChromeTabColumn extends TabColumn {
  /** Columns to skip before the label, from the previous element's end. */
  readonly pad: number
}

export interface ChromeLayout {
  readonly width: number
  readonly glyph: boolean
  readonly name: boolean
  readonly project?: { readonly name: string; readonly start: number } | undefined
  readonly tabs: readonly ChromeTabColumn[]
  /** First column after the last tab label. */
  readonly tabsEnd: number
  readonly statuses: ReadonlyArray<ChromeStatus & { readonly start: number }>
}

/**
 * Row 0 geometry, shared with the canopy rule so the active tab's heavy segment
 * lands on its label. Everything degrades in a fixed order when the terminal is
 * narrow: project, brand name, brand glyph, then all but the active tab.
 */
export function chromeLayout(input: {
  readonly width: number
  readonly active: ViewKey
  readonly project?: string | undefined
  readonly statuses?: readonly ChromeStatus[]
}): ChromeLayout {
  const width = Math.max(0, Math.floor(input.width))
  const project = input.project?.trim() ? truncateProject(input.project.trim()) : undefined
  const activeIndex = Math.max(
    0,
    VIEW_TABS.findIndex((tab) => tab.key === input.active),
  )
  const candidates = [
    { glyph: true, name: width >= BRAND_NAME_MIN_WIDTH, withProject: width >= PROJECT_MIN_WIDTH && project !== undefined },
    { glyph: true, name: width >= BRAND_NAME_MIN_WIDTH, withProject: false },
    { glyph: true, name: false, withProject: false },
    { glyph: false, name: false, withProject: false },
  ] as const

  for (const candidate of candidates) {
    const positioned = placeRow({ width, project, statuses: input.statuses, ...candidate })
    if (positioned) return positioned
  }

  // Too narrow for the whole tab bar: keep the active tab readable.
  const tab = VIEW_TABS[activeIndex]!
  const start = Math.max(1, Math.min(5, width - 1 - tab.label.length))
  return {
    width,
    glyph: false,
    name: false,
    project: undefined,
    tabs: [
      {
        key: tab.key,
        label: tab.label,
        labelStart: start,
        segmentStart: start - 1,
        width: tab.label.length + 2,
        pad: 0,
      },
    ],
    tabsEnd: start + tab.label.length,
    statuses: [],
  }
}

function placeRow(input: {
  readonly width: number
  readonly project: string | undefined
  readonly glyph: boolean
  readonly name: boolean
  readonly withProject: boolean
  readonly statuses: readonly ChromeStatus[] | undefined
}): ChromeLayout | undefined {
  const leftPad = 1
  const brandEnd = leftPad + (input.glyph ? 3 : 0) + (input.name ? 1 + BRAND_NAME.length : 0)
  const projectStart = brandEnd + 1
  const projectEnd = input.withProject && input.project ? projectStart + input.project.length : brandEnd
  const showProject = input.withProject && input.project !== undefined
  const tabsStart = showProject ? projectEnd + 3 : input.glyph ? brandEnd + 1 : leftPad
  const columns = tabColumns(tabsStart)
  const end = tabsEnd(columns)
  if (end > input.width - 1) return undefined

  let cursor = brandEnd
  if (showProject) cursor = projectEnd
  const tabs = columns.map((column) => {
    const pad = Math.max(0, column.labelStart - cursor)
    cursor = column.labelStart + column.label.length
    return { ...column, pad }
  })

  const requested = input.statuses ?? []
  const groupWidth = (count: number) =>
    requested.slice(0, count).reduce((sum, status, index) => sum + status.text.length + (index === 0 ? 0 : STATUS_GAP), 0)
  const groupStart = (count: number) => input.width - 1 - groupWidth(count)
  let kept = requested.length
  while (kept > 0 && groupStart(kept) < end + 2) kept -= 1
  const statuses: Array<ChromeStatus & { start: number }> = []
  let x = groupStart(kept)
  for (const status of requested.slice(0, kept)) {
    statuses.push({ ...status, start: x })
    x += status.text.length + STATUS_GAP
  }

  return {
    width: input.width,
    glyph: input.glyph,
    name: input.name,
    project: showProject ? { name: input.project as string, start: projectStart } : undefined,
    tabs,
    tabsEnd: end,
    statuses,
  }
}

function truncateProject(value: string): string {
  return value.length > PROJECT_MAX_CHARS ? `${value.slice(0, PROJECT_MAX_CHARS - 1)}…` : value
}

/** Everything the classic and Trunk top bars both need from the host. */
export interface ChromeHeaderProps {
  readonly context: Context
  readonly sessionID: string
  readonly codegraph: CodegraphLive
  readonly mesh: MeshLive
  readonly system: SystemLive
  readonly ticker?: Ticker | undefined
}

export interface ChromeFooterProps {
  readonly context: Context
  readonly sessionID: string
  readonly mesh: MeshLive
  readonly system: SystemLive
}

/**
 * The shared top bar. The classic layout renders the v1 arrangement the owner
 * kept (brand, project, statuses and key hints, then the tab row and its
 * separator); the Trunk layout renders the redesign's two-row chrome with the
 * canopy rule. The host owns the setting, so a layout switch remounts the right
 * one. The Agents tab always wears the canopy chrome: it is full-bleed, and the
 * classic footer's "need attention" count is not part of that surface.
 */
export function SessionHeader(props: ChromeHeaderProps) {
  return (
    <Show when={canopyChrome(props.context)} fallback={<ClassicHeader {...props} />}>
      <TrunkHeader {...props} />
    </Show>
  )
}

/** The shared bottom row; see SessionHeader for how the layout picks one. */
export function SessionFooter(props: ChromeFooterProps) {
  return (
    <Show when={canopyChrome(props.context)} fallback={<ClassicFooter {...props} />}>
      <TrunkFooter {...props} />
    </Show>
  )
}

function canopyChrome(context: Context): boolean {
  if (context.ui.sessionLayout() === "trunk") return true
  return context.ui.panel.current()?.name === PANEL.agents
}

const CLASSIC_PILLS_MIN_WIDTH = 72
const CLASSIC_HINTS_MIN_WIDTH = 110
const CLASSIC_PROJECT_MIN_WIDTH = 90
const CLASSIC_FOOTER_HINT_MIN_WIDTH = 100

function ClassicDot(props: {
  readonly color: RGBA
  readonly muted: RGBA
  readonly label: string
}) {
  return (
    <box flexDirection="row" flexShrink={0} gap={1}>
      <text fg={props.color}>●</text>
      <text fg={props.muted}>{props.label}</text>
    </box>
  )
}

/**
 * The classic top bar, as the v2-base release drew it: brand and project, live
 * statuses and key hints on row 0, then the centred CHAT / SESSIONS / AGENTS /
 * CONFIG row with a full-width rule under it.
 */
function ClassicHeader(props: ChromeHeaderProps) {
  const theme = () => palette(props.context.theme)
  const dimensions = useTerminalDimensions()

  // YOLO and swarm can be on from config or the environment before anything toggles them.
  onMount(() => {
    void props.system.refreshYolo()
    void props.system.refreshLsp()
    void props.mesh.refreshLimits()
    void props.codegraph.refresh()
  })

  const active = createMemo(() => {
    const family = props.context.data.session.family(props.sessionID)
    const running = family.filter(
      (id) => id !== props.sessionID && props.context.data.session.status(id) === "running",
    ).length
    return Math.max(running, activePeers(props.mesh, props.context.data.session.root(props.sessionID)))
  })
  const lspColor = createMemo(() => {
    const status = props.system.lsp()
    if (!status?.enabled) return theme().error
    return status.servers.some((server) => server.status === "connected" && !server.disabled)
      ? theme().success
      : theme().warning
  })
  const graph = createMemo(() =>
    graphPill({
      availability: props.codegraph.availability(),
      readiness: props.codegraph.readiness(),
      build: props.codegraph.build(),
      autoUpdate: props.codegraph.autoUpdate(),
      meta: props.codegraph.meta(),
    }),
  )

  return (
    <box flexDirection="column" flexShrink={0} width="100%">
      <box flexDirection="row" flexShrink={0} justifyContent="space-between" gap={1} paddingLeft={1} paddingRight={1}>
        <box flexDirection="row" gap={2} flexShrink={0}>
          <text fg={theme().primary}>
            <b>BANYANCODE</b>
          </text>
          <Show when={dimensions().width >= CLASSIC_PROJECT_MIN_WIDTH}>
            <text fg={theme().muted}>{folderName(props.context.location?.directory)}</text>
          </Show>
        </box>
        <Show when={dimensions().width >= CLASSIC_PILLS_MIN_WIDTH}>
          <box flexDirection="row" gap={2} flexShrink={0}>
            <ClassicDot
              color={active() > 0 ? theme().success : theme().muted}
              muted={theme().muted}
              label={`${active()} active`}
            />
            <ClassicDot color={lspColor()} muted={theme().muted} label="LSP" />
            <ClassicDot color={severityColor(theme(), graph().severity)} muted={theme().muted} label={graph().label} />
          </box>
        </Show>
        <Show when={dimensions().width >= CLASSIC_HINTS_MIN_WIDTH}>
          <text fg={theme().muted} flexShrink={0}>
            ctrl+p commands ctrl+] tabs
          </text>
        </Show>
      </box>
      <SessionTabs context={props.context} active={viewKeyForPanel(props.context.ui.panel.current()?.name)} />
    </box>
  )
}

/**
 * The classic bottom row, as the v2-base release drew it: project and branch on
 * the left, modes and the always-visible attention count on the right, then the
 * v1 key hint when there is room.
 */
function ClassicFooter(props: ChromeFooterProps) {
  const theme = () => palette(props.context.theme)
  const dimensions = useTerminalDimensions()
  const data = props.context.data
  const session = createMemo(() => data.session.get(props.sessionID))
  const location = () => session()?.location ?? props.context.location
  const branch = createMemo(() => {
    const current = location()
    return current ? data.location.vcs.info(current)?.branch.current : undefined
  })
  const attention = createMemo(() => attentionBreakdown(props.context, props.sessionID).count)
  return (
    <box flexDirection="row" flexShrink={0} width="100%" gap={2} paddingLeft={2} paddingRight={2}>
      <text fg={theme().muted} flexShrink={1} wrapMode="none">
        {folderName(location()?.directory)}
        {branch() ? ` · Git: ${branch()}` : ""}
      </text>
      <box flexGrow={1} />
      <Show when={props.system.yolo() === true}>
        <text fg={theme().error} flexShrink={0}>
          [yolo]
        </text>
      </Show>
      <Show when={props.mesh.swarmMode() === true}>
        <text fg={theme().error} flexShrink={0}>
          [swarm]
        </text>
      </Show>
      <text fg={attention() > 0 ? theme().error : theme().success} flexShrink={0}>
        {`▲ ${attention()} need attention`}
      </text>
      <Show when={dimensions().width >= CLASSIC_FOOTER_HINT_MIN_WIDTH}>
        <text fg={theme().muted} flexShrink={0}>
          ^p cmd · / search
        </text>
      </Show>
    </box>
  )
}

/**
 * The Trunk top bar: brand, project and tabs on row 0, then the canopy rule. The
 * rule is the tab underline: the active tab is a heavy segment, and a highlight
 * sweeps along it only while work is running.
 */
function TrunkHeader(props: ChromeHeaderProps) {
  const theme = () => palette(props.context.theme)
  const dimensions = useTerminalDimensions()
  const ownsTicker = props.ticker === undefined
  const ticker = props.ticker ?? createTicker({ animations: () => props.context.ui.animations() })
  if (ownsTicker) onCleanup(ticker.dispose)

  // YOLO and swarm can be on from config or the environment before anything toggles them.
  onMount(() => {
    void props.system.refreshYolo()
    void props.system.refreshLsp()
    void props.mesh.refreshLimits()
    void props.codegraph.refresh()
  })


  const activeKey = createMemo(() => viewKeyForPanel(props.context.ui.panel.current()?.name))
  const active = createMemo(() =>
    activeAgentCount({ context: props.context, sessionID: props.sessionID, mesh: props.mesh }),
  )
  const busy = createMemo(() => {
    const data = props.context.data
    if (data.session.status(props.sessionID) === "running") return true
    if (active() > 0) return true
    return data.session.family(props.sessionID).some((id) => data.session.status(id) === "running")
  })

  const lspTone = createMemo<PillSeverity>(() => {
    const status = props.system.lsp()
    if (!status?.enabled) return "error"
    return status.servers.some((server) => server.status === "connected" && !server.disabled) ? "success" : "warning"
  })
  const graph = createMemo(() =>
    graphPill({
      availability: props.codegraph.availability(),
      readiness: props.codegraph.readiness(),
      build: props.codegraph.build(),
      autoUpdate: props.codegraph.autoUpdate(),
      meta: props.codegraph.meta(),
    }),
  )
  // The v1 footer showed the host's context percentage; the plugin has no such
  // field, so derive it from the same token breakdown the sidebar uses.
  const contextPercent = createMemo(() => {
    const breakdown = categorizeTokens(props.context.data.session.message.list(props.sessionID))
    if (!breakdown || !breakdown.model || breakdown.total <= 0) return undefined
    const session = props.context.data.session.get(props.sessionID)
    const limit = props.context.data.location.model
      .list(session?.location ?? props.context.location)
      ?.find((model) => model.providerID === breakdown.model?.providerID && model.id === breakdown.model?.id)?.limit
      .context
    if (limit === undefined || limit <= 0) return undefined
    return Math.round((breakdown.total / limit) * 100)
  })

  const statuses = createMemo<ChromeStatus[]>(() => {
    const count = active()
    const result: ChromeStatus[] = [
      {
        text: count > 0 ? `◉ ${count} agent${count === 1 ? "" : "s"}` : "○ idle",
        tone: count > 0 ? "success" : "neutral",
      },
    ]
    const percent = contextPercent()
    if (percent !== undefined) result.push({ text: `ctx ${percent}%`, tone: "neutral" })
    result.push({ text: graph().label, tone: graph().severity })
    result.push({ text: "● LSP", tone: lspTone() })
    return result
  })

  const layout = createMemo(() =>
    chromeLayout({
      width: dimensions().width,
      active: activeKey(),
      project: folderName(props.context.location?.directory),
      statuses: statuses(),
    }),
  )
  const activeColumn = createMemo(() =>
    layout().tabs.find((column) => column.key === activeKey())
  )
  const time = useTickerWhen(ticker, () => busy())
  const runs = createMemo(() =>
    canopyRuns({
      width: dimensions().width,
      tick: time(),
      busy: busy(),
      activeStart: activeColumn()?.segmentStart,
      activeWidth: activeColumn()?.width,
    }),
  )
  const runColor = (run: { readonly level: number; readonly active: boolean }): RGBA =>
    run.active ? theme().leaf : mix(theme().border, theme().highlight, run.level)

  return (
    <box flexDirection="column" flexShrink={0} width="100%">
      <box
        flexDirection="row"
        flexShrink={0}
        width="100%"
        height={1}
        paddingLeft={1}
        paddingRight={1}
        alignItems="center"
      >
        <Show when={layout().glyph}>
          <text fg={theme().leaf} flexShrink={0} wrapMode="none">
            {BANYAN_GLYPH}
          </text>
        </Show>
        <Show when={layout().name}>
          <text fg={theme().text} flexShrink={0} wrapMode="none">
            {" "}
            <b>{BRAND_NAME}</b>
          </text>
        </Show>
        <Show when={layout().project}>
          {(project) => (
            <box paddingLeft={1} flexShrink={0}>
              <text fg={theme().muted} wrapMode="none" flexShrink={0}>
                {project().name}
              </text>
            </box>
          )}
        </Show>
        <For each={layout().tabs}>
          {(tab) => (
            <box paddingLeft={tab.pad} flexShrink={0}>
              <box onMouseDown={() => selectView(props.context, tab.key)}>
                <text
                  fg={tab.key === activeKey() ? theme().text : theme().muted}
                  wrapMode="none"
                  flexShrink={0}
                >
                  {tab.key === activeKey() ? <b>{tab.label}</b> : tab.label}
                </text>
              </box>
            </box>
          )}
        </For>
        <box flexGrow={1} />
        <For each={layout().statuses}>
          {(status, index) => (
            <box paddingLeft={index() === 0 ? 0 : STATUS_GAP} flexShrink={0}>
              <text fg={severityColor(theme(), status.tone)} wrapMode="none" flexShrink={0}>
                {status.text}
              </text>
            </box>
          )}
        </For>
      </box>
      <box flexDirection="row" flexShrink={0} width="100%" height={1}>
        <For each={runs()}>
          {(run) => (
            <text fg={runColor(run)} flexShrink={0} wrapMode="none">
              {run.text}
            </text>
          )}
        </For>
      </box>
    </box>
  )
}

/**
 * The Trunk bottom row: directory and branch on the left, an attention message
 * only while something is waiting, and the key hints. Statuses that row 0
 * already carries are deliberately absent. On the Agents tab this row also
 * carries the tab's own status: its attention line (or the transient `say()`
 * message) and its key hints, published through `agentsStatus`, so the full
 * height belongs to the roster lanes and the composer keeps its five rows.
 * Chat keeps the row it always had.
 */
function TrunkFooter(props: ChromeFooterProps) {
  const theme = () => palette(props.context.theme)
  const dimensions = useTerminalDimensions()
  const data = props.context.data
  const session = createMemo(() => data.session.get(props.sessionID))
  const location = () => session()?.location ?? props.context.location
  const branch = createMemo(() => {
    const current = location()
    return current ? data.location.vcs.info(current)?.branch.current : undefined
  })
  const attention = createMemo(() => attentionBreakdown(props.context, props.sessionID).count)
  const panel = () => props.context.ui.panel.current()?.name
  // The Agents tab repeats the count on its own status row; the Chat tab keeps it here.
  const showAttention = () => panel() !== PANEL.agents
  const agents = createMemo(() => {
    const published = agentsStatus()
    return fitAgentsStatusRow({
      width: Math.max(0, dimensions().width - 4),
      left: `${folderName(location()?.directory)}${branch() ? ` · Git: ${branch()}` : ""}`,
      ...(published?.text === undefined ? {} : { text: published.text }),
      marks: [props.system.yolo() === true ? "[yolo]" : "", props.mesh.swarmMode() === true ? "[swarm]" : ""],
      hints: published?.hints ?? [],
    })
  })
  return (
    <Switch>
      <Match when={panel() === PANEL.agents}>
        <box flexDirection="row" flexShrink={0} width="100%" gap={2} paddingLeft={2} paddingRight={2}>
          <text fg={theme().muted} flexShrink={1} wrapMode="none">
            {agents().left}
          </text>
          <Show when={agents().text !== ""}>
            <text
              fg={agentsStatus()?.tone === "error" ? theme().error : theme().warning}
              flexShrink={1}
              wrapMode="none"
            >
              {agents().text}
            </text>
          </Show>
          <box flexGrow={1} />
          <Show when={agents().marks !== ""}>
            <text fg={theme().error} flexShrink={0} wrapMode="none">
              {agents().marks}
            </text>
          </Show>
          <Show when={agents().hints !== ""}>
            <text fg={theme().muted} flexShrink={0} wrapMode="none">
              {agents().hints}
            </text>
          </Show>
        </box>
      </Match>
      <Match when={true}>
        <box flexDirection="row" flexShrink={0} width="100%" gap={2} paddingLeft={2} paddingRight={2}>
          <text fg={theme().muted} flexShrink={1} wrapMode="none">
            {folderName(location()?.directory)}
            {branch() ? ` · Git: ${branch()}` : ""}
          </text>
          <box flexGrow={1} />
          <Show when={props.system.yolo() === true}>
            <text fg={theme().error} flexShrink={0}>
              [yolo]
            </text>
          </Show>
          <Show when={props.mesh.swarmMode() === true}>
            <text fg={theme().error} flexShrink={0}>
              [swarm]
            </text>
          </Show>
          <Show when={attention() > 0 && showAttention()}>
            <text fg={theme().warning} flexShrink={0}>
              {`▲ ${attention()} need attention`}
            </text>
          </Show>
          <Show when={dimensions().width >= 110}>
            <text fg={theme().muted} flexShrink={0}>
              ^p commands · ^] tabs
            </text>
          </Show>
          <Show when={dimensions().width >= 80 && dimensions().width < 110}>
            <text fg={theme().muted} flexShrink={0}>
              ^p cmds
            </text>
          </Show>
        </box>
      </Match>
    </Switch>
  )
}
