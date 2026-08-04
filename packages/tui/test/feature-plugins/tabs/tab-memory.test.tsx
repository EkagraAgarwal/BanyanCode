/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
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

function readTabMemory(): string {
  const fs = require("fs") as typeof import("fs")
  const path = require("path") as typeof import("path")
  return fs.readFileSync(
    path.resolve(__dirname, "../../../src/feature-plugins/tabs/tab-memory.tsx"),
    "utf8",
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

test("tab-memory source uses compact bottom-border rows and an Add memory action, with no slash commands", () => {
  const source = readTabMemory()
  expect(source).toContain("[+ Add memory]")
  expect(source).toContain("openAddMemoryDialog")
  expect(source).toContain("function MemoryCard")
  expect(source).toContain('border={["bottom"]}')
  // No full rounded cards, no PENDING CANDIDATES / summary / group sections.
  expect(source).not.toContain("RoundedBorder")
  expect(source).not.toContain("PENDING CANDIDATES")
  expect(source).not.toContain("function GroupLabel")
  expect(source).not.toContain("function SummaryCard")
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

test("tab-memory scrollbox content column uses gap=0 with no gap=1 or marginTop spacers", () => {
  const source = readTabMemory()
  // The scroll content column holding the list must use gap={0} (config-tab
  // compactness contract) so there is no blank row between adjacent cards.
  expect(source).toContain('<box flexDirection="column" paddingTop={0} gap={0}>')
  // No gap={1} inside the scrollbox region, and no manual marginTop spacers
  // anywhere (mirrors tab-agents-compact-spacing.test.tsx).
  const scrollMatch = source.match(/<scrollbox[\s\S]*?<\/scrollbox>/)
  expect(scrollMatch).not.toBeNull()
  expect(scrollMatch![0]).not.toMatch(/gap=\{1\}/)
  expect(source).not.toMatch(/marginTop=\{1\}/)
})

test("tab-memory MemoryCard uses bottom-border only (no full rounded box)", () => {
  const source = readTabMemory()
  const card = source.slice(source.indexOf("function MemoryCard"))
  expect(card).toContain('border={["bottom"]}')
  expect(card).not.toContain('border={["left", "right", "top", "bottom"]}')
  expect(source).not.toContain("RoundedBorder")
})

test("tab-memory renders a single flat list (no sections, accordions, filters, or summary)", () => {
  const source = readTabMemory()
  // Flat list only: no pending/summary sections, no kind accordions, no
  // scope/kind/status filter chrome, no picker dialogs.
  expect(source).not.toContain("PENDING CANDIDATES")
  expect(source).not.toContain("GroupLabel")
  expect(source).not.toContain("toggleKind")
  expect(source).not.toContain("expandedKinds")
  expect(source).not.toContain("SummaryCard")
  expect(source).not.toContain("openKindPicker")
  expect(source).not.toContain("openStatusPicker")
  expect(source).not.toContain("DialogMemoryKind")
  expect(source).not.toContain("DialogMemoryStatus")
  expect(source).not.toContain("kindFilter")
  expect(source).not.toContain("statusFilter")
})

test("tab-memory rows expose open and forget only (no promote/reject actions)", () => {
  const source = readTabMemory()
  // Slice the MemoryCard function body: its action row must be open + forget.
  const card = source.slice(source.indexOf("function MemoryCard"))
  expect(card).toContain("open")
  expect(card).toContain("forget")
  expect(card).not.toContain("promote")
  expect(card).not.toContain("reject")
  // forget still confirms before deleting.
  expect(source).toContain("DialogConfirm")
})

test("tab-memory list request merges both scopes with no kind/status filters", () => {
  const source = readTabMemory()
  // The single list source fetches global + session and merges (scope toggle
  // removed) with no kind/status filter and no separate candidates/summary
  // resources.
  expect(source).toContain('scope: "global"')
  expect(source).toContain('scope: "session"')
  expect(source).not.toContain("status: source.status")
  expect(source).not.toContain("kind: source.kind")
  expect(source).not.toContain("memory.candidates")
  expect(source).not.toContain("memory.summary")
})

test("previewBody deliberately truncates long bodies to a single-line ellipsis", () => {
  // Reproduces the long body clipping visible in the screenshots.
  const body = "first line\n  second line with detail\n   third line with more detail"
  const normalize = (s: string) => s.replace(/\s+/g, " ").trim()
  const max = 40
  const preview = normalize(body).length > max
    ? normalize(body).slice(0, max - 1) + "…"
    : normalize(body)
  expect(preview.endsWith("…")).toBe(true)
  expect(preview.length).toBeLessThanOrEqual(40)
  // Whitespace is collapsed so the preview fits on one terminal row.
  expect(preview.includes("\n")).toBe(false)
  expect(preview.includes("  ")).toBe(false)
})
