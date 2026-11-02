import { useTerminalDimensions } from "@opentui/solid"
import { createSignal } from "solid-js"
import { useTheme } from "../context/theme"

/** Drag handle between a docked side column and the session. Reports the column's new width as a percentage. */
export function SeparatorHandle(props: {
  side: "left" | "right"
  percent: () => number
  onResize: (percent: number) => void
}) {
  const theme = useTheme()
  const dimensions = useTerminalDimensions()
  const [hovered, setHovered] = createSignal(false)
  const [drag, setDrag] = createSignal<{ readonly x: number; readonly percent: number }>()
  return (
    <box
      width={1}
      height="100%"
      flexShrink={0}
      backgroundColor={drag() || hovered() ? theme.border.base : theme.background.base}
      onMouseDown={(event) => setDrag({ x: event.x, percent: props.percent() })}
      onMouseDrag={(event) => {
        const start = drag()
        if (!start) return
        const moved = ((event.x - start.x) / dimensions().width) * 100
        props.onResize(start.percent + (props.side === "right" ? -moved : moved))
      }}
      onMouseDragEnd={() => setDrag(undefined)}
      onMouseUp={() => setDrag(undefined)}
      onMouseOver={() => setHovered(true)}
      onMouseOut={() => setHovered(false)}
    />
  )
}

/** One column left behind by a collapsed side column. Clicking it brings the column back. */
export function CollapsedRail(props: { side: "left" | "right"; onExpand: () => void }) {
  const theme = useTheme()
  const [hovered, setHovered] = createSignal(false)
  return (
    <box
      width={1}
      height="100%"
      flexShrink={0}
      alignItems="center"
      justifyContent="center"
      backgroundColor={hovered() ? theme.border.base : theme.background.raised.base}
      onMouseDown={props.onExpand}
      onMouseOver={() => setHovered(true)}
      onMouseOut={() => setHovered(false)}
    >
      <text fg={theme.text.muted}>{props.side === "left" ? "›" : "‹"}</text>
    </box>
  )
}
