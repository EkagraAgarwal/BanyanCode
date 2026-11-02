import type { PanelPresentation } from "@opencode/plugin/tui/context"
import { batch, createContext, createMemo, createSignal, useContext, type ParentProps } from "solid-js"
import { SESSION_PANEL_SPLIT_MIN_WIDTH } from "../ui/layout"

export type PanelTarget = {
  readonly plugin: string
  readonly name: string
  readonly sessionID: string
}

/** Spring `1 - e^(-6p)·cos(9p)`, held inside `[0, 1]` so an overshoot never widens the overlay column. */
export function panelSpring(p: number): number {
  const value = Math.max(0, Math.min(1, p))
  return Math.max(0, Math.min(1, 1 - Math.exp(-6 * value) * Math.cos(9 * value)))
}

/** Ease-out `1 - (1 - p)^3`, for the panels overlay closing. */
export function panelEaseOut(p: number): number {
  const value = Math.max(0, Math.min(1, p))
  return 1 - (1 - value) ** 3
}

export function createPanelState() {
  const [current, setCurrent] = createSignal<PanelTarget>()
  const [requested, setRequested] = createSignal<PanelPresentation>("panel")
  const [width, setWidth] = createSignal(0)
  // The Trunk chat layout keeps the side panels off screen until asked for.
  // This is presentation state, not a panel selection, so it survives the
  // panel opening and closing underneath it.
  const [overlay, setOverlay] = createSignal(false)
  const canSplit = () => width() >= SESSION_PANEL_SPLIT_MIN_WIDTH
  const presentation = createMemo(() => (canSplit() || requested() === "main" ? requested() : "fullscreen"))
  return {
    current,
    width,
    canSplit,
    presentation,
    setWidth,
    overlay,
    openOverlay: () => setOverlay(true),
    closeOverlay: () => setOverlay(false),
    toggleOverlay: () => setOverlay((value) => !value),
    open(target: PanelTarget, presentation: PanelPresentation = "panel") {
      batch(() => {
        setRequested(presentation)
        setCurrent((current) =>
          current?.plugin === target.plugin && current.name === target.name && current.sessionID === target.sessionID
            ? current
            : target,
        )
      })
    },
    close: () => setCurrent(),
    release(plugin: string) {
      if (current()?.plugin !== plugin) return
      setCurrent()
    },
    toggleFullscreen() {
      if (!canSplit() || requested() === "main") return
      setRequested((current) => (current === "panel" ? "fullscreen" : "panel"))
    },
  }
}

const Context = createContext<ReturnType<typeof createPanelState>>()

export function PanelProvider(props: ParentProps) {
  return <Context.Provider value={createPanelState()}>{props.children}</Context.Provider>
}

export function usePanel() {
  const value = useContext(Context)
  if (!value) throw new Error("usePanel must be used within a PanelProvider")
  return value
}

export function useOptionalPanel() {
  return useContext(Context)
}
