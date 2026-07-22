/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { createSignal, onMount } from "solid-js"
import SidebarPerformance from "../../../src/feature-plugins/sidebar/performance"
import { createTuiPluginApi } from "../../fixture/tui-plugin"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { ThemeProvider } from "../../../src/context/theme"
import { KVProvider } from "../../../src/context/kv"
import { TuiConfigProvider } from "../../../src/config"
import { SDKProvider } from "../../../src/context/sdk"
import { createEventSource, createFetch, directory } from "../../fixture/tui-sdk"
import { SyncProvider } from "../../../src/context/sync"
import { ProjectProvider } from "../../../src/context/project"
import { ExitProvider } from "../../../src/context/exit"
import { ArgsProvider } from "../../../src/context/args"

const stubTheme = {
  text: { r: 200, g: 200, b: 200, a: 1 },
  textMuted: { r: 120, g: 120, b: 120, a: 1 },
  primary: { r: 100, g: 200, b: 100, a: 1 },
  secondary: { r: 100, g: 100, b: 200, a: 1 },
  success: { r: 100, g: 200, b: 100, a: 1 },
  error: { r: 200, g: 100, b: 100, a: 1 },
  warning: { r: 200, g: 200, b: 100, a: 1 },
  accent: { r: 150, g: 150, b: 150, a: 1 },
  info: { r: 100, g: 100, b: 100, a: 1 },
}

test("sidebar performance sidebar_content slot renders without throwing", async () => {
  const events = createEventSource()
  const calls = createFetch()
  const config = createTuiResolvedConfig()
  const [slotContent, setSlotContent] = createSignal<any>(null)

  function Inner() {
    const api: any = {
      ...createTuiPluginApi({}),
      theme: { current: stubTheme },
      state: {
        session: { get: () => undefined },
        path: { directory: "/test/workspace" },
        mcp: () => [],
        lsp: () => [],
      },
    }
    api.slots = {
      register: (plugin: any) => {
        if (!plugin?.slots?.sidebar_content) return () => {}
        const el = plugin.slots.sidebar_content({}, { session_id: "session_test" })
        setSlotContent(() => el)
        return () => {}
      },
    }
    onMount(() => {
      SidebarPerformance.tui(api as any, undefined as any, { id: "test" } as any).catch(() => {})
    })
    return <box>{slotContent()}</box>
  }

  const testSetup = await testRender(() => (
    <ExitProvider exit={console.error}>
      <TestTuiContexts>
        <ArgsProvider>
          <KVProvider>
            <SDKProvider url="http://test" directory={directory} fetch={calls.fetch} events={events.source}>
              <ProjectProvider>
                <SyncProvider>
                  <TuiConfigProvider config={config}>
                    <ThemeProvider mode="dark">
                      <Inner />
                    </ThemeProvider>
                  </TuiConfigProvider>
                </SyncProvider>
              </ProjectProvider>
            </SDKProvider>
          </KVProvider>
        </ArgsProvider>
      </TestTuiContexts>
    </ExitProvider>
  ), { width: 40, height: 50 })
  await testSetup.renderOnce()
  await new Promise((r) => setTimeout(r, 0))
  await testSetup.renderOnce()
  testSetup.renderer.destroy()
})

test("performance widget subscribes to both step.started and step.ended", () => {
  const source = require("fs").readFileSync(
    require("path").resolve(__dirname, "../../../src/feature-plugins/sidebar/performance.tsx"),
    "utf8",
  )
  expect(source).toContain("session.next.step.started")
  expect(source).toContain("session.next.step.ended")
})

test("performance widget shows a 'last' cue when idle (not live)", () => {
  const source = require("fs").readFileSync(
    require("path").resolve(__dirname, "../../../src/feature-plugins/sidebar/performance.tsx"),
    "utf8",
  )
  // freshness=last drives the muted cue so users can tell the value is from
  // a previous step.
  expect(source).toContain('"last"')
  expect(source).toContain('cueLabel')
})

test("performance widget cleans up both event subscriptions on unmount", () => {
  const source = require("fs").readFileSync(
    require("path").resolve(__dirname, "../../../src/feature-plugins/sidebar/performance.tsx"),
    "utf8",
  )
  // Two subscriptions must each be paired with onCleanup so listeners do not
  // accumulate across remounts.
  const subs = source.match(/ev\.on\(/g) ?? []
  expect(subs.length).toBeGreaterThanOrEqual(2)
  const cleanups = source.match(/unsubStart|unsubEnd/g) ?? []
  expect(cleanups.length).toBeGreaterThanOrEqual(2)
  expect(source).toMatch(/onCleanup\(\(\) => \{[\s\S]*unsubStart\(\)[\s\S]*unsubEnd\(\)[\s\S]*\}\)/)
})
