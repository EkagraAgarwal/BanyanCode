/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createMemo } from "solid-js"
import { useSync } from "../../context/sync"

const id = "internal:inspector-pending-actions"

function toHex(color: { r: number; g: number; b: number; a?: number } | string): string {
  if (typeof color === "string") return color
  const toComponent = (v: number) => (v <= 1 ? Math.round(v * 255) : Math.round(v))
  const a = color.a !== undefined ? toComponent(color.a).toString(16).padStart(2, "0") : ""
  return `#${toComponent(color.r).toString(16).padStart(2, "0")}${toComponent(color.g).toString(16).padStart(2, "0")}${toComponent(color.b).toString(16).padStart(2, "0")}${a}`
}

function View(props: { api: TuiPluginApi }) {
  const sync = useSync()
  const theme = () => props.api.theme.current
  const primary = () => toHex(theme().primary)
  const textMuted = () => toHex(theme().textMuted)
  const text = () => toHex(theme().text)

  // Sessions in "working" or "busy" state are considered in-flight.
  const pending = createMemo(() => {
    return sync.data.session.filter((s) => {
      const status = sync.data.session_status[s.id]
      if (!status) return false
      return status.type === "busy" || status.type === "retry"
    })
  })

  return (
    <box>
      <text fg={text()}>
        <b>PENDING ACTIONS</b>
      </text>
      {pending().length === 0 ? (
        <text fg={textMuted()}>No pending actions</text>
      ) : (
        pending().map((s) => (
          <box flexDirection="column" gap={0}>
            <box flexDirection="row" gap={1}>
              <text fg={textMuted()}>•</text>
              <text fg={text()}>{s.agent ?? "agent"}</text>
              {s.title && (
                <text fg={textMuted()}> ({s.title})</text>
              )}
            </box>
            <box flexDirection="row" gap={1} paddingLeft={3}>
              <text fg={primary()}>[a]</text>
              <text fg={textMuted()}> abort  </text>
              <text fg={primary()}>[v]</text>
              <text fg={textMuted()}> view</text>
            </box>
          </box>
        ))
      )}
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 300,
    slots: {
      session_inspector() {
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