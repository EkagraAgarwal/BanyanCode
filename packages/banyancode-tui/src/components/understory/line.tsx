import { TextAttributes } from "@opentui/core"
import { For } from "solid-js"
import type { Span } from "./layout"

/** One row of coloured spans. Text-only rows keep using this; lanes use CellGrid. */
export type Line = readonly Span[]

export function LineView(props: { readonly width: number; readonly spans: Line }) {
  return (
    <text width={Math.max(0, props.width)} wrapMode="none">
      <For each={props.spans}>
        {(span) => (
          <span style={{ fg: span.color, attributes: span.bold ? TextAttributes.BOLD : 0 }}>{span.text}</span>
        )}
      </For>
    </text>
  )
}
