/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createResource, createMemo, createSignal, For, Show } from "solid-js"
import { useTheme } from "../../context/theme"
import { toHex } from "../../util/color"
import { computeLayout, type LayoutNode, type LayoutEdge } from "../../util/graph-layout"

const id = "internal:tabs-tab-graph"

interface GraphNode {
  id: string
  name: string
  kind: string
  file?: string
  line?: number
}

interface GraphData {
  nodes: GraphNode[]
  meta?: { totalNodes: number; totalEdges: number; graphVersion: number; graphBuiltAt: number }
}

const COLORS = {
  file: "info",
  function: "success",
  class: "primary",
  method: "info",
  type: "warning",
  variable: "textMuted",
} as const

function View(props: { api: TuiPluginApi }) {
  const { theme } = useTheme()
  const [data] = createResource<GraphData>(async () => {
    const result = await (props.api.client as any).global?.codegraphNodes?.({})
    return result?.data as GraphData
  })

  const [focusedId, setFocusedId] = createSignal<string | null>(null)
  const [layer, setLayer] = createSignal<"L0" | "L1" | "L2" | "L3">("L0")

  const layout = createMemo(() => {
    const d = data()
    if (!d) return { nodes: [] as LayoutNode[], edges: [] as LayoutEdge[] }

    // Limit to ~50 nodes for performance
    const subset = d.nodes.slice(0, 50)
    const subsetIds = new Set(subset.map((n) => n.id))

    // Filter edges to within subset
    const edges: LayoutEdge[] = []
    const ids = new Set<string>()
    subset.forEach((n) => ids.add(n.id))

    return {
      nodes: subset.map((n) => ({
        id: n.id,
        name: n.name,
        kind: n.kind,
        file: n.file,
        line: n.line,
      })),
      edges,
    }
  })

  const positioned = createMemo(() => {
    const { nodes, edges } = layout()
    const W = 80, H = 24
    const pos = computeLayout(nodes, edges, W, H, focusedId() ?? undefined)
    return pos
  })

  return (
    <scrollbox flexGrow={1} verticalScrollbarOptions={{ visible: true, paddingLeft: 1 }}>
      <box flexDirection="column" paddingTop={1}>
        {/* Header with meta */}
        <Show when={data()?.meta}>
          <text fg={toHex(theme.text)}>
            <b>Codegraph</b>
            {" "}
            <text fg={toHex(theme.textMuted)}>
              v{data()!.meta!.graphVersion} · {data()!.meta!.totalNodes} nodes · {data()!.meta!.totalEdges} edges
            </text>
          </text>
        </Show>

        {/* Layer selector */}
        <box flexDirection="row" gap={1} marginTop={1}>
          <For each={["L0", "L1", "L2", "L3"] as const}>
            {(l) => (
              <text
                fg={layer() === l ? toHex(theme.primary) : toHex(theme.textMuted)}
                onMouseUp={() => setLayer(l)}
              >
                [{layer() === l ? "● " : "○ "}{l}]
              </text>
            )}
          </For>
        </box>

        {/* Force-directed graph */}
        <Show
          when={data()}
          fallback={<text fg={toHex(theme.textMuted)}>Loading graph...</text>}
        >
          <Show when={positioned().length > 0} fallback={
            <text fg={toHex(theme.textMuted)}>No nodes indexed</text>
          }>
            {/* Render nodes at computed positions */}
            <box position="relative" width={80} height={24} marginTop={1}>
              <For each={positioned()}>
                {(node) => {
                  const x = Math.round(node.x ?? 0)
                  const y = Math.round(node.y ?? 0)
                  const isFocused = () => focusedId() === node.id
                  const colorKey = COLORS[node.kind as keyof typeof COLORS] ?? "text"
                  return (
                    <box
                      position="absolute"
                      left={x}
                      top={y}
                      onMouseUp={() => setFocusedId(node.id)}
                      border={isFocused() ? ["bottom"] : []}
                      borderColor={isFocused() ? toHex(theme.primary) : undefined}
                    >
                      <text fg={toHex(theme[colorKey])}>● {truncate(node.name, 14)}</text>
                    </box>
                  )
                }}
              </For>
            </box>
          </Show>
        </Show>

        {/* Focused node detail */}
        <Show when={focusedId()}>
          {(_) => {
            const node = positioned().find((n) => n.id === focusedId())
            return (
              <box flexDirection="column" marginTop={1} paddingLeft={1}>
                <text fg={toHex(theme.text)}><b>{node?.name}</b></text>
                <text fg={toHex(theme.textMuted)}>{node?.kind}</text>
                <text fg={toHex(theme.textMuted)}>{node?.file}:{node?.line}</text>
              </box>
            )
          }}
        </Show>
      </box>
    </scrollbox>
  )
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 20,
    slots: {
      session_tab_graph() {
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
