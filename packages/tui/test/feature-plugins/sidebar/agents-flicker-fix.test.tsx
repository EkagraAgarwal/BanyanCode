/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { readFileSync } from "fs"
import { resolve } from "path"

/**
 * Regression test for the dashed-separator flicker in the AGENTS sidebar.
 *
 * Symptom (user report): the dashed red lines below the AGENTS peer list
 * disappear for a frame and the content below jumps up, then the lines
 * reappear and the content jumps back down.
 *
 * Root cause: the dashed separator `<text>` and the "Total across all
 * agents" row were nested INSIDE the `<Show when={peers().length > 0}>`
 * block. The mesh status bridge republishes status on an interval; between
 * publishes, a transient empty-peers event (or any path where peers
 * momentarily has length 0) flipped the Show off, removing the separator
 * and the totals row from the layout. Content below then reflowed upward.
 * Once the next publish arrived with non-empty peers, both came back and
 * the content reflowed downward. Hence the visible up-down jump.
 *
 * Fix: hoist the separator + totals row OUT of the Show block. They now
 * render unconditionally regardless of whether peers is empty or not.
 *
 * These source-level assertions verify the fix structurally:
 *   1. The dashed separator text appears AFTER the </Show> close tag.
 *   2. The "Total across all agents" row also appears AFTER the </Show>.
 *   3. Neither appears BEFORE the </Show> close tag inside the when branch.
 */
test("agents sidebar: dashed separator sits outside the peers Show block", () => {
  const source = readFileSync(
    resolve(__dirname, "../../../src/feature-plugins/sidebar/agents.tsx"),
    "utf8",
  )

  // The dashed separator text uses DashedDividerChars.horizontal.
  const dashedIdx = source.indexOf("DashedDividerChars.horizontal.repeat")
  expect(dashedIdx).toBeGreaterThan(-1)

  // The closing tag of the peers <Show when={peers().length > 0}> block.
  const peersShowStart = source.indexOf('<Show\n        when={peers().length > 0}')
  expect(peersShowStart).toBeGreaterThan(-1)

  // Find the matching </Show>. The Show contains nested markup (a <box>
  // wrapping the For), so we look forward from peersShowStart for the
  // first </Show> tag and assert the separator is BEFORE that close.
  const tail = source.slice(peersShowStart)
  const closingShowIdx = tail.indexOf("</Show>")
  expect(closingShowIdx).toBeGreaterThan(-1)

  // Compute the absolute index of </Show> in the file.
  const absoluteClosingShow = peersShowStart + closingShowIdx

  // The dashed separator's index must be AFTER the </Show> close.
  expect(dashedIdx).toBeGreaterThan(absoluteClosingShow)

  // Sanity: the separator must not be embedded inside the Show block.
  expect(dashedIdx).toBeGreaterThan(closingShowIdx)
})

test("agents sidebar: Total across all agents row sits outside the peers Show block", () => {
  const source = readFileSync(
    resolve(__dirname, "../../../src/feature-plugins/sidebar/agents.tsx"),
    "utf8",
  )

  const totalsIdx = source.indexOf("Total across all agents")
  expect(totalsIdx).toBeGreaterThan(-1)

  const peersShowStart = source.indexOf('<Show\n        when={peers().length > 0}')
  expect(peersShowStart).toBeGreaterThan(-1)
  const tail = source.slice(peersShowStart)
  const closingShowIdx = tail.indexOf("</Show>")
  expect(closingShowIdx).toBeGreaterThan(-1)

  // The totals row must also be AFTER </Show>, not inside it.
  const absoluteClosingShow = peersShowStart + closingShowIdx
  expect(totalsIdx).toBeGreaterThan(absoluteClosingShow)
})

test("agents sidebar: peer list block remains inside the Show (it should still toggle)", () => {
  // Sanity check that we didn't accidentally also hoist the peer list out.
  // The peer list <For> must remain INSIDE the Show block so empty peers
  // can still show "No active agents".
  const source = readFileSync(
    resolve(__dirname, "../../../src/feature-plugins/sidebar/agents.tsx"),
    "utf8",
  )

  const peersShowStart = source.indexOf('<Show\n        when={peers().length > 0}')
  expect(peersShowStart).toBeGreaterThan(-1)
  const tail = source.slice(peersShowStart)
  const closingShowIdx = tail.indexOf("</Show>")
  expect(closingShowIdx).toBeGreaterThan(-1)

  const peerForIdx = tail.indexOf("<For each={peers()}>")
  expect(peerForIdx).toBeGreaterThan(-1)

  // Peer list is INSIDE the Show (before </Show>).
  expect(peerForIdx).toBeLessThan(closingShowIdx)

  // "No active agents" fallback must still exist (inside the Show).
  const fallbackIdx = source.indexOf("No active agents")
  expect(fallbackIdx).toBeGreaterThan(-1)
})