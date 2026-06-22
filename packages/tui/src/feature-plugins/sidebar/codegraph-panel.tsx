/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createSignal, createMemo, createResource, onCleanup } from "solid-js"
import { toHex } from "../../util/color"
import { useEvent } from "../../context/event"

const id = "internal:sidebar-codegraph-panel"

interface CodegraphMeta {
  graphBuiltAt: number
  graphVersion: number
  graphCoverage: number
  totalFiles: number
  totalNodes: number
  totalEdges: number
}

interface Sym {
  id: string
  name: string
  kind: string
}

interface Edge {
  source: string
  target: string
  kind: string
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

function View(props: { api: TuiPluginApi }) {
  const theme = () => props.api.theme.current

  const [buildEpoch, setBuildEpoch] = createSignal(0)
  const ev = useEvent()

  const unsub = ev.on("banyancode.codegraph.build", (evt) => {
    if (evt.properties?.status === "completed") {
      setBuildEpoch((p) => p + 1)
    }
  })
  onCleanup(unsub)

  const [graph] = createResource(buildEpoch, async () => {
    if (!props.api.client) return null
    try {
      const [nodesResult, edgesResult] = await Promise.all([
        props.api.client.global.codegraph.nodes(),
        props.api.client.global.codegraph.edges({}),
      ])
      const meta = (nodesResult.data?.meta as CodegraphMeta) ?? null
      const nodes: Sym[] = nodesResult.data?.nodes ?? []
      const edges: Edge[] = (edgesResult.data?.edges ?? []).map((e: any) => ({
        source: e.fromNodeID,
        target: e.toNodeID,
        kind: e.kind,
      }))
      return { meta, nodes, edges }
    } catch (e) {
      console.error(e)
      return null
    }
  })

  const loaded = () => graph() !== undefined
  const meta = () => graph()?.meta ?? null
  const hasMeta = () => meta() !== null && meta() !== undefined

  // Compute layer sets around the most-connected symbol, mirroring the
  // CodegraphAnalyzer callers/dependents/impact traversal.
  const layers = createMemo(() => {
    const g = graph()
    if (!g || g.nodes.length === 0) return null
    const nodeById = new Map(g.nodes.map((n) => [n.id, n]))
    const outAdj = new Map<string, Edge[]>()
    const inAdj = new Map<string, Edge[]>()
    const degree = new Map<string, number>()
    const push = (map: Map<string, Edge[]>, key: string, edge: Edge) => {
      const list = map.get(key)
      if (list) list.push(edge)
      else map.set(key, [edge])
    }
    for (const e of g.edges) {
      if (!nodeById.has(e.source) || !nodeById.has(e.target)) continue
      push(outAdj, e.source, e)
      push(inAdj, e.target, e)
      degree.set(e.source, (degree.get(e.source) ?? 0) + 1)
      degree.set(e.target, (degree.get(e.target) ?? 0) + 1)
    }
    const root = g.nodes.reduce((acc, n) => ((degree.get(n.id) ?? 0) > (degree.get(acc.id) ?? 0) ? n : acc), g.nodes[0])

    const callers = (inAdj.get(root.id) ?? []).filter((e) => e.kind === "calls" || e.kind === "references")
    const dependents = (outAdj.get(root.id) ?? [])

    const transitive = new Set<string>()
    const queue = [root.id]
    const seen = new Set<string>([root.id])
    let steps = 0
    while (queue.length && steps < 5000) {
      steps++
      const cur = queue.shift()!
      for (const e of outAdj.get(cur) ?? []) {
        if (!seen.has(e.target)) {
          seen.add(e.target)
          transitive.add(e.target)
          queue.push(e.target)
        }
      }
    }

    return {
      symbol: root.name,
      l1: new Set(callers.map((e) => e.source)).size,
      l2: transitive.size,
      l3: new Set(dependents.map((e) => e.target)).size,
    }
  })

  const bulletColor = (layerIdx: number) => {
    if (layerIdx === 3) return toHex(theme().error)
    if (layerIdx === 2) return toHex(theme().warning)
    if (layerIdx === 1) return toHex(theme().success)
    return toHex(theme().info)
  }

  const coveragePercent = () => {
    const m = meta()
    if (!m) return 0
    return Math.round(m.graphCoverage * 100)
  }

  const coverageLabel = () => {
    const m = meta()
    if (!m) return "Coverage —"
    const pct = Math.round(m.graphCoverage * 100)
    const covered = Math.round(m.totalFiles * m.graphCoverage)
    return `Coverage ${pct}% (${covered.toLocaleString()}/${m.totalFiles.toLocaleString()} files)`
  }

  const buildProgressBar = () => {
    const pct = coveragePercent()
    const filled = Math.round(pct / 5)
    const empty = 20 - filled
    return "█".repeat(filled) + "░".repeat(empty)
  }

  const layerCount = (n: number | undefined) => (n === undefined ? "—" : n.toLocaleString())

  return (
    <box>
      <text fg={toHex(theme().text)}>
        <b>CODEGRAPH LAYERS</b>
      </text>

      {!loaded() ? (
        <text fg={toHex(theme().textMuted)} marginTop={1}>
          Loading...
        </text>
      ) : !hasMeta() ? (
        <text fg={toHex(theme().textMuted)} marginTop={1}>
          Graph: not built
        </text>
      ) : (
        <>
          <text fg={toHex(theme().textMuted)} marginTop={1}>
            {layers() ? `Around ${layers()!.symbol}` : "No symbols indexed"}
          </text>
          <box marginTop={1} gap={0}>
            <box flexDirection="row" justifyContent="space-between" width="100%">
              <box flexDirection="row" gap={1}>
                <text fg={bulletColor(3)}>●</text>
                <text fg={toHex(theme().text)}>L3 Dependents</text>
              </box>
              <text fg={toHex(theme().textMuted)}>{layerCount(layers()?.l3)}</text>
            </box>
            <box flexDirection="row" justifyContent="space-between" width="100%">
              <box flexDirection="row" gap={1}>
                <text fg={bulletColor(2)}>●</text>
                <text fg={toHex(theme().text)}>L2 Impact (Trans)</text>
              </box>
              <text fg={toHex(theme().textMuted)}>{layerCount(layers()?.l2)}</text>
            </box>
            <box flexDirection="row" justifyContent="space-between" width="100%">
              <box flexDirection="row" gap={1}>
                <text fg={bulletColor(1)}>●</text>
                <text fg={toHex(theme().text)}>L1 Callers (Direct)</text>
              </box>
              <text fg={toHex(theme().textMuted)}>{layerCount(layers()?.l1)}</text>
            </box>
            <box flexDirection="row" justifyContent="space-between" width="100%">
              <box flexDirection="row" gap={1}>
                <text fg={bulletColor(0)}>●</text>
                <text fg={toHex(theme().text)}>L0 Symbol (Current)</text>
              </box>
              <text fg={toHex(theme().textMuted)}>{layers() ? "1" : "—"}</text>
            </box>
          </box>
          <text fg={toHex(theme().borderSubtle)} marginTop={1}>
            ────────────────────────────────
          </text>
          <text fg={toHex(theme().text)} marginTop={1}>
            <b>CODEGRAPH OVERVIEW</b>
          </text>
          <box marginTop={1} gap={0}>
            {(() => {
              const m = meta()
              if (!m) return null
              return (
                <>
                  <box flexDirection="row" gap={1} justifyContent="space-between" width="100%">
                    <text fg={toHex(theme().textMuted)}>Version {m.graphVersion}</text>
                    <text fg={toHex(theme().textMuted)}>Built {formatAge(m.graphBuiltAt)}</text>
                  </box>
                  <text fg={toHex(theme().textMuted)}>{coverageLabel()}</text>
                  <box flexDirection="row" gap={0}>
                    <text fg={toHex(theme().success)}>
                      {buildProgressBar().substring(0, Math.round(coveragePercent() / 5))}
                    </text>
                    <text fg={toHex(theme().textMuted)}>
                      {buildProgressBar().substring(Math.round(coveragePercent() / 5))}
                    </text>
                  </box>
                  <box flexDirection="row" gap={1} justifyContent="space-between" width="100%">
                    <text fg={toHex(theme().textMuted)}>Nodes {m.totalNodes.toLocaleString()}</text>
                    <text fg={toHex(theme().textMuted)}>Edges {m.totalEdges.toLocaleString()}</text>
                  </box>
                </>
              )
            })()}
          </box>
        </>
      )}
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 155,
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
