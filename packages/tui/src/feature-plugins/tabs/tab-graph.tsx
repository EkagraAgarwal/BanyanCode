import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createSignal, For, onMount } from "solid-js"

const id = "internal:tabs-tab-graph"

interface GraphNode {
  id: string
  name: string
  kind: string
  file?: string
  line?: number
}

function toHex(color: { r: number; g: number; b: number; a?: number } | string): string {
  if (typeof color === "string") return color
  const a = color.a !== undefined ? Math.round(color.a * 255).toString(16).padStart(2, "0") : ""
  return `#${color.r.toString(16).padStart(2, "0")}${color.g.toString(16).padStart(2, "0")}${color.b.toString(16).padStart(2, "0")}${a}`
}

function View(props: { api: TuiPluginApi }) {
  const theme = () => props.api.theme.current
  const [nodes, setNodes] = createSignal<GraphNode[]>([])
  const [loading, setLoading] = createSignal(true)

  onMount(async () => {
    try {
      // (api.client as any).codegraph?.nodes?.list() — use as any until SDK is regenerated
      const result = await (props.api.client as any).codegraph?.nodes?.list?.({})
      if (result?.data) {
        setNodes(result.data as GraphNode[])
      }
    } catch {
      // stub — no codegraph nodes API yet
    } finally {
      setLoading(false)
    }
  })

  return (
    <scrollbox flexGrow={1} verticalScrollbarOptions={{ visible: true, paddingLeft: 1 }}>
      <box flexDirection="column" paddingTop={1}>
        <text fg={toHex(theme().text)}>
          <b>Codegraph Nodes</b>
        </text>
        {loading() ? (
          <text fg={toHex(theme().textMuted)}>Loading...</text>
        ) : nodes().length === 0 ? (
          <text fg={toHex(theme().textMuted)}>No nodes indexed. Build the codegraph first.</text>
        ) : (
          <For each={nodes()}>
            {(node) => (
              <box flexDirection="row" gap={2} marginTop={1}>
                <text fg={toHex(theme().primary)} wrapMode="word" width={20}>
                  {node.name}
                </text>
                <text fg={toHex(theme().textMuted)} wrapMode="word" width={10}>
                  {node.kind}
                </text>
                <text fg={toHex(theme().textMuted)}>
                  {node.file ?? "—"}
                  {node.line !== undefined ? `:${node.line}` : ""}
                </text>
              </box>
            )}
          </For>
        )}
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
