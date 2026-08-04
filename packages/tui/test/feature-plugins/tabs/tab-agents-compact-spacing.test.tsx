/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { readFileSync } from "fs"
import { resolve } from "path"

/**
 * Regression test for CONFIG tab compactness (tab-agents.tsx).
 *
 * Goal: non-editing agent card is exactly 4 rows and there are ZERO
 * blank rows between adjacent cards. The AGENTS tab (tab-agent-tree.tsx)
 * is the design reference — border-less rows separated only by a bottom
 * border, tight spacing.
 *
 * These assertions ensure the compact layout does not regress after a
 * future edit (e.g. someone re-introducing `gap={1}` on the scroll
 * content column or `marginTop={1}` spacers between cards).
 */

function readTabAgents(): string {
  return readFileSync(
    resolve(__dirname, "../../../src/feature-plugins/tabs/tab-agents.tsx"),
    "utf8",
  )
}

test("tab-agents: scrollbox inner column uses gap=0", () => {
  const source = readTabAgents()
  // The scroll content column that holds the group labels and cards must
  // use gap={0}. It used to be gap={1}, which added a blank row between
  // every sibling (labels and cards).
  expect(source).toContain('<box flexDirection="column" paddingTop={0} gap={0}>')
})

test("tab-agents: subagents column uses gap=0", () => {
  const source = readTabAgents()
  // The column that lists the subagent cards must use gap={0} so there is
  // no blank row between adjacent cards.
  expect(source).toContain(
    '<box flexDirection="column" paddingLeft={2} paddingRight={2} gap={0}>',
  )
})

test("tab-agents: no gap=1 inside the scroll content region", () => {
  const source = readTabAgents()
  // The scrollbox content (from the opening scrollbox tag to its closing
  // tag) must not contain any gap={1}. The only remaining gap={1} usages
  // live inside AgentCard (title row, merged Model·Prompt row) and the
  // editing branch — all outside the scroll content column.
  const scrollMatch = source.match(/<scrollbox[\s\S]*?<\/scrollbox>/)
  expect(scrollMatch).not.toBeNull()
  expect(scrollMatch![0]).not.toMatch(/gap=\{1\}/)
})

test("tab-agents: GroupLabel uses paddingTop=0", () => {
  const source = readTabAgents()
  // GroupLabel must use paddingTop={0} so it does not push the label away
  // from the previous card, adding a blank row.
  expect(source).toContain(
    '<text fg={toHex(props.theme.textMuted)} paddingLeft={2} paddingTop={0}>',
  )
})

test("tab-agents: no marginTop=1 spacers in the card-list region", () => {
  const source = readTabAgents()
  // No manual marginTop={1} spacers may appear between cards. The card
  // list is the scroll content column, which spans from the scrollbox to
  // the end of the subagents column.
  const scrollContent = source.slice(source.indexOf("<scrollbox"), source.indexOf("</scrollbox>"))
  expect(scrollContent).not.toMatch(/marginTop=\{1\}/)
  // And the file as a whole must not introduce marginTop spacers either.
  expect(source).not.toMatch(/marginTop=\{1\}/)
})

test("tab-agents: AgentCard uses bottom-border only (no full rounded box)", () => {
  const source = readTabAgents()
  // The AgentCard outer box must be a bottom-border row (matching the
  // tab-agent-tree header style), not a full 4-sided rounded box.
  expect(source).toContain('border={["bottom"]}')
  expect(source).not.toContain('border={["left", "right", "top", "bottom"]}')
  expect(source).not.toContain("RoundedBorder")
})
