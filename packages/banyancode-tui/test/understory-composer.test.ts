import { expect, test } from "bun:test"
import type {
  ComposerHooks,
  ComposerInterceptResult,
  ComposerRouteResolver,
  ComposerSuggestionProvider,
  ComposerInterceptor,
  Context,
} from "@opencode/plugin/tui/context"
import type { MeshLive } from "../src/data/live"
import type { RosterRow } from "../src/data/understory"
import {
  composerDestination,
  composerPlaceholder,
  composerRouteLabel,
  composerSuggestions,
  parseComposerMention,
  registerComposerRouting,
  sendComposer,
} from "../src/components/understory/composer-route"
import { context, meshLive } from "./harness"

function row(input: Partial<RosterRow> & { readonly sessionID: string; readonly label: string }): RosterRow {
  return {
    depth: 1,
    agent: input.label.replace(/-\d+$/, ""),
    state: "running",
    pending: 0,
    tokens: 0,
    cost: 0,
    startedAt: 1_000,
    historyMayBeTruncated: false,
    hasChildren: false,
    ...input,
  }
}

const ROOT = row({ sessionID: "ses_root", label: "build", agent: "build", depth: 0, state: "idle" })
const CODER_1 = row({ sessionID: "ses_coder_1", label: "coder-1" })
const CODER_2 = row({ sessionID: "ses_coder_2", label: "coder-2" })
const EXPLORE = row({ sessionID: "ses_explore", label: "explore", state: "waiting" })
const ROWS = [ROOT, CODER_1, CODER_2, EXPLORE]

test("a leading @label is split from the instruction; a path is not a label", () => {
  expect(parseComposerMention("@coder-1 fix the fallback")).toEqual({
    label: "coder-1",
    instruction: "fix the fallback",
  })
  expect(parseComposerMention("@coder-1")).toEqual({ label: "coder-1", instruction: "" })
  expect(parseComposerMention("  @coder-2   tighten it  ")).toEqual({ label: "coder-2", instruction: "tighten it" })
  // A file mention after the @ is not a roster label, so it stays ordinary text.
  expect(parseComposerMention("@packages/tui/src/index.tsx look here")).toBeUndefined()
  expect(parseComposerMention("fix @coder-1 later")).toBeUndefined()
  expect(parseComposerMention("plain text")).toBeUndefined()
  expect(parseComposerMention("@")).toBeUndefined()
})

test("only a live branch label routes; everything else is root text", () => {
  expect(composerDestination("@coder-1 fix it", ROWS)).toMatchObject({
    kind: "steer",
    instruction: "fix it",
    row: { sessionID: "ses_coder_1" },
  })
  expect(composerDestination("@coder-2 fix it", ROWS)).toMatchObject({
    kind: "steer",
    row: { sessionID: "ses_coder_2" },
  })
  // Unknown label, the root's own label and a file mention all reach the root unchanged.
  expect(composerDestination("@nope fix it", ROWS)).toEqual({ kind: "root", text: "@nope fix it" })
  expect(composerDestination("@build fix it", ROWS)).toEqual({ kind: "root", text: "@build fix it" })
  expect(composerDestination("@src/index.tsx fix it", ROWS)).toEqual({ kind: "root", text: "@src/index.tsx fix it" })
  expect(composerDestination("plain text", ROWS)).toEqual({ kind: "root", text: "plain text" })
  // A bare label with nothing to say is refused rather than steered empty.
  expect(composerDestination("@coder-1", ROWS)).toMatchObject({ kind: "empty" })
})

test("a finished, failed or killed branch refuses and says why", () => {
  for (const [state, reason] of [
    ["done", "finished"],
    ["failed", "failed"],
    ["killed", "killed"],
  ] as const) {
    const target = row({ sessionID: "ses_dead", label: "coder-1", state })
    const destination = composerDestination("@coder-1 retry", [ROOT, target])
    expect(destination).toMatchObject({ kind: "refused", reason })
  }
  // Waiting and idle branches are still steerable.
  expect(composerDestination("@explore keep going", ROWS)).toMatchObject({ kind: "steer" })
})

test("the route label names the destination, the refusal, or live replay", () => {
  expect(composerRouteLabel("", ROWS, true)).toEqual({ text: "→ build", tone: "info" })
  expect(composerRouteLabel("@coder-1 fix it", ROWS, true)).toEqual({ text: "→ coder-1", tone: "info" })
  expect(composerRouteLabel("@nope fix it", ROWS, true)).toEqual({ text: "→ build", tone: "info" })
  expect(composerRouteLabel("@coder-1", ROWS, true)?.text).toBe("→ coder-1 · needs an instruction")
  const done = row({ sessionID: "ses_dead", label: "coder-1", state: "done" })
  expect(composerRouteLabel("@coder-1 retry", [ROOT, done], true)).toEqual({
    text: "→ coder-1 · finished",
    tone: "warning",
  })
  expect(composerRouteLabel("plain text", ROWS, false)).toEqual({
    text: "replaying: back to live first",
    tone: "warning",
  })
})

test("the placeholder names the real root agent", () => {
  expect(composerPlaceholder(ROWS)).toBe("Message build, or @ to steer one branch")
  expect(composerPlaceholder([])).toBe("Message the root agent, or @ to steer one branch")
})

test("the picker lists branches with state glyphs, filtered by the typed label", () => {
  const all = composerSuggestions(ROWS, "")
  expect(all.map((item) => item.insert)).toEqual(["@coder-1", "@coder-2", "@explore"])
  expect(all.map((item) => item.display)).toEqual(["◐ coder-1", "◐ coder-2", "▲ explore"])
  expect(all[2]?.description).toBe("waiting")
  // The root is not a branch, so it is not offered.
  expect(all.some((item) => item.insert === "@build")).toBe(false)
  // Typing filters by label or agent name, as the mockup's picker does.
  expect(composerSuggestions(ROWS, "co").map((item) => item.insert)).toEqual(["@coder-1", "@coder-2"])
  expect(composerSuggestions(ROWS, "coder-2").map((item) => item.insert)).toEqual(["@coder-2"])
  expect(composerSuggestions(ROWS, "nope")).toEqual([])
  // A real glyph callback wins, so the tab can animate a running branch.
  expect(composerSuggestions(ROWS, "", { glyph: () => "*" })[0]?.display).toBe("* coder-1")
})

test("sending @coder-1 steers that one session and never its sibling", async () => {
  const steered: Array<Record<string, unknown>> = []
  const mesh = {
    ...meshLive(),
    steer: async (input: { targetSessionID?: string; instruction: string; parentSessionID: string }) => {
      steered.push(input)
      return { ok: true as const, value: { delivered: 1 } }
    },
  }
  const messages: string[] = []
  const result = await sendComposer({
    text: "@coder-1 fix the fallback",
    rows: ROWS,
    root: "ses_root",
    mesh,
    live: true,
    tell: (message) => messages.push(message),
  })
  expect(result).toEqual({ handled: true, retain: false })
  expect(steered).toEqual([
    {
      parentSessionID: "ses_root",
      targetAgent: "coder",
      targetSessionID: "ses_coder_1",
      instruction: "fix the fallback",
    },
  ])
  expect(steered.some((input) => input.targetSessionID === "ses_coder_2")).toBe(false)
  expect(messages.at(-1)).toBe("Steered coder-1")
})

test("plain text and unknown labels leave the submit to the host", async () => {
  let calls = 0
  const mesh = {
    ...meshLive(),
    steer: async () => {
      calls += 1
      return { ok: true as const, value: { delivered: 1 } }
    },
  }
  for (const text of ["fix the fallback", "@nope fix it", "@packages/tui/src/index.tsx look here"]) {
    expect(
      await sendComposer({ text, rows: ROWS, root: "ses_root", mesh, live: true, tell: () => {} }),
    ).toBeUndefined()
  }
  expect(calls).toBe(0)
})

test("a finished target refuses, keeps the text and explains", async () => {
  let calls = 0
  const mesh = {
    ...meshLive(),
    steer: async () => {
      calls += 1
      return { ok: true as const, value: { delivered: 1 } }
    },
  }
  const messages: string[] = []
  const done = row({ sessionID: "ses_done", label: "coder-1", state: "done" })
  const result = await sendComposer({
    text: "@coder-1 try again",
    rows: [ROOT, done, CODER_2],
    root: "ses_root",
    mesh,
    live: true,
    tell: (message) => messages.push(message),
  })
  expect(result).toEqual({ handled: true, retain: true })
  expect(calls).toBe(0)
  expect(messages.at(-1)).toContain("coder-1 finished")
})

test("replay refuses every send, plain text included, and keeps it", async () => {
  let calls = 0
  const mesh = {
    ...meshLive(),
    steer: async () => {
      calls += 1
      return { ok: true as const, value: { delivered: 1 } }
    },
  }
  const messages: string[] = []
  for (const text of ["fix the fallback", "@coder-1 fix it"]) {
    expect(
      await sendComposer({ text, rows: ROWS, root: "ses_root", mesh, live: false, tell: (m) => messages.push(m) }),
    ).toEqual({ handled: true, retain: true })
  }
  expect(calls).toBe(0)
  expect(messages.every((message) => message.includes("back to live"))).toBe(true)
})

test("a refused or failed steer keeps the text and surfaces the reason", async () => {
  const failing = {
    ...meshLive(),
    steer: async () => ({ ok: false as const, unavailable: false, message: "mesh is busy" }),
  }
  const messages: string[] = []
  expect(
    await sendComposer({
      text: "@coder-2 slow down",
      rows: ROWS,
      root: "ses_root",
      mesh: failing,
      live: true,
      tell: (message) => messages.push(message),
    }),
  ).toEqual({ handled: true, retain: true })
  expect(messages.at(-1)).toBe("mesh is busy")
})

/** A recording double for the host's composer seams; the code under test registers on it. */
function fakeComposer() {
  const interceptors: ComposerInterceptor[] = []
  const providers: ComposerSuggestionProvider[] = []
  const resolvers: ComposerRouteResolver[] = []
  let placeholder: string | undefined
  const focused: Array<string | undefined> = []
  const hooks: ComposerHooks = {
    focus(text) {
      focused.push(text)
      return true
    },
    intercept(handler) {
      interceptors.push(handler)
      return () => interceptors.splice(interceptors.indexOf(handler), 1)
    },
    suggest(provider) {
      providers.push(provider)
      return () => providers.splice(providers.indexOf(provider), 1)
    },
    route(resolver) {
      resolvers.push(resolver)
      return () => resolvers.splice(resolvers.indexOf(resolver), 1)
    },
    placeholder: () => placeholder,
    setPlaceholder(text) {
      placeholder = text
    },
  }
  return { hooks, interceptors, providers, resolvers, focused, placeholder: () => placeholder }
}

test("registering the tab wires submit, picker and route label, and cleans all three up", async () => {
  const host = fakeComposer()
  const base = context()
  const withComposer = { ...base, ui: { ...base.ui, composer: host.hooks } } as Context
  const steered: Array<Record<string, unknown>> = []
  const mesh: MeshLive = {
    ...meshLive(),
    steer: async (input) => {
      steered.push(input as unknown as Record<string, unknown>)
      return { ok: true as const, value: { delivered: 1 } }
    },
  }
  let live = true
  const said: string[] = []
  const dispose = registerComposerRouting({
    context: withComposer,
    rows: () => ROWS,
    root: () => "ses_root",
    mesh,
    live: () => live,
    tell: (message) => said.push(message),
  })

  expect(host.interceptors).toHaveLength(1)
  expect(host.providers).toHaveLength(1)
  expect(host.resolvers).toHaveLength(1)

  const claimed = (await host.interceptors[0]!("@coder-1 fix it")) as ComposerInterceptResult | undefined
  expect(claimed).toEqual({ handled: true, retain: false })
  expect(steered[0]).toMatchObject({ targetSessionID: "ses_coder_1", instruction: "fix it" })

  expect(host.providers[0]!("explore").map((item) => item.insert)).toEqual(["@explore"])
  expect(host.resolvers[0]!("@coder-2 go")?.text).toBe("→ coder-2")

  live = false
  expect(host.resolvers[0]!("")?.text).toBe("replaying: back to live first")
  expect(await host.interceptors[0]!("@coder-2 go")).toEqual({ handled: true, retain: true })
  expect(said.at(-1)).toContain("back to live")

  dispose()
  expect(host.interceptors).toHaveLength(0)
  expect(host.providers).toHaveLength(0)
  expect(host.resolvers).toHaveLength(0)
})
