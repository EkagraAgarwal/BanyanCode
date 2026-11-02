import type { Context } from "@opencode/plugin/tui/context"
import { createMemo, For, onCleanup, onMount, Show } from "solid-js"
import type { CodegraphLive, UsageLive } from "../../data/live"
import { GRAPH_FAMILY } from "../../data/usage"
import { palette } from "../../theme"

const MAX_ROWS = 8

/**
 * Ported from v1 `sidebar/tool-usage.tsx`: at most 8 single-line rows, plus a
 * one-line graph-adoption summary. The sidebar wrapper owns the inter-plugin
 * gap, so every row here is gap-free.
 */
export function ToolUsagePanel(props: {
  readonly context: Context
  readonly usage: UsageLive
  readonly codegraph: CodegraphLive
}) {
  const theme = () => palette(props.context.theme)

  onMount(() => {
    void props.usage.refreshTools()
  })
  onCleanup(props.context.data.on("session.step.ended", () => void props.usage.refreshTools()))

  const rows = createMemo(() => props.usage.tools() ?? [])
  const visible = createMemo(() => rows().slice(0, MAX_ROWS))
  const available = createMemo(() => props.usage.toolsAvailability())

  const graphFamily = createMemo(() => rows().filter((row) => GRAPH_FAMILY.has(row.toolId)))
  const totalCalls = createMemo(() => graphFamily().reduce((sum, row) => sum + row.useCount, 0))

  const summary = createMemo(() => {
    const files = props.codegraph.meta()?.totalFiles ?? props.codegraph.readiness()?.totalFiles
    const firstUse = graphFamily().length === 0
      ? undefined
      : Math.max(0, Math.round(Date.now() / 1000 - Math.min(...graphFamily().map((row) => row.lastUsedAt))))
    if (files === undefined && firstUse === undefined) return undefined
    const parts: string[] = []
    if (files !== undefined) parts.push(`graph ${files} sym`)
    if (totalCalls() > 0) parts.push(`${totalCalls()} calls`)
    if (firstUse !== undefined) parts.push(`first use ${firstUse}s`)
    return parts.join(" · ")
  })

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
          <Show when={summary()}>{(value) => <text fg={theme().muted}>{value()}</text>}</Show>
          <text fg={theme().primary}>
            <b>TOOL USAGE</b>
          </text>
          <For each={visible()}>
            {(row) => (
              <box flexDirection="row" gap={1} justifyContent="space-between" width="100%">
                <text fg={theme().muted}>{row.toolId}</text>
                <text fg={theme().text}>{row.useCount}</text>
              </box>
            )}
          </For>
        </box>
      </Show>
    </Show>
  )
}
