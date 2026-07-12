/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { createSignal, onMount } from "solid-js"
import TabMemory from "../../../src/feature-plugins/tabs/tab-memory"
import { createTuiPluginApi } from "../../fixture/tui-plugin"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { ThemeProvider } from "../../../src/context/theme"
import { KVProvider } from "../../../src/context/kv"
import { TuiConfigProvider } from "../../../src/config"
import { SDKProvider } from "../../../src/context/sdk"
import { DialogProvider } from "../../../src/ui/dialog"
import { createEventSource, createFetch, directory } from "../../fixture/tui-sdk"

const stubTheme = {
  text: { r: 200, g: 200, b: 200, a: 1 },
  textMuted: { r: 120, g: 120, b: 120, a: 1 },
  primary: { r: 100, g: 200, b: 100, a: 1 },
  secondary: { r: 100, g: 100, b: 200, a: 1 },
  success: { r: 100, g: 200, b: 100, a: 1 },
  error: { r: 200, g: 100, b: 100, a: 1 },
  warning: { r: 200, g: 200, b: 100, a: 1 },
  border: { r: 60, g: 60, b: 60, a: 1 },
  info: { r: 100, g: 150, b: 220, a: 1 },
  background: { r: 20, g: 20, b: 20, a: 1 },
}

function Harness(props: { children: any }) {
  const events = createEventSource()
  const calls = createFetch()
  const config = createTuiResolvedConfig()
  return (
    <TestTuiContexts>
      <SDKProvider url="http://test" directory={directory} events={events.source} fetch={calls.fetch}>
        <TuiConfigProvider config={config}>
          <KVProvider>
            <DialogProvider>
              <ThemeProvider mode="dark">{props.children}</ThemeProvider>
            </DialogProvider>
          </KVProvider>
        </TuiConfigProvider>
      </SDKProvider>
    </TestTuiContexts>
  )
}

test("tab-memory session_tab_memory slot renders without throwing", async () => {
  const [slotContent, setSlotContent] = createSignal<any>(null)

  const Inner = () => {
    const api: any = {
      ...createTuiPluginApi({}),
      theme: { current: stubTheme },
    }
    api.slots = {
      register: (plugin: any) => {
        if (!plugin?.slots?.session_tab_memory) return () => {}
        const el = plugin.slots.session_tab_memory()
        setSlotContent(() => el)
        return () => {}
      },
    }
    onMount(() => {
      void TabMemory.tui(api as any, undefined as any, { id: "test" } as any)
    })

    return <box>{slotContent()}</box>
  }

  const app = await testRender(
    () => (
      <Harness>
        <Inner />
      </Harness>
    ),
    { width: 60, height: 40 },
  )
  await app.renderOnce()
  try {
    expect(true).toBe(true)
  } finally {
    app.renderer.destroy()
  }
})

test("tab-memory source uses RoundedBorder cards and an Add memory action, with no slash commands", () => {
  const fs = require("fs") as typeof import("fs")
  const path = require("path") as typeof import("path")
  const source = fs.readFileSync(
    path.resolve(__dirname, "../../../src/feature-plugins/tabs/tab-memory.tsx"),
    "utf8",
  )
  expect(source).toContain("RoundedBorder")
  expect(source).toContain("[+ Add memory]")
  expect(source).toContain("openAddMemoryDialog")
  expect(source).toContain("function GroupLabel")
  expect(source).toContain("function MemoryCard")
  expect(source).toContain("function SummaryCard")
  expect(source).toContain("PENDING CANDIDATES")
  expect(source).not.toContain("slashName")
  expect(source).not.toContain('slashName: "memory-add"')
  expect(source).not.toContain('slashName: "memory-search"')
  expect(source).not.toContain('slashName: "memory-recall"')
  expect(source).not.toContain('slashName: "memory-summary"')
  expect(source).not.toContain('slashName: "memory-forget"')
  expect(source).not.toContain('slashName: "memory-pending"')
})

test("app.tsx no longer registers the six memory slash commands", () => {
  const fs = require("fs") as typeof import("fs")
  const path = require("path") as typeof import("path")
  const source = fs.readFileSync(path.resolve(__dirname, "../../../src/app.tsx"), "utf8")
  expect(source).not.toContain('name: "memory.add"')
  expect(source).not.toContain('name: "memory.recall"')
  expect(source).not.toContain('name: "memory.search"')
  expect(source).not.toContain('name: "memory.summary"')
  expect(source).not.toContain('name: "memory.forget"')
  expect(source).not.toContain('name: "memory.pending"')
  expect(source).not.toContain("runMemorySearch")
  expect(source).not.toContain("runMemorySummary")
})

test("SummaryCard source pushes the first content row below the top border", () => {
  const fs = require("fs") as typeof import("fs")
  const path = require("path") as typeof import("path")
  const source = fs.readFileSync(
    path.resolve(__dirname, "../../../src/feature-plugins/tabs/tab-memory.tsx"),
    "utf8",
  )
  // The bordered container should set paddingTop={1} (or wrap content in a padded inner box)
  // so the status row never collides with the rounded top border.
  expect(source).toMatch(/function SummaryCard[\s\S]+paddingTop=\{1\}/)
})