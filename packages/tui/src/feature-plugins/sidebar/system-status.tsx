/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createSignal, onCleanup, Show } from "solid-js"
import { useEvent } from "../../context/event"
import { toHex } from "../../util/color"

const id = "internal:sidebar-system-status"

interface SystemStatus {
  cpuPercent?: number
  memoryUsedBytes: number
  memoryTotalBytes: number
  diskUsedBytes?: number
  diskTotalBytes?: number
  temperatureC?: number
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
  if (percent >= 85) return toHex(theme.error)
  if (percent >= 60) return toHex(theme.warning)
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

  const cpuPercent = () => status()?.cpuPercent
  const memPercent = () => {
    const s = status()
    if (!s) return undefined
    return Math.round((s.memoryUsedBytes / s.memoryTotalBytes) * 100)
  }

  const diskPercent = () => {
    const s = status()
    if (s?.diskUsedBytes === undefined || s?.diskTotalBytes === undefined) return undefined
    return Math.round((s.diskUsedBytes / s.diskTotalBytes) * 100)
  }

  const tempC = () => status()?.temperatureC

  return (
    <box>
      <text fg={toHex(theme().primary)}>
        <b>SYSTEM</b>
      </text>

      <Show when={status()} fallback={
        <box flexDirection="row" gap={2} marginTop={1} alignItems="center">
          <text fg={toHex(theme().primary)}>◌</text>
          <text fg={toHex(theme().textMuted)}>Waiting for system data…</text>
        </box>
      }>
        {(s) => (
          <>
            <Show when={cpuPercent() !== undefined}>
              <box marginTop={1} gap={0}>
                <box flexDirection="row" gap={1} justifyContent="space-between" width="100%">
                  <text fg={toHex(theme().textMuted)}>CPU</text>
                  <text fg={colorForPercent(cpuPercent()!, theme())}>
                    {cpuPercent()!.toFixed(0)}%
                  </text>
                </box>
                <box flexDirection="row" gap={0}>
                  <text fg={colorForPercent(cpuPercent()!, theme())}>
                    {progressBar(cpuPercent()!)}
                  </text>
                </box>
              </box>
            </Show>

            <Show when={memPercent() !== undefined}>
              <box marginTop={1} gap={0}>
                <box flexDirection="row" gap={1} justifyContent="space-between" width="100%">
                  <text fg={toHex(theme().textMuted)}>Memory</text>
                  <text fg={colorForPercent(memPercent()!, theme())}>
                    {formatBytes(s().memoryUsedBytes)} / {formatBytes(s().memoryTotalBytes)}
                  </text>
                </box>
                <box flexDirection="row" gap={0}>
                  <text fg={colorForPercent(memPercent()!, theme())}>
                    {progressBar(memPercent()!)}
                  </text>
                </box>
              </box>
            </Show>

            <Show when={diskPercent() !== undefined}>
              <box marginTop={1} gap={0}>
                <box flexDirection="row" gap={1} justifyContent="space-between" width="100%">
                  <text fg={toHex(theme().textMuted)}>Disk</text>
                  <text fg={colorForPercent(diskPercent()!, theme())}>
                    {formatBytes(s().diskUsedBytes!)} / {formatBytes(s().diskTotalBytes!)}
                  </text>
                </box>
                <box flexDirection="row" gap={0}>
                  <text fg={colorForPercent(diskPercent()!, theme())}>
                    {progressBar(diskPercent()!)}
                  </text>
                </box>
              </box>
            </Show>

            <Show when={tempC() !== undefined}>
              <box marginTop={1} gap={0}>
                <box flexDirection="row" gap={1} justifyContent="space-between" width="100%">
                  <text fg={toHex(theme().textMuted)}>Temp</text>
                  <text fg={colorForPercent(
                    Math.round(Math.min(Math.max((tempC()! - 20) / 80 * 100, 0), 100)),
                    theme(),
                  )}>
                    {tempC()!.toFixed(1)}°C
                  </text>
                </box>
                <box flexDirection="row" gap={0}>
                  <text fg={colorForPercent(
                    Math.round(Math.min(Math.max((tempC()! - 20) / 80 * 100, 0), 100)),
                    theme(),
                  )}>
                    {progressBar(Math.round(Math.min(Math.max((tempC()! - 20) / 80 * 100, 0), 100)))}
                  </text>
                </box>
              </box>
            </Show>
          </>
        )}
      </Show>
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
