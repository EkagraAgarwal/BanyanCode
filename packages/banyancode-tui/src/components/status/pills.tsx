import type { Context } from "@opencode/plugin/tui/context"
import { createMemo, Show, onMount } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import type { CodegraphLive, MeshLive, SystemLive } from "../../data/live"
import type { AutoUpdateState, BuildState, GraphMeta, ReadinessResult } from "../../data/pending-rpc"
import type { Availability } from "../../data/rpc"
import { palette } from "../../theme"

export type PillSeverity = "neutral" | "success" | "warning" | "error" | "info"

export interface GraphPillState {
  readonly label: string
  readonly severity: PillSeverity
}

export interface StatusPill {
  readonly id: "agents" | "lsp" | "graph" | "yolo" | "swarm"
  readonly label: string
  readonly severity: PillSeverity
}

const DAY_MS = 24 * 60 * 60 * 1000

/** Columns the host needs for its own footer hints and the location label. */
export const HOST_FOOTER_RESERVE = 56
/** Below this width the plugin yields the footer completely. */
export const PLUGIN_FOOTER_MIN_WIDTH = HOST_FOOTER_RESERVE

/**
 * Width budget for plugin pills. The host footer (agent/commands hints) and the
 * location label share one row with this slot, so the plugin only spends what
 * is left after reserving the host's side. At narrow widths the budget is 0:
 * the plugin renders nothing instead of crowding out host text.
 */
export function pillBudget(width: number): number {
  if (!Number.isFinite(width) || width < PLUGIN_FOOTER_MIN_WIDTH) return 0
  return Math.floor(width) - HOST_FOOTER_RESERVE
}

/** Greedy left-to-right pack: keeps the highest-priority pills that fit the budget. */
export function packPills(pills: readonly StatusPill[], budget: number): StatusPill[] {
  if (budget <= 0) return []
  const kept: StatusPill[] = []
  let used = 0
  for (const pill of pills) {
    const cost = pill.label.length + (kept.length > 0 ? 2 : 0)
    if (used + cost > budget) continue
    kept.push(pill)
    used += cost
  }
  return kept
}

/**
 * Ported from v1 `status-pills.tsx` (`graphState` memo). Persisted readiness
 * wins over the local 24h heuristic; a live build/auto-update event is folded
 * into `build`/`autoUpdate` by the live layer before it gets here.
 */
export function graphPill(input: {
  readonly availability: Availability
  readonly readiness?: ReadinessResult | undefined
  readonly build?: BuildState | undefined
  readonly autoUpdate?: AutoUpdateState | undefined
  readonly meta?: GraphMeta | undefined
  readonly disabled?: boolean | undefined
  readonly now?: number
}): GraphPillState {
  if (input.availability === "unavailable") return { label: "Graph: —", severity: "neutral" }
  if (input.disabled) return { label: "Graph: disabled", severity: "error" }
  if (input.build?.status === "running") return { label: "Graph: building", severity: "info" }
  if (input.build?.status === "failed") return { label: "Graph: build failed", severity: "error" }
  if (input.autoUpdate?.status === "draining" && input.autoUpdate.pending > 0) {
    return { label: `Graph: syncing (${input.autoUpdate.pending})`, severity: "info" }
  }
  if (input.autoUpdate?.status === "paused") return { label: "Graph: paused", severity: "warning" }
  switch (input.readiness?.reason) {
    case "building":
      return { label: "Graph: building", severity: "info" }
    case "failed":
      return { label: "Graph: build failed", severity: "error" }
    case "stale":
      return { label: "Graph: stale", severity: "warning" }
    case "ready":
      return { label: "Graph: built", severity: "success" }
    case "missing":
      return { label: "Graph: not built", severity: "error" }
  }
  if (input.availability === "unknown") return { label: "Graph: …", severity: "neutral" }
  const meta = input.meta
  const hasGraph = meta !== undefined && meta.graphVersion > 0 && meta.totalFiles > 0
  if (!hasGraph) return { label: "Graph: not built", severity: "error" }
  const now = input.now ?? Date.now()
  const old = meta.graphBuiltAt > 0 && now - meta.graphBuiltAt > DAY_MS
  if (meta.graphCoverage < 0.5 || old) return { label: "Graph: stale", severity: "warning" }
  return { label: "Graph: built", severity: "success" }
}

export function severityColor(theme: ReturnType<typeof palette>, severity: PillSeverity) {
  if (severity === "success") return theme.success
  if (severity === "warning") return theme.warning
  if (severity === "error") return theme.error
  if (severity === "info") return theme.info
  return theme.muted
}

export function activePeers(mesh: MeshLive, rootSessionID: string | undefined): number {
  if (!rootSessionID) return 0
  const root = mesh.root(rootSessionID)
  if (!root) return 0
  return root.children.filter((node) => node.state === "running" || node.state === "retry").length
}

/**
 * Running subagents under the session. The session store and the mesh update at
 * different moments, so the larger of the two is the visible truth: a session
 * that has started but has no mesh node yet must still count.
 */
export function activeAgentCount(input: {
  readonly context: Context
  readonly sessionID?: string | undefined
  readonly mesh: MeshLive
}): number {
  const sessionID = input.sessionID
  if (!sessionID) return 0
  const family = input.context.data.session.family(sessionID)
  const running = family.filter(
    (id) => id !== sessionID && input.context.data.session.status(id) === "running",
  ).length
  return Math.max(running, activePeers(input.mesh, input.context.data.session.root(sessionID)))
}


/** True when the graph state is worth a footer pill. Neutral/unknown is silent. */
export function graphPillVisible(state: GraphPillState): boolean {
  return state.severity !== "neutral"
}

/**
 * Every pill the footer could show, highest signal first. Zero counts and
 * off-by-default switches are never included: a fresh session renders no
 * plugin footer content at all.
 */
export function statusPills(input: {
  readonly activeAgents: number
  readonly graph: GraphPillState
  readonly lsp?: { readonly enabled: boolean; readonly connected: number } | undefined
  readonly yolo?: boolean | undefined
  readonly swarm?: boolean | undefined
}): StatusPill[] {
  const pills: StatusPill[] = []
  if (graphPillVisible(input.graph)) {
    pills.push({ id: "graph", label: input.graph.label, severity: input.graph.severity })
  }
  if (input.activeAgents > 0) {
    pills.push({ id: "agents", label: `● ${input.activeAgents} active`, severity: "success" })
  }
  if (input.lsp !== undefined) {
    if (!input.lsp.enabled) pills.push({ id: "lsp", label: "● LSP off", severity: "error" })
    else if (input.lsp.connected === 0) pills.push({ id: "lsp", label: "● LSP", severity: "warning" })
  }
  if (input.yolo === true) pills.push({ id: "yolo", label: "[yolo]", severity: "error" })
  if (input.swarm === true) pills.push({ id: "swarm", label: "[swarm]", severity: "error" })
  return pills
}

/**
 * v1 rendered this cluster at `app_top`. v2 splits it into
 * `prompt.footer.status` (in a session) and `home.footer.status` (home).
 *
 * The footer row also carries host hints and the location label, so this
 * component is width-aware: it reserves the host's columns, drops low-priority
 * pills that do not fit, and renders nothing when the terminal is narrow.
 */
export function StatusPills(props: {
  readonly context: Context
  readonly sessionID?: string
  readonly codegraph: CodegraphLive
  readonly mesh: MeshLive
  readonly system: SystemLive
}) {
  const theme = () => palette(props.context.theme)
  const dimensions = useTerminalDimensions()

  // YOLO and swarm can be on from config or the environment before anything toggles them.
  onMount(() => {
    void props.system.refreshYolo()
    void props.system.refreshLsp()
    void props.mesh.refreshLimits()
    void props.codegraph.refresh()
  })

  const activeAgents = createMemo(() =>
    activeAgentCount({ context: props.context, sessionID: props.sessionID, mesh: props.mesh }),
  )

  const graph = createMemo(() =>
    graphPill({
      availability: props.codegraph.availability(),
      readiness: props.codegraph.readiness(),
      build: props.codegraph.build(),
      autoUpdate: props.codegraph.autoUpdate(),
      meta: props.codegraph.meta(),
    }),
  )

  const lsp = createMemo(() => {
    const status = props.system.lsp()
    if (status === undefined) return undefined
    return {
      enabled: status.enabled,
      connected: status.servers.filter((server) => server.status === "connected" && !server.disabled).length,
    }
  })

  const candidates = createMemo(() =>
    statusPills({
      activeAgents: activeAgents(),
      graph: graph(),
      lsp: lsp(),
      yolo: props.system.yolo(),
      swarm: props.mesh.swarmMode(),
    }),
  )

  const visible = createMemo(() => packPills(candidates(), pillBudget(dimensions().width)))

  return (
    <Show when={visible().length > 0}>
      <box flexDirection="row" gap={2} alignItems="center" flexShrink={0}>
        {visible().map((pill) => (
          <text fg={severityColor(theme(), pill.severity)} flexShrink={0}>
            {pill.label}
          </text>
        ))}
      </box>
    </Show>
  )
}
