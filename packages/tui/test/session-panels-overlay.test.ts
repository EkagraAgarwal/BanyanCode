import { expect, test } from "bun:test"
import { resolve } from "../src/config"
import { settings, settingID } from "../src/component/dialog-config"
import { createPanelState, panelEaseOut, panelSpring } from "../src/context/panel"

test("classic is the default chat layout and trunk stays selectable", () => {
  expect(resolve({}, { terminalSuspend: true }).session_layout).toBe("classic")
  expect(resolve({ session_layout: "trunk" }, { terminalSuspend: true }).session_layout).toBe("trunk")
  // The setting is surfaced in the settings dialog, next to the sidebar, and shows classic first.
  const setting = settings.find((item) => settingID(item) === "session_layout")
  expect(setting).toBeDefined()
  expect(setting?.values).toEqual(["classic", "trunk"])
  expect(setting?.default).toBe("classic")
})

test("the trunk panels overlay opens and closes on its own state", () => {
  const panels = createPanelState()
  expect(panels.overlay()).toBe(false)
  // `session.sidebar.toggle` toggles it in the trunk layout.
  panels.toggleOverlay()
  expect(panels.overlay()).toBe(true)
  panels.toggleOverlay()
  expect(panels.overlay()).toBe(false)
  // Escape runs closeOverlay, which is a no-op when it is already closed.
  panels.toggleOverlay()
  panels.closeOverlay()
  panels.closeOverlay()
  expect(panels.overlay()).toBe(false)
})

test("the overlay is presentation state, not a panel selection", () => {
  const panels = createPanelState()
  panels.openOverlay()
  panels.open({ plugin: "banyancode.tui", name: "banyancode.agents", sessionID: "ses_one" })
  expect(panels.overlay()).toBe(true)
  expect(panels.current()?.name).toBe("banyancode.agents")
  // Closing the panel under it leaves the overlay exactly as it was.
  panels.close()
  expect(panels.overlay()).toBe(true)
  expect(panels.current()).toBeUndefined()
})

test("the overlay springs open and eases out closed, always inside its column", () => {
  expect(panelSpring(0)).toBe(0)
  expect(panelSpring(1)).toBeCloseTo(1, 6)
  // The spring overshoots, which is why the width is held to its column.
  for (const progress of [0.1, 0.2, 0.35, 0.5, 0.8, 1, 1.5]) {
    const width = panelSpring(progress)
    expect(width).toBeGreaterThanOrEqual(0)
    expect(width).toBeLessThanOrEqual(1)
  }

  expect(panelEaseOut(0)).toBe(0)
  expect(panelEaseOut(0.5)).toBeCloseTo(0.875, 6)
  expect(panelEaseOut(1)).toBe(1)
  expect(panelEaseOut(-1)).toBe(0)
  expect(panelEaseOut(2)).toBe(1)
})
