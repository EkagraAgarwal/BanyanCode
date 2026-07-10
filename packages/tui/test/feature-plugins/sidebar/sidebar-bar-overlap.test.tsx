/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { readFileSync } from "fs"
import { resolve } from "path"

/**
 * Regression test for the sidebar text/bar overlap.
 *
 * Symptom: with the original Bar() implementation,
 *   <box flexDirection="row" flexGrow={1} flexBasis={0} flexShrink={1} height={1}>
 *     <box width="N%" height={1} flexShrink={1} />
 *     ...
 *   </box>
 * the bar wrapper's `flexGrow={1}` could cause vertical expansion when
 * nested inside column-direction flex containers (sidebar_content slot).
 * That made CPU and Memory bars render 4-30 rows tall, pushing the
 * "SYSTEM" and "MCP" labels inside the bar's painted area.
 *
 * Fix: remove `flexGrow={1}` (and the matching `flexBasis={0}` /
 * `flexShrink={1}` props) on the bar wrapper so it always occupies
 * exactly 1 row, regardless of how its parent is being measured.
 */
test("system-status Bar wrapper has no flexGrow that could force vertical expansion", () => {
  const source = readFileSync(
    resolve(__dirname, "../../../src/feature-plugins/sidebar/system-status.tsx"),
    "utf8",
  )
  const barBlock = source.match(/function Bar[\s\S]*?^}/m)?.[0] ?? ""
  expect(barBlock).not.toMatch(/flexGrow=\{1\}/)
  expect(barBlock).not.toMatch(/flexBasis=\{0\}/)
  expect(barBlock).not.toMatch(/flexShrink=\{1\}/)
})

test("system-status Bar wrapper declares explicit height + width", () => {
  const source = readFileSync(
    resolve(__dirname, "../../../src/feature-plugins/sidebar/system-status.tsx"),
    "utf8",
  )
  expect(source).toContain('<box flexDirection="row" height={1} width="100%">')
})

test("system-status metric blocks are flexDirection=column with the Bar inside", () => {
  const source = readFileSync(
    resolve(__dirname, "../../../src/feature-plugins/sidebar/system-status.tsx"),
    "utf8",
  )
  // For each CPU/Memory/Disk metric, the Show wrapper should be a column box,
  // the label row should be a row inside it, and the Bar should be the next
  // sibling of the label row (not wrapped in another non-column box).
  const cpuBlock = source.match(/<Show when=\{cpuPercent\(\)[^}]*\}>[\s\S]*?<\/Show>/)?.[0] ?? ""
  expect(cpuBlock).toMatch(/flexDirection="column"/)
  expect(cpuBlock).toMatch(/<Bar percent=\{cpuPercent/)
  expect(cpuBlock).not.toMatch(/<box width="100%">\s*<Bar/)
})

test("system-status plugin root is flexDirection=column", () => {
  const source = readFileSync(
    resolve(__dirname, "../../../src/feature-plugins/sidebar/system-status.tsx"),
    "utf8",
  )
  expect(source).toMatch(/return \(\s*<box flexDirection="column" gap=\{0\}>/)
})