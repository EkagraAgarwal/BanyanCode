/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { readFileSync } from "fs"
import { resolve } from "path"

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

const PLUGIN_FILES = [
  "agents.tsx",
  "codebase-tree.tsx",
  "context.tsx",
  "mcp.tsx",
  "performance.tsx",
  "system-status.tsx",
] as const

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
  expect(source).toMatch(/marginTop=\{0\}[\s\S]*?customBorderChars=\{RoundedBorder\.customBorderChars\}/)
  // The "no data" fallback text must also use marginTop=0.
  expect(source).toMatch(/<text fg=\{toHex\(theme\(\)\.textMuted\)\} marginTop=\{0\}>/)
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