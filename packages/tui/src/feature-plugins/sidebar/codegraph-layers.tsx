import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createSignal } from "solid-js"
import { useEvent } from "../../context/event"

const id = "internal:sidebar-codegraph-layers"

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

const SPARKLINE = "▁▂▃▄▅▆▇█"

function SparklineBar(props: { filled: number }) {
  const cells = 8
  const f = Math.min(props.filled, cells)
  return <text>{SPARKLINE.slice(0, f)}</text>
}

function toHex(color: { r: number; g: number; b: number; a?: number } | string): string {
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
  ev.on("banyancode.codegraph.staleness" as any, (event: any) => {
    setStale(event.properties as StaleCheckPayload)
  })
  ev.on("banyancode.codegraph.build" as any, (event: any) => {
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

  const isStaleGraph = () => {
    const s = stale()
    return s?.graphCoverage !== undefined && s.graphCoverage < 0.5
  }

  const maxCount = () => Math.max(...layerCounts(), 1)

  const spark0 = () => Math.round((layerCounts()[0] / maxCount()) * 8)
  const spark1 = () => Math.round((layerCounts()[1] / maxCount()) * 8)
  const spark2 = () => Math.round((layerCounts()[2] / maxCount()) * 8)
  const spark3 = () => Math.round((layerCounts()[3] / maxCount()) * 8)

  const hasData = () => layerCounts().some((c) => c > 0)

  return (
    <box>
      <text fg={toHex(theme().text)}>
        <b>CODEGRAPH LAYERS</b>
        {isStaleGraph() && <text fg={toHex(theme().warning)}> (stale)</text>}
      </text>

      {!hasData() ? (
        <text fg={toHex(theme().textMuted)}>Graph: not built</text>
      ) : (
        <>
          <box flexDirection="row" gap={1}>
            <text fg={toHex(theme().textMuted)}>L0</text>
            <SparklineBar filled={spark0()} />
            <text fg={toHex(theme().textMuted)}>{formatCount(layerCounts()[0])}</text>
          </box>
          <box flexDirection="row" gap={1}>
            <text fg={toHex(theme().textMuted)}>L1</text>
            <SparklineBar filled={spark1()} />
            <text fg={toHex(theme().textMuted)}>{formatCount(layerCounts()[1])}</text>
          </box>
          <box flexDirection="row" gap={1}>
            <text fg={toHex(theme().textMuted)}>L2</text>
            <SparklineBar filled={spark2()} />
            <text fg={toHex(theme().textMuted)}>{formatCount(layerCounts()[2])}</text>
          </box>
          <box flexDirection="row" gap={1}>
            <text fg={toHex(theme().textMuted)}>L3</text>
            <SparklineBar filled={spark3()} />
            <text fg={toHex(theme().textMuted)}>{formatCount(layerCounts()[3])}</text>
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
