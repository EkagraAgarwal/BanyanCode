/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import type { Context, KeymapCommand, PanelInput } from "@opencode/plugin/tui/context"
import type { ScrollBoxRenderable } from "@opentui/core"
import { InspectorPanel, panelScrollsInternally } from "../src/components/panels/inspector"
import { createPanelFocus, PanelFocusContext } from "../src/components/panels/keys"
import { SessionsView } from "../src/components/panels/sessions"
import { PANEL } from "../src/constants"
import { context, live, mount, session } from "./harness"

interface Layer {
  readonly mode?: string
  readonly priority?: number
  readonly commands?: readonly KeymapCommand[]
}

function recordingContext(input: Parameters<typeof context>[0] = {}) {
  const layers: Layer[] = []
  const pushes: string[] = []
  const opened: string[] = []
  const navigated: unknown[] = []
  const base = context(input)
  const value = {
    ...base,
    keymap: {
      ...base.keymap,
      layer: (factory: () => Layer) => {
        layers.push(factory())
      },
      mode: {
        current: () => "base",
        push: (mode: string) => {
          pushes.push(mode)
          return () => {}
        },
      },
    },
    ui: {
      ...base.ui,
      panel: {
        ...base.ui.panel,
        open: (name: string) => {
          opened.push(name)
          return true
        },
      },
      router: {
        ...base.ui.router,
        register: () => () => {},
        navigate: (destination: unknown) => navigated.push(destination),
      },
    },
  } as unknown as Context
  const press = async (title: string) => {
    const ordered = [...layers].sort((left, right) => (right.priority ?? 0) - (left.priority ?? 0))
    for (const layer of ordered) {
      const command = layer.commands?.find((item) => item.title === title)
      if (!command) continue
      const enabled = command.enabled
      if (enabled === false) continue
      if (typeof enabled === "function" && !enabled()) continue
      await command.run()
      return true
    }
    return false
  }
  return { value, layers, pushes, opened, navigated, press }
}

function panel(
  name: string,
  input: {
    readonly focused?: boolean
    readonly width?: number
    readonly close?: () => void
    readonly toggleFullscreen?: () => void
  } = {},
): PanelInput {
  return {
    name,
    sessionID: "ses_root",
    width: input.width ?? 100,
    presentation: "panel",
    focused: input.focused ?? true,
    focus: () => {},
    close: input.close ?? (() => {}),
    toggleFullscreen: input.toggleFullscreen ?? (() => {}),
  }
}

const sessions = [
  session({ id: "ses_root", title: "root" }),
  session({ id: "ses_two", title: "second" }),
  session({ id: "ses_three", title: "third" }),
]

test("arrow keys move the rail, enter opens the selected view", async () => {
  const recorded = recordingContext({ sessions })
  const app = await mount(
    () => <InspectorPanel context={recorded.value} live={live({})} panel={panel(PANEL.details)} />,
    { width: 100, height: 24 },
  )
  try {
    expect(recorded.pushes).toEqual(["banyancode.panel"])
    expect(app.captureCharFrame()).toContain("› Details")

    expect(await recorded.press("Next panel")).toBe(true)
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("› Todo")

    expect(await recorded.press("Open panel")).toBe(true)
    expect(recorded.opened).toEqual([PANEL.todos])
  } finally {
    app.renderer.destroy()
  }
})

test("f toggles fullscreen and the header names both keys", async () => {
  const recorded = recordingContext({ sessions })
  let toggles = 0
  const app = await mount(
    () => (
      <InspectorPanel
        context={recorded.value}
        live={live({})}
        panel={panel(PANEL.details, { toggleFullscreen: () => (toggles += 1) })}
      />
    ),
    { width: 100, height: 24 },
  )
  try {
    const frame = app.captureCharFrame()
    expect(frame).toContain("f fullscreen")
    expect(frame).toContain("esc close")
    expect(await recorded.press("Toggle fullscreen")).toBe(true)
    expect(toggles).toBe(1)
  } finally {
    app.renderer.destroy()
  }
})

test("views with their own list scrollbar do not draw a second panel bar", async () => {
  expect(panelScrollsInternally(PANEL.agents)).toBe(true)
  expect(panelScrollsInternally(PANEL.config)).toBe(true)
  expect(panelScrollsInternally(PANEL.sessions)).toBe(true)
  expect(panelScrollsInternally(PANEL.details)).toBe(false)
  expect(panelScrollsInternally(PANEL.trace)).toBe(false)
})

test("panel keys stay inactive while the pane is not focused", async () => {
  const recorded = recordingContext({ sessions })
  const app = await mount(
    () => <InspectorPanel context={recorded.value} live={live({})} panel={panel(PANEL.details, { focused: false })} />,
    { width: 100, height: 24 },
  )
  try {
    expect(recorded.pushes).toEqual([])
  } finally {
    app.renderer.destroy()
  }
})

test("session rows move with the arrow keys and enter runs the focused action", async () => {
  const recorded = recordingContext({ sessions })
  const focus = createPanelFocus(0)
  focus.setZone("content")
  const app = await mount(
    () => (
      <PanelFocusContext.Provider value={focus}>
        <SessionsView context={recorded.value} />
      </PanelFocusContext.Provider>
    ),
    { width: 100, height: 24 },
  )
  try {
    expect(await recorded.press("Next row")).toBe(true)
    expect(await recorded.press("Next row")).toBe(true)
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("▸ ☆ second")

    expect(await recorded.press("Run action")).toBe(true)
    expect(recorded.navigated).toEqual([{ type: "session", sessionID: "ses_two" }])
  } finally {
    app.renderer.destroy()
  }
})

test("page keys scroll the panel's own list", async () => {
  const many = Array.from({ length: 40 }, (_, index) => session({ id: `ses_${index}`, title: `session ${index}` }))
  const recorded = recordingContext({ sessions: many })
  const app = await mount(
    () => <InspectorPanel context={recorded.value} live={live({})} panel={panel(PANEL.sessions)} />,
    { width: 100, height: 16 },
  )
  try {
    const scroll = app.renderer.root.findDescendantById("banyancode.panel.content")! as unknown as ScrollBoxRenderable
    expect(scroll.scrollTop).toBe(0)
    expect(await recorded.press("Scroll panel down")).toBe(true)
    await Bun.sleep(0)
    await app.renderOnce()
    expect(scroll.scrollTop).toBeGreaterThan(0)
    expect(await recorded.press("Scroll panel to top")).toBe(true)
    await Bun.sleep(0)
    await app.renderOnce()
    expect(scroll.scrollTop).toBe(0)
  } finally {
    app.renderer.destroy()
  }
})
