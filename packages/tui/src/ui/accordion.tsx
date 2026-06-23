/** @jsxImportSource @opentui/solid */
import { createSignal, For, Show } from "solid-js"
import { useKeyboard } from "@opentui/solid"
import { toHex } from "../util/color"

export interface AccordionSection {
  id: string
  title: string
  content: () => any  // JSX
}

export function Accordion(props: {
  sections: AccordionSection[]
  theme: any
  defaultOpen?: string
}) {
  const [open, setOpen] = createSignal<string | null>(props.defaultOpen ?? null)

  const toggle = (id: string) => setOpen(open() === id ? null : id)

  useKeyboard((evt) => {
    if (evt.name !== "return" && evt.name !== "space") return
    if (evt.defaultPrevented) return
    const id = open() ?? props.sections[0]?.id
    if (!id) return
    evt.preventDefault()
    toggle(id)
  })

  return (
    <box flexDirection="column">
      <For each={props.sections}>
        {(section) => {
          const isOpen = () => open() === section.id
          return (
            <box flexDirection="column" marginBottom={1}>
              <box
                flexDirection="row"
                gap={1}
                onMouseUp={() => toggle(section.id)}
              >
                <text fg={toHex(props.theme.primary)}>{isOpen() ? "▼" : "▶"}</text>
                <text fg={toHex(props.theme.text)}><b>{section.title}</b></text>
              </box>
              <Show when={isOpen()}>
                <box flexDirection="column" paddingLeft={2} paddingTop={1}>
                  {section.content()}
                </box>
              </Show>
            </box>
          )
        }}
      </For>
    </box>
  )
}