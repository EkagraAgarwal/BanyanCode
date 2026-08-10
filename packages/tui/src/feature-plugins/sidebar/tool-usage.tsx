/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createResource, For, Show } from "solid-js"
import { toHex } from "../../util/color"
import { useSDK } from "../../context/sdk"

const id = "internal:sidebar-tool-usage"

// Keep the widget compact per the sidebar-compact-spacing rule: at most 8
// single-line rows. The sidebar wrapper owns the inter-plugin gap.
const MAX_ROWS = 8

// Phase C (per-session adoption): the tool ids that count as "graph
// adoption" for the one-line summary. Everything in this set is a graph /
// repository intelligence tool surfaced by the adapted catalog.
const GRAPH_FAMILY = new Set([
  "codegraph_build",
  "codegraph_remove",
  "code_find",
  "repository_query",
  "repository_explain",
  "repository_impact",
  "repository_trace",
  "repository_tests",
  "blast_radius",
  "preflight",
  "safe_rename",
  "edit_plan",
  "banyan_tool_search",
  "banyan_test",
])

function View(props: { api: TuiPluginApi }) {
  const theme = () => props.api.theme.current
  const sdk = useSDK()

  // Fetch on mount. The endpoint returns an empty list when BanyanCode is
  // disabled and throws on older servers — both must render nothing (fail
  // silent), so any failure resolves the resource to `undefined`.
  const [usage] = createResource(async () => {
    try {
      const res = await sdk.client.global.toolUsage()
      return res.data?.tools ?? []
    } catch {
      return undefined
    }
  })

  // Phase C: graph adoption summary. Fetch only after the usage list has
  // resolved (and only when it is non-empty — on non-BanyanCode servers the
  // usage fetch fails, so the status call is skipped entirely). Fail-silent:
  // older servers without /global/codegraph-status resolve to undefined and
  // the "graph N sym" segment is omitted.
  const [graphStatus] = createResource(
    () => (usage()?.length ?? 0) > 0,
    async () => {
      try {
        const res = await sdk.client.global.codegraph.status({})
        return res.data
      } catch {
        return undefined
      }
    },
  )

  const rows = () => usage()?.slice(0, MAX_ROWS) ?? []

  const graphFamilyRows = () => (usage() ?? []).filter((row) => GRAPH_FAMILY.has(row.toolId))
  const totalCalls = () => graphFamilyRows().reduce((sum, row) => sum + Number(row.useCount), 0)
  const firstUseAgo = () => {
    const family = graphFamilyRows()
    if (family.length === 0) return undefined
    const minLastUsed = Math.min(...family.map((row) => Number(row.lastUsedAt)))
    return Math.max(0, Math.round(Date.now() / 1000 - minLastUsed))
  }
  const summaryLine = () => {
    const files = graphStatus()?.totalFiles
    const calls = totalCalls()
    const first = firstUseAgo()
    // No graph-family rows AND no graph status → nothing useful to say;
    // hide the line entirely (don't show "graph · 0 calls" on non-BanyanCode
    // servers).
    if (files === undefined && first === undefined) return undefined
    const parts: string[] = []
    if (files !== undefined) parts.push(`graph ${files} sym`)
    if (calls > 0) parts.push(`${calls} calls`)
    if (first !== undefined) parts.push(`first use ${first}s`)
    return parts.join(" · ")
  }

  return (
    <Show when={usage() !== undefined && usage()!.length > 0}>
      <box flexDirection="column" gap={0}>
        <Show when={summaryLine() !== undefined}>
          <text fg={toHex(theme().textMuted)} wrapMode="none">
            {summaryLine()}
          </text>
        </Show>
        <text fg={toHex(theme().primary)}>
          <b>TOOL USAGE</b>
        </text>
        <For each={rows()}>
          {(row) => (
            <box flexDirection="row" gap={1} justifyContent="space-between" width="100%">
              <text fg={toHex(theme().textMuted)} wrapMode="none">
                {row.toolId}
              </text>
              <text fg={toHex(theme().text)}>{row.useCount}</text>
            </box>
          )}
        </For>
      </box>
    </Show>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 158,
    slots: {
      sidebar_content() {
        return <View api={api} />
      },
    },
  })
}

const plugin: BuiltinTuiPlugin = {
  id,
  tui,
}

export default plugin
