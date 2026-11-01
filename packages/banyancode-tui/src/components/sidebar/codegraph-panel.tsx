import type { Context } from "@opencode/plugin/tui/context"
import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from "solid-js"
import { formatAge } from "../../data/format"
import { focusGraph, layerCounts } from "../../data/graph"
import type { CodegraphLive } from "../../data/live"
import type { GraphMeta } from "../../data/pending-rpc"
import { palette } from "../../theme"

const BAR_WIDTH = 20

function coverageBar(percent: number): string {
  const filled = Math.max(0, Math.min(BAR_WIDTH, Math.round((percent / 100) * BAR_WIDTH)))
  return "█".repeat(filled) + "░".repeat(BAR_WIDTH - filled)
}

/**
 * Ported from v1 `sidebar/codegraph-panel.tsx`. Renders L0–L3 layer counts
 * around the most-connected symbol plus the persisted graph overview.
 */
export function CodegraphPanel(props: { readonly context: Context; readonly codegraph: CodegraphLive }) {
  const theme = () => palette(props.context.theme)
  const [now, setNow] = createSignal(Date.now())

  const tick = setInterval(() => setNow(Date.now()), 30_000)
  onCleanup(() => clearInterval(tick))

  onMount(() => {
    void props.codegraph.ensureGraph()
  })

  createEffect(
    on(
      () => props.codegraph.build()?.status,
      (status) => {
        if (status === "completed") void props.codegraph.ensureGraph(true)
      },
    ),
  )

  const graph = createMemo(() => props.codegraph.graph())
  const nodes = createMemo(() => graph()?.nodes ?? [])
  const focused = createMemo(() => focusGraph(nodes(), graph()?.edges ?? []))
  const layers = createMemo(() => layerCounts(focused()))
  const loading = createMemo(() => props.codegraph.graphLoading() && graph() === undefined)
  const unavailable = createMemo(() => props.codegraph.availability() === "unavailable")

  const meta = createMemo<GraphMeta | undefined>(() => {
    const current = props.codegraph.meta()
    if (current) return current
    const readiness = props.codegraph.readiness()
    if (!readiness || readiness.reason === "missing") return undefined
    return {
      graphBuiltAt: readiness.graphBuiltAt ?? 0,
      graphVersion: readiness.graphVersion ?? 0,
      graphCoverage: readiness.graphCoverage ?? 0,
      totalFiles: readiness.totalFiles ?? 0,
      totalNodes: graph()?.nodes.length ?? 0,
      totalEdges: graph()?.edges.length ?? 0,
    }
  })

  const coveragePercent = createMemo(() => Math.round((meta()?.graphCoverage ?? 0) * 100))

  const coverageLabel = createMemo(() => {
    const current = meta()
    if (!current) return "Coverage —"
    const percent = Math.round(current.graphCoverage * 100)
    const covered = Math.round(current.totalFiles * current.graphCoverage)
    return `Coverage ${percent}% (${covered.toLocaleString()}/${current.totalFiles.toLocaleString()} files)`
  })

  const layerCount = (value: number | undefined) => (value === undefined ? "—" : value.toLocaleString())
  const dot = (layer: number) => {
    if (layer === 3) return theme().error
    if (layer === 2) return theme().warning
    if (layer === 1) return theme().success
    return theme().info
  }

  const rows = [
    { layer: 3, label: "L3 Dependents", value: () => layers()?.l3 },
    { layer: 2, label: "L2 Impact (Trans)", value: () => layers()?.l2 },
    { layer: 1, label: "L1 Callers (Direct)", value: () => layers()?.l1 },
    { layer: 0, label: "L0 Symbol (Current)", value: () => (layers() ? 1 : undefined) },
  ] as const

  return (
    <box>
      <text fg={theme().text}>
        <b>CODEGRAPH LAYERS</b>
      </text>

      <Show
        when={!unavailable()}
        fallback={
          <text fg={theme().muted} marginTop={0}>
            Codegraph RPC is not available on this server.
          </text>
        }
      >
        <Show
          when={!loading()}
          fallback={
            <text fg={theme().muted} marginTop={0}>
              Loading...
            </text>
          }
        >
          <Show
            when={meta() !== undefined}
            fallback={
              <box flexDirection="column" paddingLeft={2} paddingTop={0} gap={0}>
                <box flexDirection="row" gap={1} alignItems="center">
                  <text fg={theme().muted}>∅</text>
                  <text fg={theme().text}>Codegraph not built</text>
                </box>
                <box paddingLeft={2}>
                  <text fg={theme().muted}>Build the code graph with /codegraph-build to see layer counts and metrics.</text>
                </box>
              </box>
            }
          >
            <text fg={theme().muted} marginTop={0}>
              {layers() ? `Around ${layers()!.symbol}` : "No symbols indexed"}
            </text>
            <box marginTop={0} gap={0}>
              <For each={rows}>
                {(row) => (
                  <box flexDirection="row" justifyContent="space-between" width="100%">
                    <box flexDirection="row" gap={1}>
                      <text fg={dot(row.layer)}>●</text>
                      <text fg={theme().text}>{row.label}</text>
                    </box>
                    <text fg={theme().muted}>{layerCount(row.value())}</text>
                  </box>
                )}
              </For>
            </box>
            <text fg={theme().borderSubtle} marginTop={0}>
              ────────────────────────────────
            </text>
            <text fg={theme().text} marginTop={0}>
              <b>CODEGRAPH OVERVIEW</b>
            </text>
            <box marginTop={0} gap={0}>
              <box flexDirection="row" gap={1} justifyContent="space-between" width="100%">
                <text fg={theme().muted}>Version {meta()?.graphVersion ?? 0}</text>
                <text fg={theme().muted}>
                  Built {meta()?.graphBuiltAt ? formatAge(meta()!.graphBuiltAt, now()) : "—"}
                </text>
              </box>
              <text fg={theme().muted}>{coverageLabel()}</text>
              <text fg={theme().success}>{coverageBar(coveragePercent())}</text>
              <box flexDirection="row" gap={1} justifyContent="space-between" width="100%">
                <text fg={theme().muted}>Nodes {(meta()?.totalNodes ?? 0).toLocaleString()}</text>
                <text fg={theme().muted}>Edges {(meta()?.totalEdges ?? 0).toLocaleString()}</text>
              </box>
            </box>
          </Show>
        </Show>
      </Show>
    </box>
  )
}
