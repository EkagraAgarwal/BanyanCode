import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createSignal } from "solid-js"
import { useEvent } from "../../context/event"

const id = "internal:sidebar-codegraph-overview"

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

function CoverageBar(props: { coverage: number }) {
  const cells = 16
  const filled = Math.round(props.coverage * cells)
  return (
    <text>
      {"█".repeat(filled)}
      {"░".repeat(cells - filled)}
    </text>
  )
}

function toHex(color: { r: number; g: number; b: number; a?: number } | string): string {
  if (typeof color === "string") return color
  const toComponent = (v: number) => (v <= 1 ? Math.round(v * 255) : Math.round(v))
  const a = color.a !== undefined ? toComponent(color.a).toString(16).padStart(2, "0") : ""
  return `#${toComponent(color.r).toString(16).padStart(2, "0")}${toComponent(color.g).toString(16).padStart(2, "0")}${toComponent(color.b).toString(16).padStart(2, "0")}${a}`
}

function View(props: { api: TuiPluginApi }) {
  const theme = () => props.api.theme.current

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

  const meta = () => stale()

  const coverage = () => meta()?.graphCoverage ?? 0
  const coveragePct = () => Math.round(coverage() * 100)

  const age = () => {
    const built = meta()?.graphBuiltAt
    if (!built) return "—"
    return formatAge(Date.now() - built)
  }

  const hasMeta = () => meta() !== null && meta()!.graphBuiltAt !== undefined

  return (
    <box>
      <text fg={toHex(theme().text)}>
        <b>CODEGRAPH OVERVIEW</b>
      </text>

      {!hasMeta() ? (
        <text fg={toHex(theme().textMuted)}>Graph: not built</text>
      ) : (
        <>
          <box flexDirection="row" gap={1}>
            <text fg={toHex(theme().textMuted)}>Version</text>
            <text fg={toHex(theme().text)}>{meta()!.graphVersion ?? "—"}</text>
          </box>
          <box flexDirection="row" gap={1}>
            <text fg={toHex(theme().textMuted)}>Built</text>
            <text fg={toHex(theme().text)}>{age()}</text>
          </box>
          <box flexDirection="row" gap={1}>
            <text fg={toHex(theme().textMuted)}>Coverage</text>
            <CoverageBar coverage={coverage()} />
            <text fg={toHex(theme().textMuted)}>{coveragePct()}%</text>
          </box>
          <box flexDirection="row" gap={1}>
            <text fg={toHex(theme().textMuted)}>Nodes</text>
            <text fg={toHex(theme().text)}>—</text>
          </box>
          <box flexDirection="row" gap={1}>
            <text fg={toHex(theme().textMuted)}>Edges</text>
            <text fg={toHex(theme().text)}>—</text>
          </box>
        </>
      )}
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 161,
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
