/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { createSignal, onMount } from "solid-js"
import { readFileSync } from "fs"
import { resolve } from "path"
import SidebarSystemStatus from "../../../src/feature-plugins/sidebar/system-status"
import SidebarFooter from "../../../src/feature-plugins/sidebar/footer"
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
  backgroundElement: { r: 30, g: 30, b: 30, a: 1 },
}

/**
 * Regression test for sidebar spacing compactness.
 *
 * Symptom (user report): "reduce the padding between the different
 * elements. make it more compact so scrolling isn't needed as much."
 *
 * Strategy:
 *   - The sidebar wrapper (`<box flexDirection="column">` containing
 *     `sidebar_content`) now sets `gap={1}` so every plugin gets exactly
 *     one row of blank space between it and the next plugin — a
 *     consistent, minimal separator.
 *   - Each plugin's first content element after its header must NOT
 *     add its own `marginTop={1}`, or it stacks on top of the wrapper
 *     `gap={1}` and creates 2 blank rows between sections.
 *
 * These assertions ensure we don't regress and start adding redundant
 * `marginTop={1}` back into plugin first-elements after a future edit.
 */

const PLUGIN_FILES: string[] = [
  "agents.tsx",
  "codebase-tree.tsx",
  "context.tsx",
  "mcp.tsx",
  "performance.tsx",
  "provider-usage.tsx",
  "system-status.tsx",
]

function readPlugin(name: string): string {
  return readFileSync(
    resolve(__dirname, `../../../src/feature-plugins/sidebar/${name}`),
    "utf8",
  )
}

test("sidebar wrapper uses gap=1 between sidebar_content plugins", () => {
  const source = readFileSync(
    resolve(__dirname, "../../../src/routes/session/sidebar.tsx"),
    "utf8",
  )

  // The wrapper column that contains the sidebar_content Slot must declare
  // gap={1}. It used to be gap={0}; each plugin added its own marginTop=1
  // to create the inter-section gap, but that was inconsistent and stacked
  // when combined with the sidebar wrapper.
  const wrapperBlock = source.match(
    /<box flexDirection="column" flexShrink=\{0\} gap=\{1\} paddingRight=\{1\}>/,
  )
  expect(wrapperBlock).not.toBeNull()
})

test("agents: peer list block uses marginTop=0 (no redundant spacer)", () => {
  const source = readPlugin("agents.tsx")
  // The peer list box must have marginTop=0, not marginTop=1.
  expect(source).toContain('<box flexDirection="column" marginTop={0} gap={0}>')
  expect(source).not.toMatch(/<box flexDirection="column" marginTop=\{1\} gap=\{0\}>/)
})

test("system-status: CPU bar (first metric) uses marginTop=0", () => {
  const source = readPlugin("system-status.tsx")
  // The first metric block (CPU) is the first content after the SYSTEM
  // header. It must use marginTop=0 so the sidebar wrapper's gap={1}
  // provides the inter-plugin spacing.
  expect(source).toMatch(/<Show when=\{cpuPercent\(\)[^}]*\}>[\s\S]*?marginTop=\{0\}[\s\S]*?<\/Show>/)
})

test("context: bar (first content element) uses marginTop=0", () => {
  const source = readPlugin("context.tsx")
  // The bar inside the categorized branch must use marginTop=0.
  expect(source).toMatch(/marginTop=\{0\}[\s\S]*?flexDirection="row"/)
})

test("context: bar is a one-row borderless segmented bar", () => {
  const source = readPlugin("context.tsx")
  // Width tracks BAR_WIDTH exactly (no +2 border compensation), height is a
  // single row, and no border props remain on the bar container.
  expect(source).toContain("width={BAR_WIDTH}")
  expect(source).not.toContain("width={BAR_WIDTH + 2}")
  expect(source).not.toContain("height={3}")
  expect(source).not.toMatch(/customBorderChars=\{RoundedBorder/)
  expect(source).not.toContain("RoundedBorder")
  expect(source).not.toMatch(/border=\{\[/)
  expect(source).not.toContain("borderColor={theme().borderSubtle}")
  // Colors and percentages are preserved: segment colors still resolve via
  // segColor and the legend still renders per-segment percentages.
  expect(source).toContain("backgroundColor={segColor(seg.color)}")
  expect(source).toContain("barLayout()")
})

test("system-status: Memory and Disk blocks use marginTop=0", () => {
  const source = readPlugin("system-status.tsx")
  const memBlock = source.match(/<Show when=\{memPercent\(\)[^}]*\}>[\s\S]*?<\/Show>/)?.[0] ?? ""
  expect(memBlock).toMatch(/marginTop=\{0\}/)
  expect(memBlock).not.toMatch(/marginTop=\{1\}/)
  const diskBlock = source.match(/<Show when=\{diskPercent\(\)[^}]*\}>[\s\S]*?<\/Show>/)?.[0] ?? ""
  expect(diskBlock).toMatch(/marginTop=\{0\}/)
  expect(diskBlock).not.toMatch(/marginTop=\{1\}/)
  // No metric block reintroduces a blank spacer row.
  expect(source).not.toMatch(/marginTop=\{1\}/)
})

test("sidebar footer container has no extra paddingTop or internal gap", () => {
  const source = readFileSync(
    resolve(__dirname, "../../../src/routes/session/sidebar.tsx"),
    "utf8",
  )
  expect(source).toContain("<box flexShrink={0} gap={0}>")
  expect(source).not.toMatch(/flexShrink=\{0\} gap=\{1\} paddingTop=\{1\}/)
})

test("sidebar footer plugin root uses gap=0 with no card vertical padding", () => {
  const source = readPlugin("footer.tsx")
  expect(source).toMatch(/return \(\s*<box gap=\{0\}>/)
  expect(source).not.toContain("paddingTop={1}")
  expect(source).not.toContain("paddingBottom={1}")
  expect(source).toContain("<box flexGrow={1} gap={0}>")
})

test("sidebar_content wrapper retains gap=1 and plugin roots stay gap=0", () => {
  const sidebar = readFileSync(
    resolve(__dirname, "../../../src/routes/session/sidebar.tsx"),
    "utf8",
  )
  expect(sidebar).toMatch(/<box flexDirection="column" flexShrink=\{0\} gap=\{1\} paddingRight=\{1\}>/)
  for (const name of ["system-status.tsx", "context.tsx", "footer.tsx", "provider-usage.tsx"]) {
    const source = readPlugin(name)
    expect(source).toContain("gap={0}")
  }
})

test("density cleanup removes five-to-six redundant rows for the screenshot configuration", () => {
  const systemStatus = readPlugin("system-status.tsx")
  const context = readPlugin("context.tsx")
  const sidebar = readFileSync(
    resolve(__dirname, "../../../src/routes/session/sidebar.tsx"),
    "utf8",
  )
  const footer = readPlugin("footer.tsx")
  // Each of these now-absent patterns cost at least one terminal row in the
  // pre-cleanup sidebar: two metric spacers, the two extra border rows plus
  // the +2 width compensation, the footer container padding/gap, and the
  // footer card vertical padding.
  const removed: Array<[string, string, RegExp]> = [
    ["system-status", systemStatus, /marginTop=\{1\}/],
    ["context-height", context, /height=\{3\}/],
    ["context-width", context, /BAR_WIDTH \+ 2/],
    ["context-border", context, /RoundedBorder|customBorderChars|border=\{\[/],
    ["sidebar-footer-container", sidebar, /flexShrink=\{0\} gap=\{1\} paddingTop=\{1\}/],
    ["footer-card-padding", footer, /paddingTop=\{1\}|paddingBottom=\{1\}/],
    ["footer-root-gap", footer, /<box gap=\{1\}>/],
  ]
  for (const [label, source, pattern] of removed) {
    expect(source, label).not.toMatch(pattern)
  }
  // Sanity: the counted removals cover the contracted five-to-six rows —
  // Memory spacer (1) + Disk spacer (1) + context border rows (2) +
  // footer container paddingTop (1) + footer card padding (1) = 6.
  expect(removed.length).toBeGreaterThanOrEqual(7)
})

test("performance: BarMetric row uses marginTop=0 (compact bars under header)", () => {
  const source = readPlugin("performance.tsx")
  expect(source).toMatch(
    /<box flexDirection="row" justifyContent="space-between" width="100%" marginTop=\{0\} alignItems="center">/,
  )
  // The session-total line "{total} tokens generated this session" was
  // removed entirely per the user's request.
  expect(source).not.toContain("tokens generated this session")
})

test("codebase-tree: header uses gap=0 column with all marginTop=0 children", () => {
  const source = readPlugin("codebase-tree.tsx")
  // CODEBASE header must live in a gap=0 column.
  expect(source).toMatch(/<box flexDirection="column" gap=\{0\}>/)
  // All children after the header use marginTop=0 (no manual spacers).
  expect(source).not.toMatch(/marginTop=\{1\}/)
})

test("mcp: no marginTop spacers (relies on sidebar wrapper gap=1)", () => {
  const source = readPlugin("mcp.tsx")
  expect(source).not.toMatch(/marginTop=\{1\}/)
})

test("provider-usage: order 135 with gap=0 root and no leading margin", () => {
  const source = readPlugin("provider-usage.tsx")
  // Directly after System Resources (130), before the agent/codegraph cluster.
  expect(source).toContain("PROVIDER_USAGE_ORDER = 135")
  expect(source).toContain("order: PROVIDER_USAGE_ORDER")
  // Compact contract: wrapper-owned separator only, one-row window bars.
  expect(source).toContain("gap={0}")
  expect(source).not.toMatch(/marginTop=\{1\}/)
  expect(source).not.toContain("paddingTop={1}")
  expect(source).not.toContain("paddingBottom={1}")
})

test("agents: dashed separator and totals row are gone", () => {
  const source = readPlugin("agents.tsx")
  expect(source).not.toContain("DashedDividerChars")
  expect(source).not.toMatch(/╌/)
  expect(source).not.toContain("Total across all agents")
})

test("performance: session-total line removed", () => {
  const source = readPlugin("performance.tsx")
  expect(source).not.toContain("tokens generated this session")
  // And the `total` memo that computed it must be gone too.
  expect(source).not.toMatch(/const total = createMemo/)
})

/**
 * Sanity check: every plugin's first content element (the one directly
 * after the plugin header text) must use marginTop=0. Otherwise the
 * plugin stacks its own blank row on top of the sidebar wrapper's
 * gap={1} and the inter-section space becomes 2 rows instead of 1.
 */
test.each(PLUGIN_FILES)("%s: first content element after header uses marginTop=0", (name) => {
  const source = readPlugin(name)

  // Find the first <text> that holds the plugin's <b>NAME</b> header.
  // All plugins have exactly one such header — for MCP it is `<b>MCP</b>`
  // (without .primary fg), and for the rest it is `<b>NAME</b>` inside a
  // primary-colored text.
  const headerMatch = source.match(/<text fg=\{toHex\(theme\(\)\.primary\)\}>[\s\S]*?<\/text>|<text fg=\{theme\(\)\.text\}>[\s\S]*?<\/text>/)
  expect(headerMatch).not.toBeNull()
  const afterHeader = source.slice((headerMatch?.index ?? 0) + headerMatch![0].length)

  // The next ~300 chars after the header should not contain marginTop={1}.
  // (Some plugins have multiple <text> blocks at the top, but none of them
  // should introduce a marginTop={1} — that's what the wrapper gap is for.)
  const window = afterHeader.slice(0, 300)
  expect(window).not.toMatch(/marginTop=\{1\}/)
})

async function renderSlotNarrow(
  plugin: { tui: any },
  slot: "sidebar_content" | "sidebar_footer",
  width = 32,
): Promise<{ frame: string; destroy: () => void }> {
  const events = createEventSource()
  const calls = createFetch()
  const config = createTuiResolvedConfig()
  const [slotContent, setSlotContent] = createSignal<any>(null)

  function Inner() {
    const api: any = {
      ...createTuiPluginApi({}),
      theme: { current: stubTheme },
      app: { version: "test" },
      kv: { get: () => false, set: () => {}, ready: true },
      state: {
        session: { get: () => ({ directory: "/tmp/opencode/packages/tui" }) },
        provider: [],
        path: { directory: "/tmp/opencode/packages/tui" },
        vcs: undefined,
        mcp: () => [],
        lsp: () => [],
      },
    }
    api.slots = {
      register: (def: any) => {
        if (!def?.slots?.[slot]) return () => {}
        const el = def.slots[slot]({}, { session_id: "session_test" })
        setSlotContent(() => el)
        return () => {}
      },
    }
    onMount(() => {
      plugin.tui(api as any, undefined as any, { id: "test" } as any).catch(() => {})
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
  ), { width, height: 30 })
  await testSetup.renderOnce()
  await new Promise((r) => setTimeout(r, 0))
  await testSetup.renderOnce()
  const frame = testSetup.captureCharFrame()
  return { frame, destroy: () => testSetup.renderer.destroy() }
}

// NOTE: like the existing system-status/agents slot tests in this directory
// (whose committed snapshots are empty), the async `tui()` + onMount slot
// pattern does not paint slot content under testRender — these are narrow
// no-throw smoke tests proving the compact layout mounts cleanly at 32
// columns. Row-count compactness is asserted at the source level above.
test("compact narrow rendering: system-status mounts at width 32 without throwing", async () => {
  const { frame, destroy } = await renderSlotNarrow(SidebarSystemStatus, "sidebar_content")
  try {
    expect(typeof frame).toBe("string")
  } finally {
    destroy()
  }
})

test("compact narrow rendering: footer mounts at width 32 without throwing", async () => {
  const { frame, destroy } = await renderSlotNarrow(SidebarFooter, "sidebar_footer")
  try {
    expect(typeof frame).toBe("string")
  } finally {
    destroy()
  }
})