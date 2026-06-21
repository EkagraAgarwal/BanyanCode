/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createSignal, onCleanup } from "solid-js"
import { useEvent } from "../../context/event"

const id = "internal:sidebar-codegraph-panel"

interface StaleCheckPayload {
  isStale: boolean
  filesChanged: number
  filesMissing: number
  filesTotal: number
  lastChecked: number
  reason?: string
  graphBuiltAt?: number
  graphVersion?: number
  graphCoverage?: number
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

function toHex(color: { r: number; g: number; b: number; a?: number } | string | undefined | null): string {
  if (!color) return ""
  if (typeof color === "string") return color
  const toComponent = (v: number) => (v <= 1 ? Math.round(v * 255) : Math.round(v))
  const a = color.a !== undefined ? toComponent(color.a).toString(16).padStart(2, "0") : ""
  return `#${toComponent(color.r).toString(16).padStart(2, "0")}${toComponent(color.g).toString(16).padStart(2, "0")}${toComponent(color.b).toString(16).padStart(2, "0")}${a}`
}

function View(props: { api: TuiPluginApi }) {
  const theme = () => props.api.theme.current

  const [layerCounts, setLayerCounts] = createSignal<[number, number, number, number]>([0, 0, 0, 0])
  const [stale, setStale] = createSignal<StaleCheckPayload | null>(null)

  const ev = useEvent()

  const unsubStaleness = ev.on("banyancode.codegraph.staleness" as any, (event: any) => {
    const payload = event.properties as StaleCheckPayload
    setStale(payload)
    if (event.properties && Array.isArray(event.properties.layers)) {
      setLayerCounts(event.properties.layers as [number, number, number, number])
    }
  })
  onCleanup(unsubStaleness)

  const unsubLayers = ev.on("banyancode.codegraph.layers" as any, (event: any) => {
    if (event.properties && Array.isArray(event.properties.layers)) {
      setLayerCounts(event.properties.layers as [number, number, number, number])
    }
  })
  onCleanup(unsubLayers)

  const unsubBuild = ev.on("banyancode.codegraph.build" as any, (event: any) => {
    const state = event.properties as { status: string; graphVersion?: number; graphCoverage?: number; startedAt?: number; result?: { indexed: number; skipped: number } }
    if (state.status === "completed") {
      setStale({
        isStale: false,
        filesChanged: 0,
        filesMissing: 0,
        filesTotal: state.result ? state.result.indexed + state.result.skipped : 0,
        lastChecked: Date.now(),
        graphBuiltAt: state.startedAt,
        graphVersion: state.graphVersion,
        graphCoverage: state.graphCoverage,
      })
    }
  })
  onCleanup(unsubBuild)

  const isStaleGraph = () => {
    const s = stale()
    return s?.graphCoverage !== undefined && s.graphCoverage < 0.5
  }

  const hasData = () => {
    const s = stale()
    return s !== null && s.graphBuiltAt !== undefined
  }

  const bottomRow = () => {
    const s = stale()
    if (!s || s.graphBuiltAt === undefined) return ""
    const v = s.graphVersion !== undefined ? `Version ${s.graphVersion}` : "Version —"
    const cov = s.graphCoverage !== undefined ? `Coverage ${Math.round(s.graphCoverage * 100)}%` : "Coverage —"
    const ageStr = s.graphBuiltAt ? `Built ${formatAge(Date.now() - s.graphBuiltAt)}` : "Built —"
    return `${v}  ${cov}  ${ageStr}`
  }

  const bulletColor = (layerIdx: number) => {
    if (layerIdx === 3) return toHex(theme().error)
    if (layerIdx === 2) return toHex(theme().warning)
    if (layerIdx === 1) return toHex(theme().success)
    return toHex(theme().info)
  }

  return (
    <box>
      <text fg={toHex(theme().text)}>
        <b>CODEGRAPH LAYERS</b>
        {isStaleGraph() && <text fg={toHex(theme().warning)}> (stale)</text>}
      </text>

      {!hasData() ? (
        <text fg={toHex(theme().textMuted)} marginTop={1}>Graph: not built</text>
      ) : (
        <>
          <box marginTop={1} gap={0}>
            <box flexDirection="row" justifyContent="space-between" width="100%">
              <box flexDirection="row" gap={1}>
                <text fg={bulletColor(3)}>●</text>
                <text fg={toHex(theme().text)}>L3  Dependents</text>
              </box>
              <text fg={toHex(theme().text)}>{formatCount(layerCounts()[3])}</text>
            </box>
            <box flexDirection="row" justifyContent="space-between" width="100%">
              <box flexDirection="row" gap={1}>
                <text fg={bulletColor(2)}>●</text>
                <text fg={toHex(theme().text)}>L2  Impact (Trans)</text>
              </box>
              <text fg={toHex(theme().text)}>{formatCount(layerCounts()[2])}</text>
            </box>
            <box flexDirection="row" justifyContent="space-between" width="100%">
              <box flexDirection="row" gap={1}>
                <text fg={bulletColor(1)}>●</text>
                <text fg={toHex(theme().text)}>L1  Callers (Direct)</text>
              </box>
              <text fg={toHex(theme().text)}>{formatCount(layerCounts()[1])}</text>
            </box>
            <box flexDirection="row" justifyContent="space-between" width="100%">
              <box flexDirection="row" gap={1}>
                <text fg={bulletColor(0)}>●</text>
                <text fg={toHex(theme().text)}>L0  Symbol (Current)</text>
              </box>
              <text fg={toHex(theme().text)}>{formatCount(layerCounts()[0])}</text>
            </box>
          </box>
          <text fg={toHex(theme().borderSubtle)} marginTop={1}>────────────────────────────────</text>
          <text fg={toHex(theme().textMuted)}>{bottomRow()}</text>
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
