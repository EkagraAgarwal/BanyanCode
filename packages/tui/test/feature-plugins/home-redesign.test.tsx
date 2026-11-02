import { expect, test } from "bun:test"
import type { SessionInfo } from "@opencode/client"
import { createAppFixture } from "../fixture/app"
import { directory, json } from "../fixture/tui-client"

// captureCharFrame ends with a newline; rows() drops the empty tail so at(-1) is the last rendered row.
const rows = (frame: string) => frame.replace(/\n$/, "").split("\n")

const resumeSession = (id: string, title: string, updated: number): SessionInfo => ({
  id,
  projectID: "proj_test",
  agent: "build",
  title,
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated },
  location: { directory },
})

const sessions = [
  resumeSession("ses_oldest", "Oldest task", 1_000),
  resumeSession("ses_newest", "Newest task", 3_000),
  resumeSession("ses_middle", "Middle task", 2_000),
]

const resumeFetch = (url: URL) => {
  if (url.pathname === "/api/session") return json({ data: sessions, cursor: {} })
  const match = sessions.find((item) => url.pathname === `/api/session/${item.id}`)
  if (match) return json({ data: match })
  return undefined
}

const sessionFetch = (url: URL) => {
  if (url.pathname === "/api/session/ses_test") return json({ data: resumeSession("ses_test", "Session", 3_000) })
  if (url.pathname === "/api/session/ses_test/message") return json({ data: [], cursor: {} })
  if (url.pathname === "/api/session/ses_test/inbox") return json({ data: [] })
  return undefined
}

const promptTop = (lines: readonly string[]) => lines.findIndex((line) => line.includes("╭"))
const promptBottom = (lines: readonly string[]) => {
  const top = promptTop(lines)
  if (top < 0) return -1
  const bottom = lines.findIndex((line, index) => index > top && line.includes("╰"))
  return bottom
}
const promptBlock = (frame: string) => {
  const lines = rows(frame)
  const top = promptTop(lines)
  const bottom = promptBottom(lines)
  return top < 0 || bottom < 0 ? [] : lines.slice(top, bottom + 1)
}
const indexOf = (lines: readonly string[], needle: string) => lines.findIndex((line) => line.includes(needle))

const home = async (input: { width: number; height: number; fetch?: typeof resumeFetch; args?: { sessionID: string } }) => {
  const setup = await createAppFixture(input)
  await setup.ready
  await setup.waitFor(() => setup.captureCharFrame().trim().length > 0, { maxPasses: 400 })
  return setup
}

test("the home footer is one row: directory, update notice, version", async () => {
  const setup = await createAppFixture({
    width: 120,
    height: 40,
    updater: {
      remote: false,
      subscribe: (notify) => {
        notify({ type: "available", version: "9.9.9" })
        return () => {}
      },
      check: async () => undefined,
      apply: async () => {},
    },
  })
  try {
    await setup.ready
    await setup.waitFor(() => setup.captureCharFrame().trim().length > 0, { maxPasses: 400 })
    await setup.waitFor(() => rows(setup.captureCharFrame()).at(-1)?.includes("9.9.9") ?? false, { maxPasses: 200 })

    const frame = setup.captureCharFrame()
    const row = rows(frame).at(-1) ?? ""
    const above = rows(frame).at(-2) ?? ""

    // Everything shares the last row: the footer carries no bottom padding, and
    // nothing wrapped onto a second row.
    expect(row).toContain("/tmp/opencode/packages/tui")
    expect(row).toContain("/update")
    expect(row).toContain("to install v9.9.9")
    expect(row).toContain("test")
    // Left to right: directory, then the notice, then the installed version.
    expect(row.indexOf("packages/tui")).toBeLessThan(row.indexOf("/update"))
    expect(row.indexOf("/update")).toBeLessThan(row.indexOf("to install v9.9.9"))
    expect(row.indexOf("to install v9.9.9")).toBeLessThan(row.lastIndexOf("test"))
    // No footer content leaked into the row above: the row is exactly one line.
    expect(above).not.toContain("/update")
    expect(above).not.toContain("packages/tui")
  } finally {
    await setup[Symbol.asyncDispose]()
  }
}, 60000)

test("home.logo renders the claim, and the host logo without one", async () => {
  const claimed = await createAppFixture({ width: 100, height: 30 })
  let withClaim = ""
  try {
    await claimed.ready
    await claimed.waitFor(() => claimed.captureCharFrame().trim().length > 0, { maxPasses: 400 })
    withClaim = claimed.captureCharFrame()
  } finally {
    await claimed[Symbol.asyncDispose]()
  }

  const plain = await createAppFixture({
    width: 100,
    height: 30,
    config: { animations: false, plugins: ["-banyancode.tui"] },
  })
  let withoutClaim = ""
  try {
    await plain.ready
    await plain.waitFor(() => plain.captureCharFrame().includes("████   ███"), { maxPasses: 400 })
    withoutClaim = plain.captureCharFrame()
  } finally {
    await plain[Symbol.asyncDispose]()
  }

  // The host Logo draws the wordmark in blocks; the claimed slot shows the hero instead.
  expect(withoutClaim).toContain("████   ███")
  expect(withClaim).not.toContain("████   ███")
  expect(withClaim).toContain("test")
}, 60000)

test("120x40 holds the whole layout: hero, prompt, three sessions, one footer row", async () => {
  const setup = await home({ width: 120, height: 40, fetch: resumeFetch })
  try {
    await setup.waitFor(() => setup.captureCharFrame().includes("RESUME"), { maxPasses: 400 })
    const frame = setup.captureCharFrame()
    const lines = rows(frame)

    expect(lines).toHaveLength(40)
    // The hero's wordmark and the prompt box keep their space.
    expect(frame).toContain("█▀▀▀▄")
    const top = promptTop(lines)
    const bottom = promptBottom(lines)
    expect(top).toBeGreaterThan(0)
    expect(bottom - top).toBe(5)
    expect(lines.slice(top, bottom).join("\n")).toContain("Ask anything")
    // No prompt location row: the footer already carries the directory and branch.
    expect(frame).not.toContain("packages/tui:main")

    // The list sits directly under the prompt and above the footer row.
    expect(lines[bottom + 1].trim()).toBe("RESUME")
    expect(lines[bottom + 2]).toContain("1 Newest task")
    expect(lines[bottom + 3]).toContain("2 Middle task")
    expect(lines[bottom + 4]).toContain("3 Oldest task")
    const footer = lines.at(-1) ?? ""
    expect(lines).toHaveLength(bottom + 6)
    expect(footer).toContain("/tmp/opencode/packages/tui")
    // The prompt hints lost their own row, so the footer carries them.
    expect(footer).toContain("ctrl+p commands")
    expect(footer).toContain("test")
  } finally {
    await setup[Symbol.asyncDispose]()
  }
}, 60000)

test("120x43 restores the two breathing rows", async () => {
  const setup = await home({ width: 120, height: 43, fetch: resumeFetch })
  try {
    await setup.waitFor(() => setup.captureCharFrame().includes("RESUME"), { maxPasses: 400 })
    const lines = rows(setup.captureCharFrame())

    const top = promptTop(lines)
    const resume = indexOf(lines, "RESUME")
    expect(top).toBeGreaterThan(0)
    expect(lines[top - 1].trim()).toBe("")
    expect(resume).toBeGreaterThan(0)
    expect(lines[resume - 1].trim()).toBe("")
    // The wordmark ends above the gap.
    expect(lines[top - 2]).toContain("▀▀▀▀")
  } finally {
    await setup[Symbol.asyncDispose]()
  }
}, 60000)

test("200x55 centres the block between the top and the footer", async () => {
  const setup = await home({ width: 200, height: 55, fetch: resumeFetch })
  try {
    await setup.waitFor(() => setup.captureCharFrame().includes("RESUME"), { maxPasses: 400 })
    const lines = rows(setup.captureCharFrame())
    expect(lines).toHaveLength(55)

    const top = lines.findIndex((line) => line.trim().length > 0)
    const lastContent = lines.findLastIndex((line, index) => index < lines.length - 1 && line.trim().length > 0)
    const footer = lines.length - 1
    expect(lines[footer]).toContain("packages/tui")
    const above = top
    const below = footer - 1 - lastContent
    expect(Math.abs(above - below)).toBeLessThanOrEqual(1)
  } finally {
    await setup[Symbol.asyncDispose]()
  }
}, 60000)

test.each([
  [100, 30],
  [72, 18],
  [71, 17],
  [60, 12],
])("nothing overflows the home layout at %sx%s", async (width, height) => {
  const setup = await home({ width, height, fetch: resumeFetch })
  try {
    await setup.waitFor(() => setup.captureCharFrame().includes("RESUME"), { maxPasses: 400 })
    const frame = setup.captureCharFrame()
    const lines = rows(frame)
    expect(lines).toHaveLength(height)

    // The prompt box is whole, and the list fits above whatever the bottom row is.
    const top = promptTop(lines)
    const bottom = promptBottom(lines)
    expect(top).toBeGreaterThanOrEqual(0)
    expect(bottom).toBeGreaterThan(top)
    expect(bottom).toBeLessThan(height - 4)
    const oldest = indexOf(lines, "3 Oldest task")
    expect(oldest).toBeGreaterThan(bottom)
    expect(oldest).toBeLessThanOrEqual(height - 1)

    // Whatever owns the last row, the list was not clipped off the screen.
    const last = lines.at(-1) ?? ""
    expect(last.includes("packages/tui") || last.includes("3 Oldest task")).toBe(true)
  } finally {
    await setup[Symbol.asyncDispose]()
  }
}, 60000)

test("the prompt never moves when the session list resolves", async () => {
  const gate = Promise.withResolvers<void>()
  const setup = await createAppFixture({
    width: 120,
    height: 40,
    fetch: async (url, request) => {
      if (url.pathname === "/api/session") {
        await gate.promise
        return json({ data: sessions, cursor: {} })
      }
      return resumeFetch(url)
    },
  })
  try {
    await setup.ready
    await setup.waitFor(() => promptTop(rows(setup.captureCharFrame())) > 0, { maxPasses: 400 })
    const before = setup.captureCharFrame()
    expect(before).not.toContain("RESUME")

    gate.resolve()
    await setup.waitFor(() => setup.captureCharFrame().includes("RESUME"), { maxPasses: 200 })
    const after = setup.captureCharFrame()

    expect(promptTop(rows(after))).toBe(promptTop(rows(before)))
    expect(promptBlock(after)).toEqual(promptBlock(before))
  } finally {
    await setup[Symbol.asyncDispose]()
  }
}, 60000)

test("a session's prompt keeps its location row", async () => {
  const setup = await createAppFixture({ width: 120, height: 40, args: { sessionID: "ses_test" }, fetch: sessionFetch })
  try {
    await setup.ready
    await setup.waitFor(() => setup.captureCharFrame().includes("packages/tui:main"), { maxPasses: 400 })
    const frame = setup.captureCharFrame()
    expect(frame).toContain("packages/tui:main")
    // Home's footer is not on screen in a session, so this row is the only copy.
    expect(frame).not.toContain("RESUME")
  } finally {
    await setup[Symbol.asyncDispose]()
  }
}, 60000)
