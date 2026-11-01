import type { Context } from "@opencode/plugin/tui/context"
import { createMemo, createSignal, For, onMount, Show } from "solid-js"
import { focusGraph, nodeLocation } from "../../data/graph"
import type { CodegraphLive } from "../../data/live"
import type { CodegraphNode } from "../../data/pending-rpc"
import { palette } from "../../theme"

type Layer = "L0" | "L1" | "L2" | "L3"

const LAYERS: readonly { readonly name: Layer; readonly description: string }[] = [
  { name: "L0", description: "Symbol" },
  { name: "L1", description: "Callers" },
  { name: "L2", description: "Impact" },
  { name: "L3", description: "Dependents" },
]

interface Row {
  readonly connector: string
  readonly node: CodegraphNode
  readonly annotation?: string
}

/**
 * Ported from v1 `inspector/graph-explorer.tsx` (module-only in v1; parity
 * 7b). Layers come from the live codegraph snapshot; the most-connected
 * symbol is the focus.
 */
export function GraphExplorer(props: { readonly context: Context; readonly codegraph: CodegraphLive }) {
  const theme = () => palette(props.context.theme)
  const [layer, setLayer] = createSignal<Layer>("L0")

  onMount(() => {
    void props.codegraph.ensureGraph()
  })

  const focused = createMemo(() => {
    const graph = props.codegraph.graph()
    return focusGraph(graph?.nodes ?? [], graph?.edges ?? [])
  })

  const rows = createMemo<Row[]>(() => {
    const focus = focused()
    if (!focus) return []
    const head: Row = { connector: "", node: focus.root, annotation: "(current)" }
    if (layer() === "L0") return [head]
    const children =
      layer() === "L1" ? focus.callers : layer() === "L3" ? focus.dependents : focus.dependents
    const out: Row[] = [head]
    children.slice(0, 8).forEach((child, index) => {
      const last = index === Math.min(children.length, 8) - 1
      out.push({ connector: last ? "└─ " : "├─ ", node: child, annotation: nodeLocation(child) })
      if (layer() === "L2") {
        const grandchildren = (props.codegraph.graph()?.edges ?? [])
          .filter((edge) => edge.fromNodeID === child.id)
          .slice(0, 3)
          .flatMap((edge) => props.codegraph.graph()?.nodes.find((node) => node.id === edge.toNodeID) ?? [])
        grandchildren.forEach((grandchild, grandIndex) => {
          const grandLast = grandIndex === grandchildren.length - 1
          out.push({
            connector: `${last ? "   " : "│  "}${grandLast ? "└─ " : "├─ "}`,
            node: grandchild,
            annotation: nodeLocation(grandchild),
          })
        })
      }
    })
    return out
  })

  const kindColor = (kind: string) => {
    if (kind === "class") return theme().primary
    if (kind === "type") return theme().warning
    if (kind === "method") return theme().info
    return theme().success
  }

  return (
    <box>
      <text fg={theme().text} marginBottom={1}>
        GRAPH EXPLORER
      </text>
      <box flexDirection="row" gap={1} marginBottom={1}>
        <For each={LAYERS}>
          {(item) => (
            <box
              onMouseDown={() => setLayer(item.name)}
              paddingLeft={1}
              paddingRight={1}
              border={layer() === item.name ? ["bottom"] : []}
              borderColor={layer() === item.name ? theme().primary : theme().border}
            >
              <text fg={layer() === item.name ? theme().primary : theme().muted}>
                {item.name} {item.description}
              </text>
            </box>
          )}
        </For>
      </box>
      <Show
        when={rows().length > 0}
        fallback={
          <Show
            when={props.codegraph.graphLoading()}
            fallback={
              <Show
                when={props.codegraph.availability() === "unavailable"}
                fallback={
                  <box flexDirection="column" paddingLeft={2} gap={0}>
                    <box flexDirection="row" gap={1} alignItems="center">
                      <text fg={theme().muted}>∅</text>
                      <text fg={theme().text}>Graph not built</text>
                    </box>
                    <text fg={theme().muted}>Run /codegraph-build to index this workspace.</text>
                  </box>
                }
              >
                <box paddingLeft={2}>
                  <text fg={theme().muted}>Codegraph RPC is not available on this server.</text>
                </box>
              </Show>
            }
          >
            <box flexDirection="row" gap={1} alignItems="center" paddingLeft={2}>
              <text fg={theme().primary}>◌</text>
              <text fg={theme().muted}>Loading graph…</text>
            </box>
          </Show>
        }
      >
        <box gap={0}>
          <For each={rows()}>
            {(row) => (
              <box flexDirection="row" gap={0}>
                <text fg={theme().muted}>{row.connector}</text>
                <text fg={kindColor(row.node.kind)}>●</text>
                <text fg={theme().text}> {row.node.name}</text>
                <Show when={row.annotation}>
                  <text fg={theme().muted}> {row.annotation}</text>
                </Show>
              </box>
            )}
          </For>
        </box>
      </Show>
      <box flexDirection="row" gap={1} marginTop={0}>
        <text fg={theme().muted}>L0 symbol · L1 callers · L2 impact · L3 dependents</text>
      </box>
    </box>
  )
}
