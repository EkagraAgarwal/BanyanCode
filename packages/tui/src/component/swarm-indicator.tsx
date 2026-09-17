/** @jsxImportSource @opentui/solid */
import { createSignal, onCleanup } from "solid-js"
import { useSDK } from "../context/sdk"
import { useEvent } from "../context/event"
import { useTheme } from "../context/theme"

const CONFIG_UPDATED = "banyancode.config.updated"

/** Foreground for the swarm indicator: error red when ON, muted when OFF. */
export function swarmFg(enabled: boolean, theme: { error: unknown; textMuted: unknown }) {
  return enabled ? theme.error : theme.textMuted
}

export function SwarmIndicator() {
  const sdk = useSDK()
  const ev = useEvent()
  const { theme } = useTheme()
  const [enabled, setEnabled] = createSignal(false)

  const refresh = async () => {
    try {
      const result = await (sdk.client as any).global.banyanConfig.get({})
      // TODO: drop (sdk.client as any) on next SDK regen when banyanConfig.get has typed return
      setEnabled(Boolean(result?.data?.banyancode_swarm_mode))
    } catch {
      setEnabled(false)
    }
  }

  void refresh()
  const unsub = ev.on(CONFIG_UPDATED as any, () => void refresh())
  onCleanup(unsub)

  return (
    <text fg={swarmFg(enabled(), theme) as any} onMouseUp={() => void refresh()}>
      [swarm]
    </text>
  )
}
