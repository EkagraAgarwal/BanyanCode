import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createSignal } from "solid-js"
import { useEvent } from "../../context/event"

const id = "internal:sidebar-system-status"

interface SystemStatusPayload {
  cpuPercent: number
  memoryUsedBytes: number
  memoryTotalBytes: number
  gpuPercent?: number
  vramUsedBytes?: number
  gpuTotalBytes?: number
  platform: "windows" | "linux" | "darwin"
}

function formatBytes(bytes: number): string {
  const gb = bytes / 1024 / 1024 / 1024
  if (gb >= 1) return `${gb.toFixed(1)} GB`
  const mb = bytes / 1024 / 1024
  return `${mb.toFixed(0)} MB`
}

function toHex(color: { r: number; g: number; b: number; a?: number } | string): string {
  if (typeof color === "string") return color
  const a = color.a !== undefined ? Math.round(color.a * 255).toString(16).padStart(2, "0") : ""
  return `#${color.r.toString(16).padStart(2, "0")}${color.g.toString(16).padStart(2, "0")}${color.b.toString(16).padStart(2, "0")}${a}`
}

function ProgressBar(props: { percent: number; fg: string; width?: number }) {
  const w = props.width ?? 10
  const filled = Math.round((props.percent / 100) * w)
  const empty = w - filled
  return (
    <text fg={props.fg}>
      {`[${"=".repeat(filled)}${" ".repeat(empty)}]`}
    </text>
  )
}

function View(props: { api: TuiPluginApi }) {
  const theme = () => props.api.theme.current
  const [status, setStatus] = createSignal<SystemStatusPayload | null>(null)

  const ev = useEvent()
  ev.on("banyancode.system.updated" as any, (event: any) => {
    setStatus(event.properties as SystemStatusPayload)
  })

  const memUsed = () => (status() ? formatBytes(status()!.memoryUsedBytes) : "—")
  const memTotal = () => (status() ? formatBytes(status()!.memoryTotalBytes) : "—")
  const memPercent = () => (status() ? (status()!.memoryUsedBytes / status()!.memoryTotalBytes) * 100 : 0)

  const gpuUsed = () => (status()?.vramUsedBytes ? formatBytes(status()!.vramUsedBytes!) : "—")
  const gpuTotal = () => (status()?.gpuTotalBytes ? formatBytes(status()!.gpuTotalBytes!) : "—")
  const gpuPercent = () => status()?.gpuPercent ?? 0

  return (
    <box>
      <text fg={toHex(theme().text)}>
        <b>System</b>
      </text>
      {status() === null ? (
        <text fg={toHex(theme().textMuted)}>Loading...</text>
      ) : (
        <>
          <box flexDirection="row" gap={1}>
            <text fg={toHex(theme().textMuted)}>CPU</text>
            <ProgressBar percent={status()!.cpuPercent} fg={toHex(theme().primary)} />
            <text fg={toHex(theme().textMuted)}>{status()!.cpuPercent.toFixed(0)}%</text>
          </box>
          <box flexDirection="row" gap={1}>
            <text fg={toHex(theme().textMuted)}>Mem</text>
            <ProgressBar percent={memPercent()} fg={toHex(theme().secondary)} />
            <text fg={toHex(theme().textMuted)}>
              {memUsed()} / {memTotal()}
            </text>
          </box>
          {status()?.gpuPercent !== undefined && (
            <box flexDirection="row" gap={1}>
              <text fg={toHex(theme().textMuted)}>GPU</text>
              <ProgressBar percent={gpuPercent()} fg={toHex(theme().success)} />
              <text fg={toHex(theme().textMuted)}>
                {gpuUsed()} / {gpuTotal()}
              </text>
            </box>
          )}
        </>
      )}
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 150,
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