/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import {
  Spinner,
  sessionAllowsSpinner,
  shouldSpinSpinner,
  spinnerClockState,
} from "../../src/component/spinner"
import { TestTuiContexts } from "../fixture/tui-environment"
import { ThemeProvider } from "../../src/context/theme"
import { KVProvider } from "../../src/context/kv"
import { TuiConfigProvider } from "../../src/config"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"

describe("spinner gate (shouldSpinSpinner)", () => {
  test("dangling running part while session idle does not spin", () => {
    expect(
      shouldSpinSpinner({ partRunning: true, messageCompleted: false, sessionStatus: { type: "idle" } }),
    ).toBe(false)
  })
  test("running part with busy session and open message spins", () => {
    expect(
      shouldSpinSpinner({ partRunning: true, messageCompleted: false, sessionStatus: { type: "busy" } }),
    ).toBe(true)
  })
  test("retry session counts as busy", () => {
    expect(
      shouldSpinSpinner({ partRunning: true, messageCompleted: false, sessionStatus: { type: "retry" } }),
    ).toBe(true)
  })
  test("completed owning message never spins, even when busy", () => {
    expect(
      shouldSpinSpinner({ partRunning: true, messageCompleted: true, sessionStatus: { type: "busy" } }),
    ).toBe(false)
  })
  test("non-running part never spins", () => {
    expect(
      shouldSpinSpinner({ partRunning: false, messageCompleted: false, sessionStatus: { type: "busy" } }),
    ).toBe(false)
  })
  test("unknown session status spins (bootstrap window stays fail-visible)", () => {
    expect(shouldSpinSpinner({ partRunning: true, messageCompleted: false, sessionStatus: undefined })).toBe(true)
    expect(sessionAllowsSpinner(undefined)).toBe(true)
    expect(sessionAllowsSpinner({ type: "idle" })).toBe(false)
    expect(sessionAllowsSpinner({ type: "busy" })).toBe(true)
  })
})

function SpinnerHarness(props: { count: number }) {
  return (
    <TestTuiContexts>
      <TuiConfigProvider config={createTuiResolvedConfig()}>
        <KVProvider>
          <ThemeProvider mode="dark">
            <box width={40} height={props.count + 1}>
              {Array.from({ length: props.count }, (_, index) => (
                <text>work {index}</text>
              ))}
              {Array.from({ length: props.count }, (_, index) => (
                <Spinner>spin {index}</Spinner>
              ))}
            </box>
          </ThemeProvider>
        </KVProvider>
      </TuiConfigProvider>
    </TestTuiContexts>
  )
}

describe("shared spinner clock", () => {
  async function waitFor(app: { renderOnce: () => Promise<void> }, predicate: () => boolean, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error("timed out waiting for spinner clock condition")
      await Bun.sleep(20)
      await app.renderOnce()
    }
  }

  test("N mounted spinners share one clock; last unmount stops it", async () => {
    const before = spinnerClockState()
    const app = await testRender(() => <SpinnerHarness count={3} />, { width: 40, height: 6 })
    try {
      await waitFor(app, () => spinnerClockState().mounted === before.mounted + 3)
      await app.renderOnce()
      const during = spinnerClockState()
      expect(during.mounted).toBe(before.mounted + 3)
      expect(during.running).toBe(true)
    } finally {
      app.renderer.destroy()
    }
    const after = spinnerClockState()
    expect(after.mounted).toBe(before.mounted)
    if (before.mounted === 0) expect(after.running).toBe(false)
  })

  test("inactive spinner renders a static glyph and holds no clock slot", async () => {
    const before = spinnerClockState()
    const app = await testRender(
      () => (
        <TestTuiContexts>
          <TuiConfigProvider config={createTuiResolvedConfig()}>
            <KVProvider>
              <ThemeProvider mode="dark">
                <box width={40} height={2}>
                  <Spinner active={false}>stalled work</Spinner>
                </box>
              </ThemeProvider>
            </KVProvider>
          </TuiConfigProvider>
        </TestTuiContexts>
      ),
      { width: 40, height: 2 },
    )
    try {
      const deadline = Date.now() + 5000
      let frame = ""
      while (!frame.includes("◇")) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for static spinner glyph\nlast frame:\n${frame}`)
        await Bun.sleep(20)
        await app.renderOnce()
        frame = app.captureCharFrame()
      }
      expect(frame).toContain("◇")
      expect(spinnerClockState().mounted).toBe(before.mounted)
    } finally {
      app.renderer.destroy()
    }
  })
})
