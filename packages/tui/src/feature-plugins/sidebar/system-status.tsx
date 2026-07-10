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

function Bar(props: { percent: number; theme: any }) {
  const pct = () => Math.max(0, Math.min(100, props.percent))
  const color = () => {
    const t = props.theme
    if (pct() >= 85) return toHex(t.error)
    if (pct() >= 60) return toHex(t.warning)
    return toHex(t.success)
  }
  const emptyColor = () => toHex(props.theme.backgroundElement)
  return (
    <box flexDirection="row" height={1} width="100%">
      <box backgroundColor={color()} width={`${pct()}%`} height={1} />
      <box backgroundColor={emptyColor()} width={`${100 - pct()}%`} height={1} />
    </box>
  )
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

  return (
    <box flexDirection="column" gap={0}>
      <text fg={toHex(theme().primary)}>
        <b>SYSTEM</b>
      </text>

      <Show when={status()} fallback={
        <box flexDirection="row" gap={2} marginTop={0} alignItems="center">
          <text fg={toHex(theme().primary)}>◌</text>
          <text fg={toHex(theme().textMuted)}>Waiting for system data…</text>
        </box>
      }>
        {(s) => (
          <>
            <Show when={cpuPercent() !== undefined}>
              <box flexDirection="column" gap={0} marginTop={1} width="100%">
                <box flexDirection="row" gap={1}>
                  <text fg={toHex(theme().textMuted)}>CPU</text>
                  <box flexGrow={1}></box>
                  <text fg={colorForPercent(cpuPercent()!, theme())} wrapMode="none">
                    {cpuPercent()!.toFixed(0)}%
                  </text>
                </box>
                <Bar percent={cpuPercent()!} theme={theme()} />
              </box>
            </Show>

            <Show when={memPercent() !== undefined}>
              <box flexDirection="column" gap={0} marginTop={1} width="100%">
                <box flexDirection="row" gap={1}>
                  <text fg={toHex(theme().textMuted)}>Memory</text>
                  <box flexGrow={1}></box>
                  <text fg={colorForPercent(memPercent()!, theme())} wrapMode="none">
                    {formatBytes(s().memoryUsedBytes)} / {formatBytes(s().memoryTotalBytes)}
                  </text>
                </box>
                <Bar percent={memPercent()!} theme={theme()} />
              </box>
            </Show>

            <Show when={diskPercent() !== undefined}>
              <box flexDirection="column" gap={0} marginTop={1} width="100%">
                <box flexDirection="row" gap={1}>
                  <text fg={toHex(theme().textMuted)}>Disk</text>
                  <box flexGrow={1}></box>
                  <text fg={colorForPercent(diskPercent()!, theme())} wrapMode="none">
                    {formatBytes(s().diskUsedBytes!)} / {formatBytes(s().diskTotalBytes!)}
                  </text>
                </box>
                <Bar percent={diskPercent()!} theme={theme()} />
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
