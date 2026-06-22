/** @jsxImportSource @opentui/solid */
import { Show } from "solid-js"
import { toHex } from "../util/color"

export function ToggleSwitch(props: {
  value: boolean
  onChange: (v: boolean) => void
  theme: any
  label?: string
}) {
  const on = () => props.value
  return (
    <box flexDirection="row" gap={1} onMouseUp={() => props.onChange(!on())}>
      <text fg={on() ? toHex(props.theme.success) : toHex(props.theme.textMuted)}>
        {on() ? "[● ON]" : "[○ OFF]"}
      </text>
      <Show when={props.label}>
        <text fg={toHex(props.theme.text)}>{props.label}</text>
      </Show>
    </box>
  )
}
