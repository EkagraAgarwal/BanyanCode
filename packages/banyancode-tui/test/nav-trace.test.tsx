/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { SessionTabs, viewKeyForPanel } from "../src/components/panels/nav"
import { IntelTracePanel } from "../src/components/sidebar/intel-trace-panel"
import { PANEL } from "../src/constants"
import type { IntelEntry } from "../src/data/live"
import { context, intelLive, mount } from "./harness"

test("v1 CHAT/SESSIONS/AGENTS/CONFIG tabs render and map panel names", async () => {
  expect(viewKeyForPanel(PANEL.sessions)).toBe("sessions")
  expect(viewKeyForPanel(PANEL.agents)).toBe("agents")
  expect(viewKeyForPanel(PANEL.config)).toBe("config")
  expect(viewKeyForPanel(PANEL.details)).toBe("chat")

  const app = await mount(() => <SessionTabs context={context()} active="config" />, { width: 80, height: 4 })
  try {
    const frame = app.captureCharFrame()
    expect(frame).toContain("CHAT")
    expect(frame).toContain("SESSIONS")
    expect(frame).toContain("AGENTS")
    expect(frame).toContain("CONFIG")
  } finally {
    app.renderer.destroy()
  }
})

test("intel trace keeps a clean empty state and renders trace entries", async () => {
  const empty = await mount(
    () => <IntelTracePanel context={context()} sessionID="ses_root" intel={intelLive()} />,
    { width: 100, height: 10 },
  )
  try {
    const frame = empty.captureCharFrame()
    expect(frame).toContain("TRACE")
    expect(frame).toContain("No trace recorded yet")
  } finally {
    empty.renderer.destroy()
  }

  const entries: IntelEntry[] = [
    { id: "i1", kind: "trace", query: "repo", summary: "found symbol MemoryRepo" },
  ]
  const withEntries = await mount(
    () => <IntelTracePanel context={context()} sessionID="ses_root" intel={intelLive({ entries })} />,
    { width: 100, height: 10 },
  )
  try {
    const frame = withEntries.captureCharFrame()
    expect(frame).toContain("repo")
    expect(frame).toContain("found symbol MemoryRepo")
  } finally {
    withEntries.renderer.destroy()
  }
})
