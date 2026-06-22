/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createResource, createMemo, createSignal, createEffect, For, Show, onCleanup } from "solid-js"
import type { BoxRenderable } from "@opentui/core"
import { useTheme } from "../../context/theme"
import { toHex } from "../../util/color"
import { computeLayout, renderEdgeCanvas, type LayoutNode, type LayoutEdge } from "../../util/graph-layout"
import { useEvent } from "../../context/event"
import { useTerminalDimensions } from "@opentui/solid"

const id = "internal:tabs-tab-graph"

interface GraphNode {
  id: string
  name: string
  kind: string
  fileID?: string
  startLine?: number
}

interface GraphEdge {
  source: string
  target: string
  kind: string
}

interface GraphData {
  nodes: GraphNode[]
  edges: GraphEdge[]
  meta?: {
    totalNodes: number
    totalEdges: number
    graphVersion: number
    graphBuiltAt: number
    graphCoverage?: number
    totalFiles?: number
  }
}

const COLORS = {
  file: "info",
  function: "success",
  class: "primary",
  method: "info",
  type: "warning",
  variable: "textMuted",
} as const

const LAYERS = ["L0", "L1", "L2", "L3"] as const
type Layer = (typeof LAYERS)[number]

const LAYER_LABEL: Record<Layer, string> = {
  L0: "Symbol",
  L1: "Callers",
  L2: "Impact",
  L3: "Dependents",
}

// Beyond this many nodes in the selected layer set the force layout becomes
// unreadable in a terminal, so we fall back to a scrollable flat list.
const MAX_GRAPH_NODES = 60

function View(props: { api: TuiPluginApi }) {
  const { theme } = useTheme()
  const [buildEpoch, setBuildEpoch] = createSignal(0)
  const ev = useEvent()

  const unsub = ev.on("banyancode.codegraph.build", (evt) => {
    if (evt.properties?.status === "completed") {
      setBuildEpoch((p) => p + 1)
    }
  })
  onCleanup(unsub)

  const [data] = createResource<GraphData, number>(buildEpoch, async () => {
    const [nodesResult, edgesResult] = await Promise.all([
      props.api.client.global.codegraph.nodes(),
      props.api.client.global.codegraph.edges({}),
    ])
    return {
      nodes: nodesResult.data!.nodes,
      meta: nodesResult.data!.meta,
      edges: edgesResult.data!.edges.map((e) => ({
        source: e.fromNodeID,
        target: e.toNodeID,
        kind: e.kind,
      })),
    } as GraphData
  })

  const [focusedId, setFocusedId] = createSignal<string | null>(null)
  const [layer, setLayer] = createSignal<Layer>("L1")

  const graph = createMemo(() => {
    const d = data()
    const nodes = d?.nodes ?? []
    const edges = d?.edges ?? []
    const nodeById = new Map(nodes.map((n) => [n.id, n]))
    const outAdj = new Map<string, GraphEdge[]>()
    const inAdj = new Map<string, GraphEdge[]>()
    const degree = new Map<string, number>()
    const push = (map: Map<string, GraphEdge[]>, key: string, edge: GraphEdge) => {
      const list = map.get(key)
      if (list) list.push(edge)
      else map.set(key, [edge])
    }
    for (const e of edges) {
      if (!nodeById.has(e.source) || !nodeById.has(e.target)) continue
      push(outAdj, e.source, e)
      push(inAdj, e.target, e)
      degree.set(e.source, (degree.get(e.source) ?? 0) + 1)
      degree.set(e.target, (degree.get(e.target) ?? 0) + 1)
    }
    return { nodes, edges, nodeById, outAdj, inAdj, degree }
  })

  // Default focus to the most-connected node so the initial view is meaningful.
  createEffect(() => {
    const g = graph()
    if (g.nodes.length === 0) return
    if (focusedId() && g.nodeById.has(focusedId()!)) return
    const best = g.nodes.reduce((acc, n) => ((g.degree.get(n.id) ?? 0) > (g.degree.get(acc.id) ?? 0) ? n : acc), g.nodes[0])
    setFocusedId(best.id)
  })

  // Replicates CodegraphAnalyzer.callers/dependents/impact over the fetched
  // edges so the L0-L3 selector filters to a real connected neighborhood.
  const selectedIds = createMemo(() => {
    const g = graph()
    const root = focusedId()
    if (!root || !g.nodeById.has(root)) return new Set<string>()

    const callers = (id: string) =>
      (g.inAdj.get(id) ?? []).filter((e) => e.kind === "calls" || e.kind === "references").map((e) => e.source)
    const dependents = (id: string) => (g.outAdj.get(id) ?? []).map((e) => e.target)

    const walk = (id: string, dir: "up" | "down", maxDepth: number) => {
      const visited = new Set<string>()
      const queue: { id: string; depth: number }[] = [{ id, depth: 0 }]
      while (queue.length) {
        const cur = queue.shift()!
        if (visited.has(cur.id) || cur.depth > maxDepth) continue
        visited.add(cur.id)
        const next = dir === "up" ? (g.inAdj.get(cur.id) ?? []).map((e) => e.source) : dependents(cur.id)
        for (const n of next) if (!visited.has(n)) queue.push({ id: n, depth: cur.depth + 1 })
      }
      visited.delete(id)
      return [...visited]
    }

    const set = new Set<string>([root])
    const layerNow = layer()
    if (layerNow === "L1") for (const n of callers(root)) set.add(n)
    if (layerNow === "L3") for (const n of dependents(root)) set.add(n)
    if (layerNow === "L2") {
      for (const n of dependents(root)) set.add(n)
      for (const n of walk(root, "down", 3)) set.add(n)
      for (const n of walk(root, "up", 3)) set.add(n)
    }
    return set
  })

  const visible = createMemo(() => {
    const g = graph()
    const ids = selectedIds()
    const nodes = g.nodes.filter((n) => ids.has(n.id))
    const edges = g.edges.filter((e) => ids.has(e.source) && ids.has(e.target))
    return { nodes, edges }
  })

  const dimensions = useTerminalDimensions()

  // Measure the actual graph container via ref instead of trusting the
  // terminal width — the graph lives inside the center column, which is
  // smaller than the terminal when sidebars are visible.
  const [containerSize, setContainerSize] = createSignal({ width: 0, height: 0 })
  const syncContainer = (r: BoxRenderable) => {
    if (r.width !== containerSize().width || r.height !== containerSize().height) {
      setContainerSize({ width: r.width, height: r.height })
    }
  }
  const captureContainer = (r: BoxRenderable) => {
    if (!r) return
    syncContainer(r)
    r.onSizeChange = () => syncContainer(r)
  }

  const graphDimensions = createMemo(() => {
    const measured = containerSize()
    const fallbackW = Math.max(40, Math.min(160, dimensions().width - 4))
    const fallbackH = Math.max(10, dimensions().height - 22)
    const W = measured.width > 0 ? measured.width : fallbackW
    const H = measured.height > 0 ? measured.height : fallbackH
    return { W: Math.max(20, W), H: Math.max(8, H) }
  })

  const positioned = createMemo(() => {
    const v = visible()
    if (v.nodes.length === 0 || v.nodes.length > MAX_GRAPH_NODES) return { nodes: [] as LayoutNode[], edges: [] as LayoutEdge[] }
    const { W, H } = graphDimensions()
    const layoutNodes: LayoutNode[] = v.nodes.map((n) => ({
      id: n.id,
      name: n.name,
      kind: n.kind,
      fileID: n.fileID,
      startLine: n.startLine,
      width: Math.min(n.name.length, 14) + 3,
    }))
    const layoutEdges: LayoutEdge[] = v.edges.map((e) => ({ source: e.source, target: e.target, kind: e.kind }))
    const nodes = computeLayout(layoutNodes, layoutEdges, W, H, focusedId() ?? undefined)
    return { nodes, edges: layoutEdges }
  })

  const edgeCanvas = createMemo(() => {
    const { nodes, edges } = positioned()
    if (nodes.length === 0) return [] as string[]
    const { W, H } = graphDimensions()
    return renderEdgeCanvas(nodes, edges, W, H)
  })

  const focusedNode = createMemo(() => {
    const id = focusedId()
    return id ? graph().nodeById.get(id) ?? null : null
  })

  return (
    <scrollbox flexGrow={1} verticalScrollbarOptions={{ visible: true, paddingLeft: 1 }}>
      <box flexDirection="column" paddingTop={1} width="100%">
        <Show when={data()?.meta}>
          <box flexDirection="row" gap={1}>
            <text fg={toHex(theme.text)}><b>Codegraph</b></text>
            <text fg={toHex(theme.textMuted)}>{`v${data()!.meta!.graphVersion} · ${data()!.meta!.totalNodes} nodes · ${data()!.meta!.totalEdges} edges`}</text>
          </box>
        </Show>

        {/* Layer selector */}
        <box flexDirection="row" gap={1} marginTop={1}>
          <For each={LAYERS}>
            {(l) => (
              <text
                fg={layer() === l ? toHex(theme.primary) : toHex(theme.textMuted)}
                onMouseUp={() => setLayer(l)}
              >
                {`[${layer() === l ? "●" : "○"} ${l} ${LAYER_LABEL[l]}]`}
              </text>
            )}
          </For>
        </box>

        <Show
          when={data()}
          fallback={<text fg={toHex(theme.textMuted)}>Loading graph...</text>}
        >
          <Show when={visible().nodes.length > 0} fallback={
            <text fg={toHex(theme.textMuted)} marginTop={1}>No nodes for this layer</text>
          }>
            {/* Flat-list fallback for large neighborhoods */}
            <Show when={visible().nodes.length > MAX_GRAPH_NODES}>
              <box flexDirection="column" marginTop={1}>
                <text fg={toHex(theme.textMuted)}>{`${visible().nodes.length} nodes — showing list (too dense to plot)`}</text>
                <For each={visible().nodes.slice(0, 200)}>
                  {(node) => {
                    const colorKey = COLORS[node.kind as keyof typeof COLORS] ?? "text"
                    const isFocused = () => focusedId() === node.id
                    return (
                      <box flexDirection="row" gap={1} onMouseUp={() => setFocusedId(node.id)}>
                        <text fg={toHex(theme[colorKey])}>{isFocused() ? "▶ ●" : "  ●"}</text>
                        <text fg={toHex(isFocused() ? theme.text : theme.textMuted)}>{node.name}</text>
                        <text fg={toHex(theme.textMuted)}>{node.kind}</text>
                      </box>
                    )
                  }}
                </For>
              </box>
            </Show>

            {/* Force-directed graph with drawn edges */}
            <Show when={visible().nodes.length <= MAX_GRAPH_NODES}>
              <box
                ref={captureContainer}
                position="relative"
                width="100%"
                flexGrow={1}
                minHeight={20}
                marginTop={1}
              >
                {/* Edge canvas underneath the node labels */}
                <For each={edgeCanvas()}>
                  {(row, i) => (
                    <text position="absolute" left={0} top={i()} fg={toHex(theme.borderSubtle)}>{row}</text>
                  )}
                </For>
                <For each={positioned().nodes}>
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
                        <text fg={toHex(theme[colorKey])}>{`● ${truncate(node.name, 14)}`}</text>
                      </box>
                    )
                  }}
                </For>
              </box>
            </Show>
          </Show>
        </Show>

        {/* Focused node detail */}
        <Show when={focusedNode()}>
          {(n) => (
            <box flexDirection="column" marginTop={1} paddingLeft={1}>
              <text fg={toHex(theme.text)}><b>{n().name}</b></text>
              <text fg={toHex(theme.textMuted)}>{n().kind}</text>
              <text fg={toHex(theme.textMuted)}>{`${n().fileID ?? ""}:${n().startLine ?? ""}`}</text>
            </box>
          )}
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
