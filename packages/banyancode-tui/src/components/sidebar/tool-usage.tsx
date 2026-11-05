import type { Context } from "@opencode/plugin/tui/context"
import { createMemo, For, onCleanup, onMount, Show } from "solid-js"
import type { CodegraphLive, UsageLive } from "../../data/live"
import { GRAPH_FAMILY, gatewayReplacedBy, gatewaySummaryLine } from "../../data/usage"
import { palette } from "../../theme"

const MAX_ROWS = 8

/**
 * Ported from v1 `sidebar/tool-usage.tsx`: at most 8 single-line rows, plus a
 * one-line graph-adoption summary and a gateway summary. Rows show the tool that
 * actually ran; a swapped call is counted once, on the tool that replaced it,
 * and linked back with `← from`. The sidebar wrapper owns the inter-plugin gap,
 * so every row here is gap-free.
 */
export function ToolUsagePanel(props: {
  readonly context: Context
  readonly usage: UsageLive
  readonly codegraph: CodegraphLive
  /** The session whose rows are shown; omitted means the lifetime rollup. */
  readonly sessionID?: string
}) {
  const theme = () => palette(props.context.theme)

  const refresh = () => {
    void props.usage.refreshTools(props.sessionID)
    void props.usage.refreshGateway(props.sessionID)
  }

  onMount(refresh)
  onCleanup(
    props.context.data.on("session.step.ended", (event) => {
      if (props.sessionID === undefined || event.data.sessionID === props.sessionID) refresh()
    }),
  )

  const rows = createMemo(() => props.usage.tools(props.sessionID) ?? [])
  const visible = createMemo(() => rows().slice(0, MAX_ROWS))
  const available = createMemo(() => props.usage.toolsAvailability())
  const gateway = createMemo(() => props.usage.gateway(props.sessionID))

  const graphFamily = createMemo(() => rows().filter((row) => GRAPH_FAMILY.has(row.toolId)))
  const totalCalls = createMemo(() => graphFamily().reduce((sum, row) => sum + row.useCount, 0))

  const summary = createMemo(() => {
    const files = props.codegraph.meta()?.totalFiles ?? props.codegraph.readiness()?.totalFiles
    const firstUse = graphFamily().length === 0
      ? undefined
      : Math.max(0, Math.round(Date.now() / 1000 - Math.min(...graphFamily().map((row) => row.lastUsedAt))))
    if (files === undefined && firstUse === undefined) return undefined
    const parts: string[] = []
    if (files !== undefined) parts.push(`graph ${files} files`)
    if (totalCalls() > 0) parts.push(`${totalCalls()} calls`)
    if (firstUse !== undefined) parts.push(`first use ${firstUse}s`)
    return parts.join(" · ")
  })

  const gatewayLine = createMemo(() => gatewaySummaryLine(gateway()?.summary))

  return (
    <Show when={available() !== "unavailable"}>
      <Show
        when={rows().length > 0}
        fallback={
          <Show when={available() === "unavailable"}>
            <text fg={theme().muted}>Tool usage: RPC not available</text>
          </Show>
        }
      >
        <box flexDirection="column" gap={0}>
          <text fg={theme().primary}>
            <b>TOOL USAGE</b>
          </text>
          <Show when={summary()}>{(value) => <text fg={theme().muted}>{value()}</text>}</Show>
          <Show when={gatewayLine()}>{(value) => <text fg={theme().muted} wrapMode="word">{value()}</text>}</Show>
          <For each={visible()}>
            {(row) => {
              const replaced = createMemo(() => gatewayReplacedBy(row.toolId, gateway()?.rows))
              return (
                <box flexDirection="row" gap={1} justifyContent="space-between" width="100%">
                  <box flexDirection="row" gap={1} minWidth={0} flexGrow={1}>
                    <text fg={theme().muted}>{row.toolId}</text>
                    <Show when={replaced()}>{(value) => <text fg={theme().faint}>{value()}</text>}</Show>
                  </box>
                  <text fg={theme().text} flexShrink={0}>
                    {row.useCount}
                  </text>
                </box>
              )
            }}
          </For>
        </box>
      </Show>
    </Show>
  )
}
