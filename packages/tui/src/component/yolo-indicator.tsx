/** @jsxImportSource @opentui/solid */
import { createSignal, onCleanup } from "solid-js"
import { useSDK } from "../context/sdk"
import { useEvent } from "../context/event"
import { useTheme } from "../context/theme"

const CONFIG_UPDATED = "banyancode.config.updated"

export function YoloIndicator() {
  const sdk = useSDK()
  const ev = useEvent()
  const { theme } = useTheme()
  const [enabled, setEnabled] = createSignal(false)

  const refresh = async () => {
    try {
      const result = await (sdk.client as any).global.banyanConfig.get({})
      // TODO: drop (sdk.client as any) on next SDK regen when banyanConfig.get has typed return
      setEnabled(Boolean(result?.data?.banyancode_yolo_mode))
    } catch {
      setEnabled(false)
    }
  }

  void refresh()
  const unsub = ev.on(CONFIG_UPDATED as any, () => void refresh())
  onCleanup(unsub)

  return (
    <text fg={enabled() ? theme.error : theme.textMuted} onMouseUp={() => void refresh()}>
      [yolo]
    </text>
  )
}
