import { expect, test } from "bun:test"
import { mkdir, mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { SessionInfo } from "@opencode/client"
import type { Config } from "../../src/config"
import { createAppFixture } from "../fixture/app"
import { directory, json, type FetchHandler } from "../fixture/tui-client"

// captureCharFrame ends with a newline; rows() drops the empty tail so at(-1) is the last rendered row.
const rows = (frame: string) => frame.replace(/\n$/, "").split("\n")

/** Seeds persisted session tabs so Home renders under a real tab strip. */
async function tabsState() {
  const state = await mkdtemp(path.join(tmpdir(), "banyan-home-tabs-"))
  const tui = path.join(state, "test", "tui")
  await mkdir(tui, { recursive: true })
  await Bun.write(
    path.join(tui, "tabs.json"),
    JSON.stringify({
      global: { tabs: sessions.map((item) => ({ sessionID: item.id, title: item.title })), unread: {} },
      cwd: {},
    }),
  )
  return state
}

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

/** Resume plus what the tab strip asks each open tab for. */
const tabFetch = (url: URL) => {
  const base = resumeFetch(url)
  if (base) return base
  if (/^\/api\/session\/[^/]+\/message$/.test(url.pathname)) return json({ data: [], cursor: {} })
  if (/^\/api\/session\/[^/]+\/inbox$/.test(url.pathname)) return json({ data: [] })
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

const home = async (input: {
  width: number
  height: number
  fetch?: FetchHandler
  args?: { sessionID: string }
  config?: Config.Info
  state?: string
}) => {
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
  // The compact palette hint at 100 columns is the footer's proof the plugin is in;
  // the version now yields to it below 120.
  expect(withClaim).toContain("^p cmds")
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

/**
 * The host owns rows Home does not: a tab strip at the top, the devtools bar at
 * the bottom. Neither may push the resume block over the footer.
 */
const assertNoOverlap = (frame: string, height: number, shown: boolean) => {
  const lines = rows(frame)
  expect(lines).toHaveLength(height)
  const footer = lines.findIndex((line) => line.includes("packages/tui"))
  expect(footer).toBeGreaterThan(0)
  const resume = lines.findIndex((line) => line.trim() === "RESUME")
  expect(resume >= 0).toBe(shown)
  if (resume < 0) {
    // Dropped as a whole, never half drawn.
    expect(frame).not.toContain("1 Newest task")
    return
  }
  // The whole block: header plus three rows, all above the footer.
  expect(resume + 4).toBeLessThanOrEqual(footer)
  expect(lines[resume + 1]).toContain("1 Newest task")
  expect(lines[resume + 2]).toContain("2 Middle task")
  expect(lines[resume + 3]).toContain("3 Oldest task")
}

const CHROME_SIZES: ReadonlyArray<readonly [number, number, boolean]> = [
  // Chrome costs the list, never the tree: 120x40 keeps the 29-row hero and
  // drops RESUME, 120x42 still fits both, and 60x12 has no room left for either.
  [120, 40, false],
  [120, 42, true],
  [60, 12, false],
  [200, 55, true],
]

/** The hero's tree rows: every row from the first braille row down to the rule. */
const treeRows = (lines: readonly string[]) => {
  const rule = lines.findIndex((line) => line.includes("─"))
  const first = lines.findIndex((line) => /[\u2800-\u28ff]/.test(line))
  return rule < 0 || first < 0 || first > rule ? 0 : rule - first
}

/** Holds the session list back so the pre- and post-fetch layouts are both checkable. */
const gated = (fetch: FetchHandler) => {
  const gate = Promise.withResolvers<void>()
  const handler: FetchHandler = async (url, request) => {
    if (url.pathname === "/api/session") await gate.promise
    return fetch(url, request)
  }
  return { gate, fetch: handler }
}

const settle = async (setup: Awaited<ReturnType<typeof home>>) => {
  await setup.waitFor(() => setup.captureCharFrame().includes("packages/tui"), { maxPasses: 400 })
  await Bun.sleep(100)
  await setup.renderOnce()
}

test.each(CHROME_SIZES)("a tab strip never overlaps the footer or clips the resume block at %sx%s", async (width, height, shown) => {
  const { gate, fetch } = gated(tabFetch)
  const setup = await home({
    width,
    height,
    fetch,
    state: await tabsState(),
    config: { animations: false, tabs: { scope: "global" } },
  })
  try {
    await settle(setup)
    gate.resolve()
    await Bun.sleep(100)
    await setup.renderOnce()
    const frame = setup.captureCharFrame()
    // The strip really is on screen, above everything else.
    expect(rows(frame)[0]).toContain("Newest")
    assertNoOverlap(frame, height, shown)
  } finally {
    await setup[Symbol.asyncDispose]()
  }
}, 60000)

test.each(CHROME_SIZES)("the devtools bar never overlaps the footer or clips the resume block at %sx%s", async (width, height, shown) => {
  const { gate, fetch } = gated(resumeFetch)
  const setup = await home({
    width,
    height,
    fetch,
    config: { animations: false, debug: { devtools: true } },
  })
  try {
    await settle(setup)
    gate.resolve()
    await Bun.sleep(100)
    await setup.renderOnce()
    const frame = setup.captureCharFrame()
    // The bar really is on screen, below the footer.
    expect(rows(frame).at(-1)).toContain("Server")
    assertNoOverlap(frame, height, shown)
  } finally {
    await setup[Symbol.asyncDispose]()
  }
}, 60000)

/** Home under real host chrome: a tab strip, the devtools bar, or both. */
const chromeHome = async (input: { height: number; tabs: boolean; devtools: boolean; fetch: FetchHandler }) => {
  const { gate, fetch } = gated(input.fetch)
  const setup = await home({
    width: 120,
    height: input.height,
    fetch,
    state: input.tabs ? await tabsState() : undefined,
    config: {
      animations: false,
      debug: { devtools: input.devtools },
      ...(input.tabs ? { tabs: { scope: "global" as const } } : {}),
    },
  })
  await settle(setup)
  gate.resolve()
  await Bun.sleep(100)
  await setup.renderOnce()
  return setup
}

test("a tab strip at 46 rows drops the hero to the short tier so the list still fits", async () => {
  const setup = await chromeHome({ height: 46, tabs: true, devtools: false, fetch: tabFetch })
  try {
    const frame = setup.captureCharFrame()
    expect(rows(frame)[0]).toContain("Newest")
    // Home has 45 rows: the tall tier also wants room for the list, the short one fits.
    expect(treeRows(rows(frame))).toBe(23)
    assertNoOverlap(frame, 46, true)
    // The measured height does not depend on the hero, so the frame is stable.
    await setup.renderOnce()
    expect(setup.captureCharFrame()).toBe(frame)
  } finally {
    await setup[Symbol.asyncDispose]()
  }
}, 60000)

test("at 47 rows the tall tree still fits under the strip", async () => {
  const setup = await chromeHome({ height: 47, tabs: true, devtools: false, fetch: tabFetch })
  try {
    const frame = setup.captureCharFrame()
    expect(rows(frame)[0]).toContain("Newest")
    expect(treeRows(rows(frame))).toBe(27)
    assertNoOverlap(frame, 47, true)
  } finally {
    await setup[Symbol.asyncDispose]()
  }
}, 60000)

test("a strip and the devtools bar keep the short tier and the list at 46 and 47", async () => {
  for (const height of [46, 47]) {
    const setup = await chromeHome({ height, tabs: true, devtools: true, fetch: tabFetch })
    try {
      const frame = setup.captureCharFrame()
      // Two chrome rows leave Home 44/45: the tall tier is out of reach, the short one is not.
      expect(treeRows(rows(frame))).toBe(23)
      assertNoOverlap(frame, height, true)
    } finally {
      await setup[Symbol.asyncDispose]()
    }
  }
}, 120000)

test("at 120x40 the tree keeps its tier and the list is the thing that goes", async () => {
  // One chrome row: Home has 39, so 29 + 6 + 4 + 1 no longer fits and RESUME drops.
  for (const [tabs, devtools, resume] of [
    [true, false, false],
    [true, true, false],
  ] as const) {
    const setup = await chromeHome({ height: 40, tabs, devtools, fetch: tabFetch })
    try {
      const frame = setup.captureCharFrame()
      expect(rows(frame)[0]).toContain("Newest")
      expect(treeRows(rows(frame))).toBe(23)
      expect(frame.includes("RESUME")).toBe(resume)
      // Nothing overlaps the footer and the prompt is whole.
      assertNoOverlap(frame, 40, resume)
      expect(promptTop(rows(frame))).toBeGreaterThan(0)
      expect(promptBottom(rows(frame))).toBeGreaterThan(promptTop(rows(frame)))
    } finally {
      await setup[Symbol.asyncDispose]()
    }
  }
}, 120000)

/**
 * A directory long enough that it only survives the footer row if the hints
 * give way first.
 */
const DEEP_DIRECTORY = "/home/somebody/workspace/deep/path/for/a/project-calls-project"

const deepFetch: FetchHandler = (url) => {
  if (url.pathname === "/api/location")
    return json({
      directory: DEEP_DIRECTORY,
      project: { id: "proj_test", directory: DEEP_DIRECTORY, canonical: DEEP_DIRECTORY },
    })
  if (url.pathname === "/api/session") return json({ data: [], cursor: {} })
  return undefined
}

test("the footer keeps a palette hint at every width and gives up the version first", async () => {
  for (const [width, hint, version] of [
    [120, "shift+tab agents", true],
    [100, "^p cmds", false],
    [80, "^p cmds", false],
    [64, "^p cmds", false],
    [63, undefined, false],
  ] as const) {
    const setup = await home({
      width,
      height: 30,
      fetch: deepFetch,
      config: { animations: false, debug: { devtools: true } },
    })
    try {
      await setup.ready
      await setup.waitFor(() => setup.captureCharFrame().includes("project-calls-project"), { maxPasses: 400 })
      const lines = rows(setup.captureCharFrame())
      const footer = lines.find((line) => line.includes("project-calls-project")) ?? ""
      // The footer stays one row: the directory appears on it and nowhere else.
      expect(lines).toHaveLength(30)
      expect(lines.filter((line) => line.includes("project-calls-project"))).toHaveLength(1)
      // The basename always survives, and the whole path when the row has room.
      expect(footer).toContain("project-calls-project")
      if (width >= 100) expect(footer).toContain(DEEP_DIRECTORY)
      // Hints: full at 120, compact down to 64, gone at 63.
      expect(footer.includes("shift+tab agents")).toBe(hint === "shift+tab agents")
      expect(footer.includes("^p cmds")).toBe(hint === "^p cmds")
      // The version yields to the compact hint, and is gone below 64 anyway.
      expect(footer.trimEnd().endsWith("test")).toBe(version)
      // Nothing wrapped onto the row above.
      const index = lines.indexOf(footer)
      expect(lines[index - 1] ?? "").not.toContain("project-calls-project")
      expect(lines[index - 1] ?? "").not.toContain("cmds")
    } finally {
      await setup[Symbol.asyncDispose]()
    }
  }
}, 120000)
