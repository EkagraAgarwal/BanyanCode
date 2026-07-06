/** @jsxImportSource @opentui/solid */
import { useTheme } from "../context/theme"
import { useTerminalDimensions, useRenderer } from "@opentui/solid"
import { createSignal } from "solid-js"

export function ResizableSeparator(props: {
  onResize: (newWidthPct: number) => void
  initialWidthPct: () => number
  side?: "left" | "right"
}) {
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()
  const renderer = useRenderer()
  const [dragging, setDragging] = createSignal(false)
  const [dragStartX, setDragStartX] = createSignal(0)
  const [dragStartWidthPct, setDragStartWidthPct] = createSignal(0)
  let separatorRef: any

  const startDrag = (x: number) => {
    setDragging(true)
    setDragStartX(x)
    setDragStartWidthPct(props.initialWidthPct())
    if (separatorRef) {
      ;(renderer as any).setCapturedRenderable(separatorRef)
    }
  }

  const handleDrag = (x: number) => {
    const deltaX = x - dragStartX()
    const deltaPct = (deltaX / dimensions().width) * 100
    const multiplier = props.side === "right" ? -1 : 1
    const newWidthPct = dragStartWidthPct() + deltaPct * multiplier
    props.onResize(newWidthPct)
  }

  const endDrag = () => {
    setDragging(false)
  }

  return (
    <box
      ref={separatorRef}
      width={1}
      height="100%"
      flexShrink={0}
      backgroundColor={dragging() ? theme.primary : theme.border}
      onMouseDown={(e: { x: number }) => startDrag(e.x)}
      onMouseDrag={(e: { x: number }) => handleDrag(e.x)}
      onMouseDragEnd={endDrag}
      onMouseUp={endDrag}
    />
  )
}
