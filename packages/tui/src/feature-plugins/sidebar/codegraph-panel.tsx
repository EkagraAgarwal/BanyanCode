/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createSignal, onMount } from "solid-js"
import { toHex } from "../../util/color"

const id = "internal:sidebar-codegraph-panel"

interface CodegraphMeta {
  graphBuiltAt: number
  graphVersion: number
  graphCoverage: number
  totalFiles: number
  totalNodes: number
  totalEdges: number
}

function formatCount(n: number): string {
  return n.toLocaleString("en-US")
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

  const [meta, setMeta] = createSignal<CodegraphMeta | null>(null)
  const [loaded, setLoaded] = createSignal(false)

  onMount(async () => {
    if (!props.api.client) {
      setLoaded(true)
      return
    }
    try {
      const result = await (props.api.client as any).global.codegraphNodes()
      if (result.data?.meta) {
        setMeta(result.data.meta as CodegraphMeta)
      }
    } finally {
      setLoaded(true)
    }
  })

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

  const bulletColor = (layerIdx: number) => {
    if (layerIdx === 3) return toHex(theme().error)
    if (layerIdx === 2) return toHex(theme().warning)
    if (layerIdx === 1) return toHex(theme().success)
    return toHex(theme().info)
  }

  const hasMeta = () => meta() !== null

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
          <box marginTop={1} gap={0}>
            <box flexDirection="row" justifyContent="space-between" width="100%">
              <box flexDirection="row" gap={1}>
                <text fg={bulletColor(3)}>●</text>
                <text fg={toHex(theme().text)}>L3 Dependents</text>
              </box>
              <text fg={toHex(theme().textMuted)}>—</text>
            </box>
            <text fg={toHex(theme().textMuted)} marginLeft={2}>
              Select a symbol to compute
            </text>
            <box flexDirection="row" justifyContent="space-between" width="100%">
              <box flexDirection="row" gap={1}>
                <text fg={bulletColor(2)}>●</text>
                <text fg={toHex(theme().text)}>L2 Impact (Trans)</text>
              </box>
              <text fg={toHex(theme().textMuted)}>—</text>
            </box>
            <text fg={toHex(theme().textMuted)} marginLeft={2}>
              Select a symbol to compute
            </text>
            <box flexDirection="row" justifyContent="space-between" width="100%">
              <box flexDirection="row" gap={1}>
                <text fg={bulletColor(1)}>●</text>
                <text fg={toHex(theme().text)}>L1 Callers (Direct)</text>
              </box>
              <text fg={toHex(theme().textMuted)}>—</text>
            </box>
            <text fg={toHex(theme().textMuted)} marginLeft={2}>
              Select a symbol to compute
            </text>
            <box flexDirection="row" justifyContent="space-between" width="100%">
              <box flexDirection="row" gap={1}>
                <text fg={bulletColor(0)}>●</text>
                <text fg={toHex(theme().text)}>L0 Symbol (Current)</text>
              </box>
              <text fg={toHex(theme().textMuted)}>—</text>
            </box>
            <text fg={toHex(theme().textMuted)} marginLeft={2}>
              Select a symbol to compute
            </text>
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
              const builtAt = m.graphBuiltAt ? new Date(m.graphBuiltAt).toLocaleTimeString("en-US", { hour12: false }) : "—"
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
