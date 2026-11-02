import type { Context } from "@opencode/plugin/tui/context"
import type { ScrollBoxRenderable } from "@opentui/core"
import { createContext, createEffect, createSignal, onCleanup, useContext } from "solid-js"

/** Input mode owned by the BanyanCode session panel while it is focused. */
export const PANEL_KEY_MODE = "banyancode.panel"

export type PanelZone = "rail" | "content"

export interface PanelFocus {
  readonly zone: () => PanelZone
  readonly setZone: (zone: PanelZone) => void
  readonly rail: () => number
  readonly setRail: (index: number) => void
}

export const PanelFocusContext = createContext<PanelFocus>()

export function usePanelFocus(): PanelFocus | undefined {
  return useContext(PanelFocusContext)
}

export function createPanelFocus(initialRail: number): PanelFocus {
  const [zone, setZone] = createSignal<PanelZone>("rail")
  const [rail, setRail] = createSignal(initialRail)
  return { zone, setZone, rail, setRail }
}

export interface PanelAction {
  readonly title: string
  readonly run: () => void
}

export interface PanelRow {
  readonly id: string
  readonly actions: readonly PanelAction[]
}

/**
 * Shared keyboard selection for a panel view's rows and per-row actions.
 * Up/down moves the row, left/right moves the action, enter runs it. The
 * layer only listens while the panel's content zone owns input, so the rail
 * (priority 30) keeps the arrow keys whenever it is focused.
 */
export function useRowKeys(input: {
  readonly context: Context
  readonly rows: () => readonly PanelRow[]
  readonly priority?: number
}): { readonly row: () => number; readonly action: () => number; readonly setRow: (index: number) => void } {
  const focus = usePanelFocus()
  const [rowIndex, setRowIndex] = createSignal(0)
  const [actionIndex, setActionIndex] = createSignal(0)
  const active = () => focus === undefined || focus.zone() === "content"
  const row = () => Math.min(rowIndex(), Math.max(0, input.rows().length - 1))
  const current = () => input.rows()[row()]
  const actions = () => current()?.actions ?? []
  const action = () => Math.min(actionIndex(), Math.max(0, actions().length - 1))
  const moveRow = (delta: number) => {
    const size = input.rows().length
    if (size === 0) return
    setRowIndex((row() + delta + size) % size)
    setActionIndex(0)
  }
  const setRow = (index: number) => {
    const size = input.rows().length
    if (size === 0) return
    setRowIndex(Math.max(0, Math.min(size - 1, Math.round(index))))
    setActionIndex(0)
  }
  const moveAction = (delta: number) => {
    const size = actions().length
    if (size === 0) return
    setActionIndex((action() + delta + size) % size)
  }

  input.context.keymap.layer(() => ({
    mode: PANEL_KEY_MODE,
    priority: input.priority ?? 20,
    commands: [
      {
        bind: "up",
        title: "Previous row",
        group: "Panel",
        enabled: active,
        run: () => moveRow(-1),
      },
      {
        bind: "down",
        title: "Next row",
        group: "Panel",
        enabled: active,
        run: () => moveRow(1),
      },
      {
        bind: "left",
        title: "Previous action",
        group: "Panel",
        enabled: active,
        run: () => moveAction(-1),
      },
      {
        bind: "right",
        title: "Next action",
        group: "Panel",
        enabled: active,
        run: () => moveAction(1),
      },
      {
        bind: "enter",
        title: "Run action",
        group: "Panel",
        enabled: active,
        run: () => actions()[action()]?.run(),
      },
    ],
  }))

  return { row, action, setRow }
}

/** Page/keyboard scrolling for a scrollable panel region. */
export function usePanelScroll(context: Context, target: () => ScrollBoxRenderable | undefined, priority = 5) {
  const page = () => {
    const element = target()
    const height = element?.viewport.height ?? 10
    return Math.max(1, height - 1)
  }
  context.keymap.layer(() => ({
    mode: PANEL_KEY_MODE,
    priority,
    commands: [
      { bind: "pageup", title: "Scroll panel up", group: "Panel", run: () => target()?.scrollBy(-page()) },
      { bind: "pagedown", title: "Scroll panel down", group: "Panel", run: () => target()?.scrollBy(page()) },
      { bind: "home", title: "Scroll panel to top", group: "Panel", run: () => target()?.scrollTo(0) },
      {
        bind: "end",
        title: "Scroll panel to bottom",
        group: "Panel",
        run: () => target()?.scrollTo(Infinity),
      },
    ],
  }))
}

/**
 * Pushes the panel input mode while the panel owns focus, so the prompt's
 * base-mode keys (history, submit) do not fire underneath the panel.
 */
export function usePanelKeyMode(context: Context, active: () => boolean) {
  createEffect(() => {
    if (!active()) return
    onCleanup(context.keymap.mode.push(PANEL_KEY_MODE))
  })
}
