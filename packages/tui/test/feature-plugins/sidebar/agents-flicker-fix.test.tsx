/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { readFileSync } from "fs"
import { resolve } from "path"

/**
 * Regression test for the AGENTS sidebar's dashed separator removal.
 *
 * History:
 *   - v1: the dashed separator was nested INSIDE
 *     <Show when={peers().length > 0}>. The mesh status bridge republishes
 *     status on an interval; any transient empty-peers event flipped the
 *     Show off, removing the separator from the layout, and the content
 *     below reflowed upward. Hence the visible flicker.
 *   - v2 (commit c00791b): hoisted the separator + totals row OUT of the
 *     Show block. That fixed the flicker but kept both elements.
 *   - v3 (this test): the user asked to drop the separator and the
 *     "Total across all agents" row entirely so the sidebar becomes more
 *     compact. This test now asserts:
 *       a. the dashed separator has been removed from agents.tsx;
 *       b. the "Total across all agents" row has been removed from agents.tsx;
 *       c. the peer list block remains inside the <Show when={peers().length > 0}>
 *          block (so empty peers still render the "No active agents" fallback);
 *       d. the unused DashedDividerChars import is no longer pulled in;
 *       e. the peer list has zero top margin (compact peer rows under header).
 */
test("agents sidebar: dashed separator has been removed", () => {
  const source = readFileSync(
    resolve(__dirname, "../../../src/feature-plugins/sidebar/agents.tsx"),
    "utf8",
  )
  expect(source).not.toContain("DashedDividerChars")
  expect(source).not.toMatch(/╌/)
  expect(source).not.toContain("DashedDividerChars.horizontal")
})

test("agents sidebar: Total across all agents row has been removed", () => {
  const source = readFileSync(
    resolve(__dirname, "../../../src/feature-plugins/sidebar/agents.tsx"),
    "utf8",
  )
  expect(source).not.toContain("Total across all agents")
})

test("agents sidebar: peer list block remains inside the Show (it should still toggle)", () => {
  // Sanity check that the peer list and the "No active agents" fallback are
  // still inside the peers Show block so the empty state still toggles.
  const source = readFileSync(
    resolve(__dirname, "../../../src/feature-plugins/sidebar/agents.tsx"),
    "utf8",
  )

  const peersShowStart = source.indexOf('<Show\n        when={visiblePeers().length > 0}')
  expect(peersShowStart).toBeGreaterThan(-1)
  const tail = source.slice(peersShowStart)
  const closingShowIdx = tail.indexOf("</Show>")
  expect(closingShowIdx).toBeGreaterThan(-1)

  const peerForIdx = tail.indexOf("<For each={visiblePeers()}>")
  expect(peerForIdx).toBeGreaterThan(-1)

  // Peer list is INSIDE the Show (before </Show>).
  expect(peerForIdx).toBeLessThan(closingShowIdx)

  // "No active agents" fallback must still exist (inside the Show).
  const fallbackIdx = source.indexOf("No active agents")
  expect(fallbackIdx).toBeGreaterThan(-1)
})

test("agents sidebar: peer list has zero top margin (compact under header)", () => {
  // The peer list box should sit immediately under the AGENTS header with
  // no extra blank row. This is what keeps the AGENTS section compact when
  // several peer rows are visible.
  const source = readFileSync(
    resolve(__dirname, "../../../src/feature-plugins/sidebar/agents.tsx"),
    "utf8",
  )
  const peerListBlock = source.match(
    /<box flexDirection="column" marginTop=\{0\} gap=\{0\}>/,
  )
  expect(peerListBlock).not.toBeNull()
})