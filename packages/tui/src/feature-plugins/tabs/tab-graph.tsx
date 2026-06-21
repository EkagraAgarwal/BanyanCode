/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createResource, For, Show } from "solid-js"
import { toHex } from "../../util/color"

const id = "internal:tabs-tab-graph"

interface GraphNode {
  id: string
  fileID: string
  kind: "file" | "function" | "class" | "method" | "type" | "variable"
  name: string
  signature?: string
  startLine: number
  endLine: number
  code?: string
}

interface GraphMeta {
  graphBuiltAt: number
  graphVersion: number
  graphCoverage: number
  totalFiles: number
  totalNodes: number
  totalEdges: number
}

interface CodegraphNodesResult {
  nodes: GraphNode[]
  meta?: GraphMeta
  total: number
}

function formatAge(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  return `${d}d ago`
}

function NodeRow(props: { node: GraphNode; theme: any }) {
  return (
    <box flexDirection="row" gap={1} marginTop={1}>
      <text fg={toHex(props.theme.primary)} wrapMode="word" width={22}>
        {props.node.name}
      </text>
      <text fg={toHex(props.theme.textMuted)} wrapMode="word" width={10}>
        {props.node.kind}
      </text>
      <text fg={toHex(props.theme.textMuted)}>
        {props.node.startLine !== undefined ? `:${props.node.startLine}` : ""}
      </text>
      <Show when={props.node.signature}>
        <text fg={toHex(props.theme.textMuted)} wrapMode="word">
          {" "}
          {props.node.signature}
        </text>
      </Show>
    </box>
  )
}

function MetaHeader(props: { meta: GraphMeta; theme: any }) {
  const m = props.meta
  const builtAt = m.graphBuiltAt ? new Date(m.graphBuiltAt).toLocaleString("en-US", { hour12: false }) : "—"
  const coverage = Math.round(m.graphCoverage * 100)
  return (
    <box marginBottom={1}>
      <box flexDirection="row" gap={1} justifyContent="space-between" width="100%">
        <text fg={toHex(props.theme.text)}>
          <b>Codegraph Nodes</b>
        </text>
        <text fg={toHex(props.theme.textMuted)}>v{m.graphVersion} · {builtAt}</text>
      </box>
      <text fg={toHex(props.theme.textMuted)}>
        Coverage {coverage}% · {m.totalNodes.toLocaleString()} nodes · {m.totalEdges.toLocaleString()} edges
      </text>
      <text fg={toHex(props.theme.borderSubtle)}>────────────────────────────────</text>
    </box>
  )
}

function View(props: { api: TuiPluginApi }) {
  const theme = () => props.api.theme.current

  const [result] = createResource<CodegraphNodesResult, Error>(async () => {
    const data = await (props.api.client as any).global.codegraphNodes()
    return data.data as CodegraphNodesResult
  })

  const groupedNodes = () => {
    const nodes = result()?.nodes ?? []
    const groups: Record<string, GraphNode[]> = {}
    for (const node of nodes) {
      if (!groups[node.kind]) groups[node.kind] = []
      groups[node.kind].push(node)
    }
    return groups
  }

  const kindLabel: Record<string, string> = {
    function: "Functions",
    class: "Classes",
    method: "Methods",
    type: "Types",
    variable: "Variables",
    file: "Files",
  }

  const kindOrder = ["function", "class", "method", "type", "variable", "file"]

  return (
    <scrollbox flexGrow={1} verticalScrollbarOptions={{ visible: true, paddingLeft: 1 }}>
      <box flexDirection="column" paddingTop={1} paddingLeft={1}>
        <Show when={result.loading}>
          <text fg={toHex(theme().textMuted)}>Loading...</text>
        </Show>

        <Show when={result.error}>
          <text fg={toHex(theme().error)}>Failed to load codegraph</text>
        </Show>

        <Show when={result() && !result.loading}>
          <Show when={result()!.meta}>
            <MetaHeader meta={result()!.meta!} theme={theme()} />
          </Show>

          <Show when={result()!.nodes.length === 0}>
            <text fg={toHex(theme().textMuted)}>No nodes indexed. Build the codegraph first.</text>
          </Show>

          <Show when={result()!.nodes.length > 0}>
            <For each={kindOrder}>
              {(kind) => {
                const nodes = () => groupedNodes()[kind] ?? []
                return (
                  <Show when={nodes().length > 0}>
                    <text fg={toHex(theme().text)} marginTop={1}>
                      <b>{kindLabel[kind] ?? kind} ({nodes().length})</b>
                    </text>
                    <For each={nodes()}>
                      {(node) => <NodeRow node={node} theme={theme()} />}
                    </For>
                  </Show>
                )
              }}
            </For>
          </Show>
        </Show>
      </box>
    </scrollbox>
  )
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
