/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createMemo, createResource, createSignal, createEffect, For, Show, onCleanup } from "solid-js"
import { useEvent } from "../../context/event"

const id = "internal:inspector-graph-explorer"

import { toHex } from "../../util/color"

interface Sym {
  id: string
  name: string
  kind: string
  fileID?: string
  startLine?: number
}

interface Edge {
  source: string
  target: string
  kind: string
}

interface TreeRow {
  connector: string
  name: string
  annotation?: string
  kind: string
}

function View(props: { api: TuiPluginApi; sessionID: string }) {
  const theme = () => props.api.theme.current
  const [activeLayer, setActiveLayer] = createSignal("L0")
  const [focusedId, setFocusedId] = createSignal<string | null>(null)
  const [buildEpoch, setBuildEpoch] = createSignal(0)

  const   ev = useEvent()
  const unsub = ev.on("banyancode.codegraph.build", (evt) => {
    if (evt.properties?.status === "completed") setBuildEpoch((p) => p + 1)
  })
  onCleanup(unsub)

  const [data] = createResource(buildEpoch, async () => {
    const [nodesResult, edgesResult] = await Promise.all([
      props.api.client.global.codegraph.nodes(),
      props.api.client.global.codegraph.edges({}),
    ])
    const nodes: Sym[] = (nodesResult.data?.nodes ?? []).map((n) => ({
      id: n.id,
      name: n.name,
      kind: n.kind,
      fileID: n.fileID,
      startLine: Number(n.startLine),
    }))
    const edges: Edge[] = (edgesResult.data?.edges ?? []).map((e: any) => ({
      source: e.fromNodeID,
      target: e.toNodeID,
      kind: e.kind,
    }))
    return { nodes, edges }
  })

  const graph = createMemo(() => {
    const nodes = data()?.nodes ?? []
    const edges = data()?.edges ?? []
    const nodeById = new Map(nodes.map((n) => [n.id, n]))
    const outAdj = new Map<string, Edge[]>()
    const inAdj = new Map<string, Edge[]>()
    const degree = new Map<string, number>()
    const push = (map: Map<string, Edge[]>, key: string, edge: Edge) => {
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
    return { nodes, nodeById, outAdj, inAdj, degree }
  })

  createEffect(() => {
    const g = graph()
    if (g.nodes.length === 0) return
    if (focusedId() && g.nodeById.has(focusedId()!)) return
    const best = g.nodes.reduce((acc, n) => ((g.degree.get(n.id) ?? 0) > (g.degree.get(acc.id) ?? 0) ? n : acc), g.nodes[0])
    setFocusedId(best.id)
  })

  const callers = (gid: string) => {
    const g = graph()
    return (g.inAdj.get(gid) ?? [])
      .filter((e) => e.kind === "calls" || e.kind === "references")
      .map((e) => g.nodeById.get(e.source))
      .filter((n): n is Sym => Boolean(n))
  }
  const dependents = (gid: string) => {
    const g = graph()
    return (g.outAdj.get(gid) ?? []).map((e) => g.nodeById.get(e.target)).filter((n): n is Sym => Boolean(n))
  }

  const annotate = (n: Sym) => (n.startLine ? `:${n.startLine}` : "")

  const rows = createMemo<TreeRow[]>(() => {
    const g = graph()
    const root = focusedId() ? g.nodeById.get(focusedId()!) : undefined
    if (!root) return []
    const layer = activeLayer()
    const head: TreeRow = { connector: "", name: root.name, annotation: "(current)", kind: root.kind }
    if (layer === "L0") return [head]

    const children =
      layer === "L1" ? callers(root.id) : layer === "L3" ? dependents(root.id) : dependents(root.id)
    const out: TreeRow[] = [head]
    children.slice(0, 8).forEach((child, i) => {
      const last = i === Math.min(children.length, 8) - 1
      out.push({ connector: last ? "└─ " : "├─ ", name: child.name, annotation: annotate(child), kind: child.kind })
      // L2 shows one transitive level of impact below each direct dependent.
      if (layer === "L2") {
        const grand = dependents(child.id).slice(0, 3)
        grand.forEach((gchild, j) => {
          const glast = j === grand.length - 1
          out.push({
            connector: (last ? "   " : "│  ") + (glast ? "└─ " : "├─ "),
            name: gchild.name,
            annotation: annotate(gchild),
            kind: gchild.kind,
          })
        })
      }
    })
    return out
  })

  const kindColor = (kind: string) => {
    if (kind === "class") return toHex(theme().primary)
    if (kind === "type") return toHex(theme().warning)
    if (kind === "method") return toHex(theme().info)
    return toHex(theme().success)
  }

  const tabs = [
    { name: "L0", label: "L0", description: "Symbol" },
    { name: "L1", label: "L1", description: "Callers" },
    { name: "L2", label: "L2", description: "Impact" },
    { name: "L3", label: "L3", description: "Dependents" },
  ]

  return (
    <box>
      <text fg={toHex(theme().text)} marginBottom={1}><b>GRAPH EXPLORER</b></text>
      <box flexDirection="row" gap={1} marginBottom={1}>
        <For each={tabs}>{(tab) => {
          const isActive = () => activeLayer() === tab.name
          return (
            <box
              onMouseDown={() => setActiveLayer(tab.name)}
              paddingLeft={1}
              paddingRight={1}
              border={isActive() ? ["bottom"] : []}
              borderColor={isActive() ? toHex(theme().primary) : toHex(theme().border)}
            >
              <text fg={isActive() ? toHex(theme().primary) : toHex(theme().textMuted)}>{tab.label}</text>
            </box>
          )
        }}</For>
      </box>

      <Show
        when={rows().length > 0}
        fallback={
          data.loading ? (
            <box flexDirection="column" paddingLeft={2} paddingTop={2} gap={1}>
              <box flexDirection="row" gap={2} alignItems="center">
                <text fg={toHex(theme().primary)}>◌</text>
                <text fg={toHex(theme().textMuted)}>Loading graph…</text>
              </box>
            </box>
          ) : graph().nodes.length === 0 ? (
            <box flexDirection="column" paddingLeft={2} paddingTop={2} gap={1}>
              <box flexDirection="row" gap={2} alignItems="center">
                <text fg={toHex(theme().textMuted)}>∅</text>
                <text fg={toHex(theme().text)}>Graph not built</text>
              </box>
            </box>
          ) : (
            <box flexDirection="column" paddingLeft={2} paddingTop={2} gap={1}>
              <box flexDirection="row" gap={2} alignItems="center">
                <text fg={toHex(theme().textMuted)}>∅</text>
                <text fg={toHex(theme().text)}>No symbol selected for this layer</text>
              </box>
              <box paddingLeft={4}>
                <text fg={toHex(theme().textMuted)}>Click a node in the graph tab to focus it.</text>
              </box>
            </box>
          )
        }
      >
        <box marginTop={1} gap={0}>
          <For each={rows()}>
            {(row) => (
              <box flexDirection="row" gap={0}>
                <text fg={toHex(theme().textMuted)}>{row.connector}</text>
                <text fg={kindColor(row.kind)}>●</text>
                <text fg={toHex(theme().text)}> {row.name}</text>
                <Show when={row.annotation}>
                  <text fg={toHex(theme().textMuted)}> {row.annotation}</text>
                </Show>
              </box>
            )}
          </For>
        </box>
      </Show>

      <box flexDirection="row" gap={1} marginTop={1}>
        <text fg={toHex(theme().textMuted)}>↑/↓ navigate</text>
        <text fg={toHex(theme().textMuted)}>·</text>
        <text fg={toHex(theme().textMuted)}>enter focus</text>
        <text fg={toHex(theme().textMuted)}>·</text>
        <text fg={toHex(theme().textMuted)}>b back</text>
      </box>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 200,
    slots: {
      session_inspector(_ctx, slotProps) {
        const sessionID = (slotProps as { session_id?: string }).session_id
        if (!sessionID) return () => <box />
        return <View api={api} sessionID={sessionID} />
      },
    },
  })
}

const plugin: BuiltinTuiPlugin = {
  id,
  tui,
}

export default plugin
