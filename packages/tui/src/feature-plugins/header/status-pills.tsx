/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { useEvent } from "../../context/event"
import { toHex } from "../../util/color"
import type { Severity } from "../../util/palette"

export * as HeaderStatusPills from "./status-pills"

const id = "internal:header-status-pills"

export function View(props: { api: TuiPluginApi }) {
  const theme = () => props.api.theme.current
  const [activeSessionCount, setActiveSessionCount] = createSignal<number>(0)
  const [lastBuildStatus, setLastBuildStatus] = createSignal<"idle" | "running" | "completed" | "failed">("idle")
  // Phase 4: set by persisted status hydration when the server reports a
  // stale graph, cleared by any live build event. Drives the "Graph: stale"
  // memo branch across restarts even when the local 24h heuristic wouldn't
  // trigger.
  const [lastGraphReason, setLastGraphReason] = createSignal<"stale" | undefined>(undefined)
  const [lastBuildMeta, setLastBuildMeta] = createSignal({
    graphVersion: 0,
    graphCoverage: 0,
    graphBuiltAt: 0,
    totalFiles: 0,
  })
  const [syncStatus, setSyncStatus] = createSignal<"idle" | "watching" | "draining" | "paused">("idle")
  const [syncPending, setSyncPending] = createSignal<number>(0)

  const ev = useEvent()
  const unsubSession = ev.on("session.updated" as any, () => refreshSessionCount())
  onCleanup(unsubSession)

  const unsubGraph = ev.on("banyancode.codegraph.build" as any, (evt: any) => {
    // A live build event supersedes any persisted status hydration — the
    // server is talking to us directly now, so drop the reason signal.
    setLastGraphReason(undefined)
    const status = evt.properties?.status
    if (status === "idle" || status === "running" || status === "completed" || status === "failed") {
      setLastBuildStatus(status)
    }
    if (status === "cancelled") setLastBuildStatus("idle")
    if (status === "stuck") setLastBuildStatus("running")
    setLastBuildMeta((meta) => ({
      graphVersion: typeof evt.properties?.graphVersion === "number" ? evt.properties.graphVersion : meta.graphVersion,
      graphCoverage: typeof evt.properties?.graphCoverage === "number" ? evt.properties.graphCoverage : meta.graphCoverage,
      graphBuiltAt:
        typeof evt.properties?.graphBuiltAt === "number" || typeof evt.properties?.graphBuiltAt === "string"
          ? new Date(evt.properties.graphBuiltAt).getTime()
          : meta.graphBuiltAt,
      totalFiles: typeof evt.properties?.totalFiles === "number" ? evt.properties.totalFiles : meta.totalFiles,
    }))
  })
  onCleanup(unsubGraph)

  const unsubSync = ev.on("banyancode.codegraph.auto-update" as any, (evt: any) => {
    const status = evt.properties?.status
    if (status === "idle" || status === "watching" || status === "draining" || status === "paused") {
      setSyncStatus(status)
    }
    setSyncPending(typeof evt.properties?.pending === "number" ? evt.properties.pending : 0)
  })
  onCleanup(unsubSync)

  const refreshSessionCount = async () => {
    try {
      const list = await props.api.client.session.list({})
      const sessions = list.data ?? []
      const statuses = (props.api.state as any).session_status ?? {}
      const active = sessions.filter((s: any) => {
        const status = statuses[s.id]
        return status?.type === "busy" || status?.type === "retry"
      }).length
      setActiveSessionCount(active)
    } catch {
      setActiveSessionCount(0)
    }
  }

  // Phase 4: hydrate the pill from the persisted codegraph status endpoint on
  // mount so a BanyanCode restart shows the real graph state instead of "not
  // built" until the next build event lands. Live build/auto-update events
  // still override for immediate progress; this only fills the restart /
  // new-session gap where no events exist yet.
  const MAX_STATUS_ATTEMPTS = 8
  const STATUS_RETRY_DELAY_MS = 1000
  let statusCancelled = false
  let statusRetryTimer: ReturnType<typeof setTimeout> | undefined

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      statusRetryTimer = setTimeout(resolve, ms)
    })

  const refreshGraphStatus = async (): Promise<"ok" | "retry" | "unavailable"> => {
    const root = props.api.state?.path?.directory ?? props.api.state?.path?.worktree
    const statusCall = props.api.client.global?.codegraph?.status?.({ root })
    if (!statusCall) return "unavailable"
    const updateMeta = (data: any) =>
      setLastBuildMeta((current) => ({
        graphVersion: typeof data.graphVersion === "number" ? data.graphVersion : current.graphVersion,
        graphCoverage: typeof data.graphCoverage === "number" ? data.graphCoverage : current.graphCoverage,
        graphBuiltAt:
          typeof data.graphBuiltAt === "number" || typeof data.graphBuiltAt === "string"
            ? new Date(data.graphBuiltAt).getTime()
            : current.graphBuiltAt,
        totalFiles: typeof data.totalFiles === "number" ? data.totalFiles : current.totalFiles,
      }))
    try {
      const result = await statusCall
      const data = result?.data
      if (!data || typeof data.reason !== "string") return "retry"
      switch (data.reason) {
        case "missing":
          // Persisted truth: no graph. Leave lastBuildStatus unset so the
          // memo falls through to "Graph: not built".
          setLastGraphReason(undefined)
          return "ok"
        case "ready":
          setLastBuildStatus("completed")
          setLastGraphReason(undefined)
          updateMeta(data)
          return "ok"
        case "stale":
          // Persisted truth: graph exists but is stale. The reason signal
          // drives "Graph: stale" even when the local 24h heuristic wouldn't.
          setLastBuildStatus("completed")
          setLastGraphReason("stale")
          updateMeta(data)
          return "ok"
        case "building":
          setLastBuildStatus("running")
          setLastGraphReason(undefined)
          return "ok"
        case "failed":
          setLastBuildStatus("failed")
          setLastGraphReason(undefined)
          return "ok"
        default:
          return "retry"
      }
    } catch {
      // Server not ready yet (startup race) — the caller retries with
      // bounded backoff.
      return "retry"
    }
  }

  // Bounded startup retry: the status call can race server readiness on a
  // restart. Retry up to ~8 times ~1s apart and stop as soon as the server
  // answers with a definitive status. onCleanup aborts the loop and cancels
  // any pending sleep timer so there is no unbounded polling after unmount.
  const refreshGraphStatusWithRetry = async () => {
    for (let attempt = 0; attempt < MAX_STATUS_ATTEMPTS; attempt++) {
      if (statusCancelled) return
      const result = await refreshGraphStatus()
      if (result !== "retry" || statusCancelled) return
      await sleep(STATUS_RETRY_DELAY_MS)
    }
  }

  onCleanup(() => {
    statusCancelled = true
    if (statusRetryTimer !== undefined) clearTimeout(statusRetryTimer)
  })

  onMount(() => {
    refreshSessionCount()
    refreshGraphStatusWithRetry()
  })

  const mcpList = createMemo(() => props.api.state.mcp())
  const mcpConnectedCount = createMemo(() => mcpList().filter((m) => m.status === "connected").length)
  const mcpFirstConnected = createMemo(() => mcpList().find((m: any) => m.status === "connected")?.name ?? "")

const lspList = createMemo(() => props.api.state.lsp() as Array<{
  id: string
  name: string
  root: string
  status: "configured" | "connected" | "error"
  autoDownload: boolean
  languages: string[]
  inert: boolean
  disabled: boolean
}>)
const lspConnectedCount = createMemo(() => lspList().filter((l) => l.status === "connected" && !l.disabled).length)
const lspEnabled = createMemo(() => {
  const v = props.api.state.banyanConfig?.banyancode_lsp
  return v === true || (typeof v === "object" && v !== null)
})

const agentsLabel = () => `${activeSessionCount()} active`
const mcpLabel = () => (mcpConnectedCount() > 0 ? `MCP: ${mcpFirstConnected()}` : "MCP: —")
const graphState = createMemo<{ label: string; severity: Exclude<Severity, "neutral"> }>(() => {
  if ((props.api.state.banyanConfig as any)?.banyancode_codegraph_enabled === false) {
    return { label: "Graph: disabled", severity: "error" }
  }
  if (lastBuildStatus() === "running") return { label: "Graph: building", severity: "info" }
  if (lastBuildStatus() === "failed") return { label: "Graph: build failed", severity: "error" }
  if (syncStatus() === "draining" && syncPending() > 0) {
    return { label: `Graph: syncing (${syncPending()})`, severity: "info" }
  }
  if (syncStatus() === "paused") return { label: "Graph: paused", severity: "warning" }
  // Phase 4: persisted status reported the graph as stale. This reason signal
  // is set by refreshGraphStatus and cleared by any live build event, so it
  // renders "Graph: stale" across restarts even when the local 24h heuristic
  // below wouldn't trigger (e.g. a freshly built but low-coverage graph).
  if (lastGraphReason() === "stale" && lastBuildStatus() === "completed") {
    return { label: "Graph: stale", severity: "warning" }
  }
  const meta = lastBuildMeta()
  const hasGraph = meta.graphVersion > 0 && meta.totalFiles > 0
  const oldAndIdle =
    meta.graphBuiltAt > 0 && Date.now() - meta.graphBuiltAt > 24 * 60 * 60 * 1000 && syncStatus() === "idle"
  if (hasGraph && (meta.graphCoverage < 0.5 || oldAndIdle)) {
    return { label: "Graph: stale", severity: "warning" }
  }
  if (hasGraph && meta.graphCoverage >= 0.5 && lastBuildStatus() === "completed") {
    return { label: "Graph: built", severity: "success" }
  }
  // Phase 1: rename "off" → "not built". The pill never claims the feature is
  // missing; it just hasn't been built yet. Both `graphVersion === 0` (no
  // build has ever run) and `totalFiles === 0` (a build wrote nothing to
  // the file table) fall through here. Distinct from "disabled", which is
  // reserved for the explicit `banyancode_codegraph_enabled === false` case
  // checked above.
  return { label: "Graph: not built", severity: "error" }
})
const graphLabel = () => graphState().label

  const agentsDotColor = () => (activeSessionCount() > 0 ? toHex(theme().success) : toHex(theme().textMuted))
  const mcpDotColor = () => (mcpConnectedCount() > 0 ? toHex(theme().success) : toHex(theme().error))
  // Yellow = config enabled but no servers connected (waiting on a file).
  // Green = at least one server attached. Red = config disabled.
  const lspDotColor = () =>
    !lspEnabled()
      ? toHex(theme().error)
      : lspConnectedCount() > 0
        ? toHex(theme().success)
        : toHex(theme().warning)
  const graphDotColor = () => toHex(theme()[graphState().severity])

  return (
    <box flexDirection="row" gap={2} alignItems="center">
      <box flexDirection="row" flexShrink={0} gap={1}>
        <text fg={agentsDotColor()}>●</text>
        <text fg={toHex(theme().textMuted)}>{agentsLabel()}</text>
      </box>
      <box flexDirection="row" flexShrink={0} gap={1}>
        <text fg={lspDotColor()}>●</text>
        <text fg={toHex(theme().textMuted)}>LSP</text>
      </box>
      <box flexDirection="row" flexShrink={0} gap={1}>
        <text fg={graphDotColor()}>●</text>
        <text fg={toHex(theme().textMuted)}>{graphLabel()}</text>
      </box>
    </box>
  )
}

const plugin: TuiPlugin = async (api) => {
  api.slots.register({
    slots: {
      app_top: () => <View api={api} />,
    },
  })
}

export default { id, tui: plugin } satisfies BuiltinTuiPlugin
