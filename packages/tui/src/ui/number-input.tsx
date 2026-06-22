/** @jsxImportSource @opentui/solid */
import { createSignal, Show } from "solid-js"
import { toHex } from "../util/color"

export function NumberInput(props: {
  value: number
  onChange: (v: number) => void
  theme: any
  min?: number
  max?: number
  label?: string
  width?: number
}) {
  const [editing, setEditing] = createSignal(false)
  const [draft, setDraft] = createSignal(String(props.value))
  const min = () => props.min ?? -Infinity
  const max = () => props.max ?? Infinity

  const commit = () => {
    const parsed = parseInt(draft(), 10)
    if (!isNaN(parsed)) {
      const clamped = Math.max(min(), Math.min(max(), parsed))
      props.onChange(clamped)
    }
    setEditing(false)
  }

  return (
    <box flexDirection="row" gap={1}>
      <Show when={props.label}>
        <text fg={toHex(props.theme.textMuted)}>{props.label}:</text>
      </Show>
      <Show
        when={editing()}
        fallback={
          <text
            fg={toHex(props.theme.text)}
            onMouseUp={() => { setDraft(String(props.value)); setEditing(true) }}
          >
            {props.value}
          </text>
        }
      >
        <input
          value={draft()}
          onInput={setDraft}
          onSubmit={commit}
          width={props.width ?? 8}
        />
      </Show>
    </box>
  )
}
