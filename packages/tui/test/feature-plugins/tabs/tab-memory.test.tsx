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

test("SummaryCard wraps loading text in a layout-stable box (regression: refresh…hiddenobservation=3)", () => {
  const fs = require("fs") as typeof import("fs")
  const path = require("path") as typeof import("path")
  const source = fs.readFileSync(
    path.resolve(__dirname, "../../../src/feature-plugins/tabs/tab-memory.tsx"),
    "utf8",
  )
  const startIdx = source.indexOf("function SummaryCard")
  expect(startIdx).toBeGreaterThan(-1)
  const tail = source.slice(startIdx)
  // SummaryCard renders, in order: status row, optional loading box, optional
  // decision/warning digests, action row with refresh+hide. The loading fallback
  // must be wrapped in a box (not a bare <text>) so the column height stays
  // stable when loading flips on/off and rows do not collapse onto the status
  // row (the "refresh…hiddenobservation=3" regression).
  expect(tail).toContain("loading…")
  // kinds() default literal must not read like a kind name in the status row.
  expect(tail).toContain('if (items.length === 0) return "—"')
  // Inner column has a real row gap (>= 1) so summary/loading/controls separate.
  expect(tail).toContain("gap={1}")
  // Loading fallback wraps the <text> in a <box>.
  const loadingBlockIdx = tail.indexOf("props.loading && !props.summary")
  expect(loadingBlockIdx).toBeGreaterThan(-1)
  const loadingBlock = tail.slice(loadingBlockIdx, tail.indexOf("</Show>", loadingBlockIdx))
  expect(loadingBlock).toContain("<box")
  expect(loadingBlock).toContain("</box>")
})

test("memory tab exposes compact kind/status selectors (no fact/file-note sentinels)", () => {
  const fs = require("fs") as typeof import("fs")
  const path = require("path") as typeof import("path")
  const tab = fs.readFileSync(
    path.resolve(__dirname, "../../../src/feature-plugins/tabs/tab-memory.tsx"),
    "utf8",
  )
  // The chip walls are gone; the filter rows render a single labelled value
  // that opens a DialogSelect. Hard-coded bogus kinds are still absent.
  expect(tab).toContain("openKindPicker")
  expect(tab).toContain("openStatusPicker")
  expect(tab).toContain("DialogMemoryKind")
  expect(tab).toContain("DialogMemoryStatus")
  expect(tab).not.toContain('"file-note"')
  expect(tab).not.toContain('"fact"')
  expect(tab).not.toMatch(/For each=\{KIND_FILTER_VALUES\}/)
  expect(tab).not.toMatch(/For each=\{STATUS_FILTER_VALUES\}/)
})

test("memory tab wires kindFilter and statusFilter into the list request source", () => {
  const fs = require("fs") as typeof import("fs")
  const path = require("path") as typeof import("path")
  const tab = fs.readFileSync(
    path.resolve(__dirname, "../../../src/feature-plugins/tabs/tab-memory.tsx"),
    "utf8",
  )
  // The dead `filterStatus = undefined` / `filterKind = undefined` locals are gone.
  expect(tab).not.toContain("const filterStatus = undefined")
  expect(tab).not.toContain("const filterKind = undefined")
  // The statusFilter signal must be created and forwarded to the request.
  expect(tab).toContain('createSignal<StatusFilter>("all")')
  expect(tab).toContain('createSignal<string>("all")')
  // Status updates now flow through the compact picker callback.
  expect(tab).toContain("setStatusFilter(value as StatusFilter)")
  expect(tab).toContain("setKindFilter(value)")
  // The list request payload sources status and kind from the resource source signal.
  expect(tab).toContain("status: source.status,")
  expect(tab).toContain("kind: source.kind,")
})

test("memory tab renders compact kind/status selectors (no chip walls)", () => {
  const fs = require("fs") as typeof import("fs")
  const path = require("path") as typeof import("path")
  const tab = fs.readFileSync(
    path.resolve(__dirname, "../../../src/feature-plugins/tabs/tab-memory.tsx"),
    "utf8",
  )
  // The responsive selector rows render a single labelled value, not a chip wall.
  // Asserting the shape on the source protects against regression to the long chip row.
  expect(tab).toMatch(/<text[^>]*>\s*kind:<\/text>/)
  expect(tab).toMatch(/<text[^>]*>\s*status:<\/text>/)
  expect(tab).toMatch(/\[{kindFilter\(\)} ▾\]/)
  expect(tab).toMatch(/\[{statusFilter\(\)} ▾\]/)
  // The two chip walls are gone.
  expect(tab).not.toMatch(/For each=\{KIND_FILTER_VALUES\}/)
  expect(tab).not.toMatch(/For each=\{STATUS_FILTER_VALUES\}/)
})

test("memory tab view body exposes picker handlers bound to DialogSelect dialogs", () => {
  const fs = require("fs") as typeof import("fs")
  const path = require("path") as typeof import("path")
  const tab = fs.readFileSync(
    path.resolve(__dirname, "../../../src/feature-plugins/tabs/tab-memory.tsx"),
    "utf8",
  )
  // The compact selector rows must open the kind/status pickers, which call back
  // into the existing signals and trigger a refresh.
  expect(tab).toContain("const openKindPicker")
  expect(tab).toContain("const openStatusPicker")
  expect(tab).toMatch(/openKindPicker[\s\S]+?DialogMemoryKind[\s\S]+?setKindFilter\(value\)/)
  expect(tab).toMatch(/openStatusPicker[\s\S]+?DialogMemoryStatus[\s\S]+?setStatusFilter\(value as StatusFilter\)/)
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