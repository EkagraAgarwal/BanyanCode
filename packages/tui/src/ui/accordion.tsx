/** @jsxImportSource @opentui/solid */
import { createSignal, For, Show } from "solid-js"
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
                onMouseUp={() => setOpen(isOpen() ? null : section.id)}
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
