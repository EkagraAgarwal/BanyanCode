import type { Context } from "@opencode/plugin/tui/context"
import type { BoxRenderable } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { createEffect, createMemo, createSignal, For, onMount, Show } from "solid-js"
import type { CodegraphEdge, CodegraphNode } from "../../data/pending-rpc"
import { computeLayout, renderEdgeCanvas, type LayoutEdge, type LayoutNode } from "../../data/graph-layout"
import type { CodegraphLive } from "../../data/live"
import { palette, type Palette } from "../../theme"

const LAYERS = ["L0", "L1", "L2", "L3"] as const
type Layer = (typeof LAYERS)[number]

const LAYER_LABEL: Record<Layer, string> = {
  L0: "Symbol",
  L1: "Callers",
  L2: "Impact",
  L3: "Dependents",
}

// Beyond this many nodes the force layout turns to soup in a terminal, so the
// v1 tab fell back to a scrollable list. Same threshold here.
const MAX_GRAPH_NODES = 60

function kindColor(kind: string, theme: Palette) {
  if (kind === "class") return theme.primary
  if (kind === "type") return theme.warning
  if (kind === "method") return theme.info
  return theme.success
}

/**
 * Ported from v1 `feature-plugins/tabs/tab-graph.tsx`. v1 registered this on a
 * `session_tab_graph` slot the session route never rendered, so the canvas was
 * dead code; v2 exposes it as a first-class panel view.
 */
export function CodegraphCanvas(props: { readonly context: Context; readonly codegraph: CodegraphLive }) {
  const theme = () => palette(props.context.theme)
  const dimensions = useTerminalDimensions()
  const [layer, setLayer] = createSignal<Layer>("L1")
  const [focusedId, setFocusedId] = createSignal<string | null>(null)
  const [container, setContainer] = createSignal({ width: 0, height: 0 })

  onMount(() => {
    void props.codegraph.ensureGraph()
  })

  const nodes = createMemo<readonly CodegraphNode[]>(() => props.codegraph.graph()?.nodes ?? [])
  const edges = createMemo<readonly CodegraphEdge[]>(() => props.codegraph.graph()?.edges ?? [])

  const index = createMemo(() => {
    const byID = new Map(nodes().map((node) => [node.id, node]))
    const inbound = new Map<string, CodegraphEdge[]>()
    const outbound = new Map<string, CodegraphEdge[]>()
    const degree = new Map<string, number>()
    const push = (map: Map<string, CodegraphEdge[]>, key: string, edge: CodegraphEdge) => {
      const list = map.get(key)
      if (list) list.push(edge)
      else map.set(key, [edge])
    }
    for (const edge of edges()) {
      if (!byID.has(edge.fromNodeID) || !byID.has(edge.toNodeID)) continue
      push(inbound, edge.toNodeID, edge)
      push(outbound, edge.fromNodeID, edge)
      degree.set(edge.fromNodeID, (degree.get(edge.fromNodeID) ?? 0) + 1)
      degree.set(edge.toNodeID, (degree.get(edge.toNodeID) ?? 0) + 1)
    }
    return { byID, inbound, outbound, degree }
  })

  // Default focus to the most-connected node so the first frame is meaningful.
  createEffect(() => {
    const current = focusedId()
    if (current !== null && index().byID.has(current)) return
    const all = nodes()
    if (all.length === 0) return
    const best = all.reduce((acc, node) =>
      (index().degree.get(node.id) ?? 0) > (index().degree.get(acc.id) ?? 0) ? node : acc,
    )
    setFocusedId(best.id)
  })

  const selected = createMemo<ReadonlySet<string>>(() => {
    const focus = focusedId()
    const { byID, inbound, outbound } = index()
    if (focus === null || !byID.has(focus)) return new Set<string>()
    const walk = (start: string, direction: "up" | "down", depth: number) => {
      const visited = new Set<string>()
      const queue: Array<{ id: string; depth: number }> = [{ id: start, depth: 0 }]
      while (queue.length > 0) {
        const current = queue.shift()!
        if (visited.has(current.id) || current.depth > depth) continue
        visited.add(current.id)
        const next =
          direction === "up"
            ? (inbound.get(current.id) ?? []).map((edge) => edge.fromNodeID)
            : (outbound.get(current.id) ?? []).map((edge) => edge.toNodeID)
        for (const id of next) if (!visited.has(id)) queue.push({ id, depth: current.depth + 1 })
      }
      visited.delete(start)
      return visited
    }
    const set = new Set<string>([focus])
    if (layer() === "L1") {
      for (const edge of inbound.get(focus) ?? []) {
        if (edge.kind === "calls" || edge.kind === "references") set.add(edge.fromNodeID)
      }
    }
    if (layer() === "L3") {
      for (const edge of outbound.get(focus) ?? []) set.add(edge.toNodeID)
    }
    if (layer() === "L2") {
      for (const edge of outbound.get(focus) ?? []) set.add(edge.toNodeID)
      for (const id of walk(focus, "down", 3)) set.add(id)
      for (const id of walk(focus, "up", 3)) set.add(id)
    }
    return set
  })

  const visible = createMemo(() => {
    const ids = selected()
    const visibleNodes = nodes().filter((node) => ids.has(node.id))
    const visibleEdges = edges().filter((edge) => ids.has(edge.fromNodeID) && ids.has(edge.toNodeID))
    return { nodes: visibleNodes, edges: visibleEdges }
  })

  const graphDimensions = createMemo(() => {
    const measured = container()
    const fallbackWidth = Math.max(40, Math.min(160, dimensions().width - 4))
    const fallbackHeight = Math.max(10, dimensions().height - 22)
    return {
      width: Math.max(20, measured.width > 0 ? measured.width : fallbackWidth),
      height: Math.max(8, measured.height > 0 ? measured.height : fallbackHeight),
    }
  })

  const positioned = createMemo(() => {
    const value = visible()
    const { width, height } = graphDimensions()
    if (value.nodes.length === 0 || value.nodes.length > MAX_GRAPH_NODES) {
      return { nodes: [] as LayoutNode[], edges: [] as LayoutEdge[] }
    }
    const layoutNodes: LayoutNode[] = value.nodes.map((node) => ({
      id: node.id,
      name: node.name,
      kind: node.kind,
      file: node.fileID,
      line: node.startLine,
    }))
    const layoutEdges: LayoutEdge[] = value.edges.map((edge) => ({
      source: edge.fromNodeID,
      target: edge.toNodeID,
      kind: edge.kind,
    }))
    return {
      nodes: computeLayout(layoutNodes, layoutEdges, width, height, focusedId() ?? undefined),
      edges: layoutEdges,
    }
  })

  const canvas = createMemo(() => {
    const value = positioned()
    if (value.nodes.length === 0) return [] as string[]
    const { width, height } = graphDimensions()
    return renderEdgeCanvas(value.nodes, value.edges, width, height)
  })

  const focused = createMemo(() => {
    const id = focusedId()
    return id === null ? undefined : index().byID.get(id)
  })

  const header = createMemo(() => {
    const meta = props.codegraph.meta()
    if (!meta) return undefined
    return `v${meta.graphVersion} · ${meta.totalNodes} nodes · ${meta.totalEdges} edges`
  })

  const syncContainer = (node: BoxRenderable) => {
    if (node.width === container().width && node.height === container().height) return
    setContainer({ width: node.width, height: node.height })
  }

  const kindOf = (id: string) => index().byID.get(id)?.kind ?? "function"

  return (
    <box flexDirection="column" flexGrow={1} minHeight={0}>
      <box flexDirection="row" gap={1}>
        <text fg={theme().text}>
          <b>Codegraph</b>
        </text>
        <Show when={header()}>
          <text fg={theme().muted}>{header()}</text>
        </Show>
      </box>

      <box flexDirection="row" gap={1} marginTop={1}>
        <For each={LAYERS}>
          {(item) => (
            <text
              fg={layer() === item ? theme().primary : theme().muted}
              onMouseUp={() => setLayer(item)}
            >
              {`[${layer() === item ? "●" : "○"} ${item} ${LAYER_LABEL[item]}]`}
            </text>
          )}
        </For>
      </box>

      <Show
        when={props.codegraph.graph() !== undefined}
        fallback={
          <Show
            when={props.codegraph.availability() === "unavailable"}
            fallback={
              <box flexDirection="row" gap={2} paddingTop={2} alignItems="center">
                <text fg={theme().primary}>◌</text>
                <text fg={theme().muted}>Loading graph…</text>
              </box>
            }
          >
            <box paddingTop={2}>
              <text fg={theme().muted}>Codegraph RPC is not available on this server.</text>
            </box>
          </Show>
        }
      >
        <Show
          when={visible().nodes.length > 0}
          fallback={
            <box flexDirection="column" gap={1} paddingTop={2}>
              <box flexDirection="row" gap={2} alignItems="center">
                <text fg={theme().muted}>∅</text>
                <text fg={theme().text}>No nodes for this layer</text>
              </box>
              <box paddingLeft={4}>
                <text fg={theme().muted}>
                  Try a different layer, or rebuild with <b>/codegraph-build</b>.
                </text>
              </box>
            </box>
          }
        >
          <Show when={visible().nodes.length > MAX_GRAPH_NODES}>
            <box flexDirection="column" marginTop={1}>
              <text fg={theme().muted}>{`${visible().nodes.length} nodes — showing list (too dense to plot)`}</text>
              <For each={visible().nodes.slice(0, 200)}>
                {(node) => (
                  <box flexDirection="row" gap={1} onMouseUp={() => setFocusedId(node.id)}>
                    <text fg={kindColor(node.kind, theme())}>{focusedId() === node.id ? "▶ ●" : "  ●"}</text>
                    <text fg={focusedId() === node.id ? theme().text : theme().muted}>{node.name}</text>
                    <text fg={theme().muted}>{node.kind}</text>
                  </box>
                )}
              </For>
            </box>
          </Show>

          <Show when={visible().nodes.length <= MAX_GRAPH_NODES}>
            <box
              ref={(node: BoxRenderable | undefined) => {
                if (!node) return
                syncContainer(node)
                node.onSizeChange = () => syncContainer(node)
              }}
              position="relative"
              width="100%"
              flexGrow={1}
              minHeight={20}
              marginTop={1}
            >
              <For each={canvas()}>
                {(row, index) => (
                  <text position="absolute" left={0} top={index()} fg={theme().borderSubtle}>
                    {row}
                  </text>
                )}
              </For>
              <For each={positioned().nodes}>
                {(node) => {
                  const x = Math.round(node.x ?? 0)
                  const y = Math.round(node.y ?? 0)
                  return (
                    <box
                      position="absolute"
                      left={x}
                      top={y}
                      onMouseUp={() => setFocusedId(node.id)}
                      border={focusedId() === node.id ? ["bottom"] : []}
                      borderColor={focusedId() === node.id ? theme().primary : undefined}
                    >
                      <text fg={kindColor(kindOf(node.id), theme())}>{`● ${truncate(node.name, 14)}`}</text>
                    </box>
                  )
                }}
              </For>
            </box>
          </Show>
        </Show>
      </Show>

      <Show when={focused()}>
        {(node) => (
          <box flexDirection="column" marginTop={1} paddingLeft={1}>
            <text fg={theme().text}>
              <b>{node().name}</b>
            </text>
            <text fg={theme().muted}>{node().kind}</text>
            <text fg={theme().muted}>{`${node().fileID}:${node().startLine}`}</text>
          </box>
        )}
      </Show>
    </box>
  )
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value
  return value.slice(0, max - 1) + "…"
}
