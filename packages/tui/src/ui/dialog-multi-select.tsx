/** @jsxImportSource @opentui/solid */
import { createMemo, createSignal, For, Show } from "solid-js"
import { useDialog } from "../ui/dialog"
import { useTheme } from "../context/theme"
import { toHex } from "../util/color"

export interface MultiSelectOption<T = string> {
  value: T
  label: string
  description?: string
  category?: string
}

export interface MultiSelectGroup<T = string> {
  category: string
  options: MultiSelectOption<T>[]
}

export interface DialogMultiSelectProps<T = string> {
  title: string
  groups: MultiSelectGroup<T>[]
  selected: T[]
  onConfirm: (selected: T[]) => void
}

export function DialogMultiSelect<T extends string = string>(props: DialogMultiSelectProps<T>) {
  const { theme } = useTheme()
  const dialog = useDialog()
  const [query, setQuery] = createSignal("")
  const [selected, setSelected] = createSignal<Set<T>>(new Set(props.selected))

  const flatOptions = createMemo(() => {
    const all: { opt: MultiSelectOption<T>; groupIdx: number; optIdx: number }[] = []
    props.groups.forEach((group, gi) => {
      group.options.forEach((opt, oi) => {
        all.push({ opt, groupIdx: gi, optIdx: oi })
      })
    })
    return all
  })

  const filtered = createMemo(() => {
    const q = query().toLowerCase()
    if (!q) return flatOptions()
    return flatOptions().filter(({ opt }) =>
      opt.label.toLowerCase().includes(q) ||
        (opt.description?.toLowerCase().includes(q) ?? false),
    )
  })

  const toggle = (value: T) => {
    const next = new Set(selected())
    if (next.has(value)) next.delete(value)
    else next.add(value)
    setSelected(next)
  }

  const confirm = () => {
    props.onConfirm(Array.from(selected()))
    dialog.clear()
  }

  return (
    <box flexDirection="column" width="100%" height="100%" backgroundColor={toHex(theme.background)}>
      <box flexDirection="row" paddingLeft={2} paddingRight={2} paddingTop={1}>
        <text fg={toHex(theme.primary)}>
          <b>{props.title}</b>
        </text>
      </box>
      <box flexDirection="row" paddingLeft={2} paddingRight={2} marginTop={1}>
        <text fg={toHex(theme.textMuted)}>search: </text>
        <input
          value={query()}
          onInput={(v) => setQuery(v)}
          flexGrow={1}
        />
      </box>
      <scrollbox flexGrow={1} marginTop={1} paddingLeft={2} paddingRight={2}>
        <For each={props.groups}>
          {(group) => {
            const filteredGroup = createMemo(() =>
              group.options.filter((opt) => {
                const q = query().toLowerCase()
                return (
                  !q ||
                  opt.label.toLowerCase().includes(q) ||
                  (opt.description?.toLowerCase().includes(q) ?? false)
                )
              }),
            )
            return (
              <Show when={filteredGroup().length > 0}>
                <box flexDirection="column" marginBottom={1}>
                  <text fg={toHex(theme.textMuted)}>
                    <b>── {group.category} ──</b>
                  </text>
                  <For each={filteredGroup()}>
                    {(opt) => {
                      const isSelected = () => selected().has(opt.value)
                      const bullet = () => (isSelected() ? "✓" : "○")
                      const color = () => (isSelected() ? toHex(theme.success) : toHex(theme.text))
                      return (
                        <box
                          flexDirection="row"
                          gap={1}
                          onMouseUp={() => toggle(opt.value)}
                        >
                          <text fg={color()}>{bullet()}</text>
                          <text fg={color()}>{opt.label}</text>
                          <Show when={opt.description}>
                            <text fg={toHex(theme.textMuted)}>· {opt.description}</text>
                          </Show>
                        </box>
                      )
                    }}
                  </For>
                </box>
              </Show>
            )
          }}
        </For>
      </scrollbox>
      <box flexDirection="row" paddingLeft={2} paddingRight={2} paddingBottom={1}>
        <text
          fg={toHex(theme.success)}
          onMouseUp={confirm}
        >
          [enter confirm]
        </text>
        <text fg={toHex(theme.textMuted)}> · </text>
        <text
          fg={toHex(theme.textMuted)}
          onMouseUp={() => dialog.clear()}
        >
          [esc cancel]
        </text>
      </box>
    </box>
  )
}
