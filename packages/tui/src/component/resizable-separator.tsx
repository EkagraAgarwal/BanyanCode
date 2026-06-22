import { createSignal } from "solid-js"
import { useTheme } from "../context/theme"
import { useTerminalDimensions } from "@opentui/solid"
import { RGBA } from "@opentui/core"

export function ResizableSeparator(props: {
  onResize: (newWidthPct: number) => void
  initialWidthPct: () => number
}) {
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()
  const [dragging, setDragging] = createSignal(false)
  const [dragStartX, setDragStartX] = createSignal(0)
  const [dragStartWidthPct, setDragStartWidthPct] = createSignal(0)

  const startDrag = (x: number) => {
    setDragging(true)
    setDragStartX(x)
    setDragStartWidthPct(props.initialWidthPct())
  }

  const handleMouseMove = (x: number) => {
    if (!dragging()) return
    const deltaX = x - dragStartX()
    const deltaPct = (deltaX / dimensions().width) * 100
    const newWidthPct = dragStartWidthPct() + deltaPct
    props.onResize(newWidthPct)
  }

  const endDrag = () => {
    setDragging(false)
  }

  return (
    <>
      <box
        width={1}
        backgroundColor={dragging() ? theme.primary : theme.border}
        onMouseDown={(e: { x: number }) => startDrag(e.x)}
        onMouseMove={(e: { x: number }) => handleMouseMove(e.x)}
        onMouseUp={endDrag}
      />
      {dragging() && (
        <box
          position="absolute"
          left={0}
          top={0}
          width={dimensions().width}
          height={dimensions().height}
          backgroundColor={RGBA.fromInts(0, 0, 0, 0)}
          onMouseMove={(e: { x: number }) => handleMouseMove(e.x)}
          onMouseUp={endDrag}
          zIndex={9999}
        />
      )}
    </>
  )
}
