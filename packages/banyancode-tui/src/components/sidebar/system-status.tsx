import type { Context } from "@opencode/plugin/tui/context"
import { createMemo, onMount, Show } from "solid-js"
import { formatBytes } from "../../data/format"
import type { SystemLive } from "../../data/live"
import { palette, type Palette } from "../../theme"

function colorForPercent(percent: number, theme: Palette) {
  if (percent >= 85) return theme.error
  if (percent >= 60) return theme.warning
  return theme.success
}

function MeterBar(props: { readonly percent: number; readonly theme: Palette }) {
  const percent = () => Math.max(0, Math.min(100, props.percent))
  return (
    <box flexDirection="row" height={1} width="100%">
      <box backgroundColor={colorForPercent(percent(), props.theme)} width={`${percent()}%`} height={1} />
      <box backgroundColor={props.theme.surfaceHigh} width={`${100 - percent()}%`} height={1} />
    </box>
  )
}

/** Ported from v1 `sidebar/system-status.tsx` (CPU / memory / disk / GPU). */
export function SystemPanel(props: { readonly context: Context; readonly system: SystemLive }) {
  const theme = () => palette(props.context.theme)

  onMount(() => {
    void props.system.refresh()
    void props.system.refreshLsp()
    void props.system.refreshYolo()
  })

  const memoryPercent = createMemo(() => {
    const status = props.system.status()
    if (!status || status.memoryTotalBytes <= 0) return undefined
    return Math.round((status.memoryUsedBytes / status.memoryTotalBytes) * 100)
  })

  const diskPercent = createMemo(() => {
    const status = props.system.status()
    if (status?.diskUsedBytes === undefined || status.diskTotalBytes === undefined || status.diskTotalBytes <= 0) {
      return undefined
    }
    return Math.round((status.diskUsedBytes / status.diskTotalBytes) * 100)
  })

  const vramPercent = createMemo(() => {
    const status = props.system.status()
    if (status?.vramUsedBytes === undefined || status.gpuTotalBytes === undefined || status.gpuTotalBytes <= 0) {
      return undefined
    }
    return Math.round((status.vramUsedBytes / status.gpuTotalBytes) * 100)
  })

  return (
    <box flexDirection="column" gap={0}>
      <text fg={theme().primary}>
        <b>SYSTEM</b>
      </text>
      <Show
        when={props.system.availability() !== "unavailable"}
        fallback={<text fg={theme().muted}>System status is not available on this server.</text>}
      >
        <Show
          when={props.system.status()}
          fallback={
            <box flexDirection="row" gap={1} alignItems="center">
              <text fg={theme().primary}>◌</text>
              <text fg={theme().muted}>Waiting for system data…</text>
            </box>
          }
        >
          {(status) => (
            <>
              <Show when={status().cpuPercent !== undefined}>
                <box flexDirection="column" gap={0} width="100%">
                  <box flexDirection="row" gap={1}>
                    <text fg={theme().muted}>CPU</text>
                    <box flexGrow={1} />
                    <text fg={colorForPercent(status().cpuPercent!, theme())}>{status().cpuPercent!.toFixed(0)}%</text>
                  </box>
                  <MeterBar percent={status().cpuPercent!} theme={theme()} />
                </box>
              </Show>
              <Show when={memoryPercent() !== undefined}>
                <box flexDirection="column" gap={0} width="100%">
                  <box flexDirection="row" gap={1}>
                    <text fg={theme().muted}>Memory</text>
                    <box flexGrow={1} />
                    <text fg={colorForPercent(memoryPercent()!, theme())}>
                      {formatBytes(status().memoryUsedBytes)} / {formatBytes(status().memoryTotalBytes)}
                    </text>
                  </box>
                  <MeterBar percent={memoryPercent()!} theme={theme()} />
                </box>
              </Show>
              <Show when={diskPercent() !== undefined}>
                <box flexDirection="column" gap={0} width="100%">
                  <box flexDirection="row" gap={1}>
                    <text fg={theme().muted}>Disk</text>
                    <box flexGrow={1} />
                    <text fg={colorForPercent(diskPercent()!, theme())}>
                      {formatBytes(status().diskUsedBytes!)} / {formatBytes(status().diskTotalBytes!)}
                    </text>
                  </box>
                  <MeterBar percent={diskPercent()!} theme={theme()} />
                </box>
              </Show>
              <Show when={vramPercent() !== undefined}>
                <box flexDirection="column" gap={0} width="100%">
                  <box flexDirection="row" gap={1}>
                    <text fg={theme().muted}>VRAM</text>
                    <box flexGrow={1} />
                    <text fg={colorForPercent(vramPercent()!, theme())}>
                      {formatBytes(status().vramUsedBytes!)} / {formatBytes(status().gpuTotalBytes!)}
                    </text>
                  </box>
                  <MeterBar percent={vramPercent()!} theme={theme()} />
                </box>
              </Show>
            </>
          )}
        </Show>
      </Show>
    </box>
  )
}
