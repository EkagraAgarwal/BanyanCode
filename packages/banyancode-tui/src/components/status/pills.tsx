import type { Context } from "@opencode/plugin/tui/context"
import { createMemo, Show } from "solid-js"
import type { CodegraphLive, MeshLive } from "../../data/live"
import type { AutoUpdateState, BuildState, GraphMeta, ReadinessResult } from "../../data/pending-rpc"
import type { Availability } from "../../data/rpc"
import { palette } from "../../theme"

export type PillSeverity = "neutral" | "success" | "warning" | "error" | "info"

export interface GraphPillState {
  readonly label: string
  readonly severity: PillSeverity
}

const DAY_MS = 24 * 60 * 60 * 1000

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
 * v1 rendered this cluster at `app_top`. v2 splits it into
 * `prompt.footer.status` (in a session) and `home.footer.status` (home).
 */
export function StatusPills(props: {
  readonly context: Context
  readonly sessionID?: string
  readonly codegraph: CodegraphLive
  readonly mesh: MeshLive
}) {
  const theme = () => palette(props.context.theme)

  const activeAgents = createMemo(() => {
    const sessionID = props.sessionID
    if (!sessionID) return 0
    const family = props.context.data.session.family(sessionID)
    const running = family.filter(
      (id) => id !== sessionID && props.context.data.session.status(id) === "running",
    ).length
    return Math.max(running, activePeers(props.mesh, props.context.data.session.root(sessionID)))
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

  const agentsColor = () => (activeAgents() > 0 ? theme().success : theme().muted)

  return (
    <box flexDirection="row" gap={2} alignItems="center">
      <box flexDirection="row" flexShrink={0} gap={1}>
        <text fg={agentsColor()}>●</text>
        <text fg={theme().muted}>{activeAgents()} active</text>
      </box>
      <box flexDirection="row" flexShrink={0} gap={1}>
        <text fg={severityColor(theme(), graph().severity)}>●</text>
        <text fg={theme().muted}>{graph().label}</text>
      </box>
      <Show when={props.codegraph.autoUpdate()?.status === "draining" && props.codegraph.autoUpdate()!.pending > 0}>
        <text fg={theme().muted}>·</text>
      </Show>
    </box>
  )
}
