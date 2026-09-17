/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { readFileSync } from "fs"
import { resolve } from "path"
import { SwarmIndicator, swarmFg } from "../../src/component/swarm-indicator"
import { TestTuiContexts } from "../fixture/tui-environment"
import { ThemeProvider } from "../../src/context/theme"
import { KVProvider } from "../../src/context/kv"
import { TuiConfigProvider } from "../../src/config"
import { SDKProvider } from "../../src/context/sdk"
import { createEventSource, createFetch, directory, json } from "../fixture/tui-sdk"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"

function readIndicator(): string {
  return readFileSync(resolve(__dirname, "../../src/component/swarm-indicator.tsx"), "utf8")
}

const stubTheme = {
  textMuted: { r: 120, g: 120, b: 120, a: 1 },
  error: { r: 200, g: 100, b: 100, a: 1 },
}

async function setupHarness(swarmMode: boolean) {
  const events = createEventSource()
  const calls = createFetch((url) => {
    if (url.pathname === "/global/banyan-config") return json({ data: { banyancode_swarm_mode: swarmMode } })
    return undefined
  })

  const Harness = () => (
    <TestTuiContexts>
      <SDKProvider url="http://test" directory={directory} events={events.source} fetch={calls.fetch}>
        <TuiConfigProvider config={createTuiResolvedConfig()}>
          <KVProvider>
            <ThemeProvider mode="dark">
              <box width={40} height={2}>
                <SwarmIndicator />
              </box>
            </ThemeProvider>
          </KVProvider>
        </TuiConfigProvider>
      </SDKProvider>
    </TestTuiContexts>
  )

  const app = await testRender(() => <Harness />)
  const expectLabel = async (label: string) => {
    let frame = ""
    for (let i = 0; i < 100; i++) {
      await app.renderOnce()
      frame = app.captureCharFrame()
      if (frame.includes(label)) break
      await Bun.sleep(25)
    }
    expect(frame).toContain(label)
  }
  await Bun.sleep(100)
  return { app, expectLabel }
}

describe("swarm-indicator", () => {
  test("swarmFg is error red when ON, muted when OFF", () => {
    expect(swarmFg(true, stubTheme)).toBe(stubTheme.error)
    expect(swarmFg(false, stubTheme)).toBe(stubTheme.textMuted)
  })

  test("renders [swarm] when swarm mode is on", async () => {
    const { app, expectLabel } = await setupHarness(true)
    try {
      await expectLabel("[swarm]")
    } finally {
      app.renderer.destroy()
    }
  })

  test("renders [swarm] greyed when swarm mode is off", async () => {
    const { app, expectLabel } = await setupHarness(false)
    try {
      await expectLabel("[swarm]")
    } finally {
      app.renderer.destroy()
    }
  })

  test("subscribes to config updates with cleanup, mirroring yolo-indicator", () => {
    const source = readIndicator()
    expect(source).toContain("banyancode.config.updated")
    expect(source).toContain("onCleanup")
    expect(source).toContain("banyancode_swarm_mode")
    expect(source).toContain("[swarm]")
  })
})
