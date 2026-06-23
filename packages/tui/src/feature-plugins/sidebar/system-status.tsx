/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createSignal, onCleanup } from "solid-js"
import { useEvent } from "../../context/event"
import { toHex } from "../../util/color"

const id = "internal:sidebar-system-status"

interface SystemStatus {
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

function progressBar(percent: number, width = 12): string {
  const filled = Math.round((percent / 100) * width)
  return "█".repeat(filled) + "░".repeat(width - filled)
}

function colorForPercent(percent: number, theme: any): string {
  if (percent > 85) return toHex(theme.error)
  if (percent > 60) return toHex(theme.warning)
  return toHex(theme.success)
}

function View(props: { api: TuiPluginApi }) {
  const theme = () => props.api.theme.current

  const [status, setStatus] = createSignal<SystemStatus | null>(null)

  const ev = useEvent()

  const unsub = ev.on("banyancode.system.updated" as any, (event: any) => {
    setStatus(event.properties as SystemStatus)
  })
  onCleanup(unsub)

  const platformLabel = () => {
    const s = status()
    if (!s) return "—"
    const labels: Record<string, string> = { windows: "Windows", linux: "Linux", darwin: "Darwin" }
    return labels[s.platform] ?? s.platform
  }

  const cpuPercent = () => status()?.cpuPercent ?? 0
  const memPercent = () => {
    const s = status()
    if (!s) return 0
    return Math.round((s.memoryUsedBytes / s.memoryTotalBytes) * 100)
  }
  const gpuPercent = () => status()?.gpuPercent ?? 0

  return (
    <box>
      <text fg={toHex(theme().primary)}>
        <b>SYSTEM</b>
      </text>

      {!status() ? (
        <box flexDirection="row" gap={2} marginTop={1} alignItems="center">
          <text fg={toHex(theme().primary)}>◌</text>
          <text fg={toHex(theme().textMuted)}>Waiting for system data…</text>
        </box>
      ) : (
        <>
          <box marginTop={1} gap={0}>
            <box flexDirection="row" gap={1} justifyContent="space-between" width="100%">
              <text fg={toHex(theme().textMuted)}>CPU</text>
              <text fg={colorForPercent(cpuPercent(), theme())}>
                {cpuPercent().toFixed(0)}%
              </text>
            </box>
            <box flexDirection="row" gap={0}>
              <text fg={colorForPercent(cpuPercent(), theme())}>
                {progressBar(cpuPercent())}
              </text>
            </box>
          </box>

          <box marginTop={1} gap={0}>
            <box flexDirection="row" gap={1} justifyContent="space-between" width="100%">
              <text fg={toHex(theme().textMuted)}>Memory</text>
              <text fg={colorForPercent(memPercent(), theme())}>
                {formatBytes(status()!.memoryUsedBytes)} / {formatBytes(status()!.memoryTotalBytes)}
              </text>
            </box>
            <box flexDirection="row" gap={0}>
              <text fg={colorForPercent(memPercent(), theme())}>
                {progressBar(memPercent())}
              </text>
            </box>
          </box>

          {status()!.gpuPercent !== undefined && (
            <box marginTop={1} gap={0}>
              <box flexDirection="row" gap={1} justifyContent="space-between" width="100%">
                <text fg={toHex(theme().textMuted)}>GPU</text>
                <text fg={colorForPercent(gpuPercent(), theme())}>
                  {gpuPercent().toFixed(0)}%
                </text>
              </box>
              <box flexDirection="row" gap={0}>
                <text fg={colorForPercent(gpuPercent(), theme())}>
                  {progressBar(gpuPercent())}
                </text>
              </box>
            </box>
          )}

          {status()!.gpuPercent !== undefined && (
            <box marginTop={1} gap={0}>
              <box flexDirection="row" gap={1} justifyContent="space-between" width="100%">
                <text fg={toHex(theme().textMuted)}>VRAM</text>
                <text fg={toHex(theme().textMuted)}>
                  {formatBytes(status()!.vramUsedBytes!)} / {formatBytes(status()!.gpuTotalBytes!)}
                </text>
              </box>
            </box>
          )}

          <box marginTop={1} gap={0}>
            <text fg={toHex(theme().textMuted)}>Platform: {platformLabel()}</text>
          </box>
        </>
      )}
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 130,
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
