/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import type { Context, KeymapCommand, SlotClaim } from "@opencode/plugin/tui/context"
import { createSignal, type JSX } from "solid-js"
import { createDismissedBranches } from "../src/data/dismissed"
import { directChildren } from "../src/data/mesh"
import { buildGrovePanes } from "../src/components/grove/data"
import type { MeshLive } from "../src/data/live"
import type { MeshNode } from "../src/data/pending-rpc"
import { TrunkPills, TrunkRail } from "../src/components/trunk/trunk"
import BanyanTui from "../src/tui"
import { context, meshLive, meshNode, mount, session } from "./harness"

const ROOT = "ses_root"
const NOW = 1_700_000_000_000

type ChildFixture = {
  readonly agent: string
  readonly state?: "running" | "idle" | "failed" | "interrupted"
  readonly createdAt?: number
  readonly updatedAt?: number
}

/** A harness context whose named children are blocked on a permission. */
function withPending(base: Context, sessionIDs: readonly string[]): Context {
  return {
    ...base,
    data: {
      ...base.data,
      session: {
        ...base.data.session,
        permission: {
          ...base.data.session.permission,
          list: (id: string) => (sessionIDs.includes(id) ? [{ id: `per_${id}` }] : []),
        },
      },
    },
  } as unknown as Context
}

function fixture(input: {
  readonly children: readonly ChildFixture[]
  readonly killed?: readonly string[]
  readonly pending?: readonly string[]
  readonly animations?: boolean
}) {
  const children = input.children.map((child, index) =>
    meshNode({
      sessionID: `ses_c${index}`,
      agent: child.agent,
      state: child.state ?? "running",
      cost: 0,
      createdAt: child.createdAt ?? NOW - 4_000,
      updatedAt: child.updatedAt ?? NOW - 4_000,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    }),
  )
  const root = meshNode({ sessionID: ROOT, state: "idle", createdAt: NOW - 60_000, children })
  const base = context({ sessions: [session({ id: ROOT })], animations: input.animations ?? false })
  return {
    root,
    mesh: meshLive({ root, killed: input.killed }),
    context: input.pending === undefined ? base : withPending(base, input.pending),
  }
}

/** The column and row of the dismiss control on the first line that names `agent`. */
function dismissCell(frame: string, agent: string): { readonly x: number; readonly y: number } {
  const lines = frame.replace(/\n$/, "").split("\n")
  const y = lines.findIndex((line) => line.includes(agent))
  if (y < 0) throw new Error(`no rail row for ${agent}`)
  const x = lines[y]!.indexOf("×")
  if (x < 0) throw new Error(`no dismiss control on ${agent}`)
  return { x, y }
}

/** A mesh whose tree a test can replace, to model a refresh or a state change. */
function reactiveMesh(initial: MeshNode | undefined) {
  const [root, setRoot] = createSignal<MeshNode | undefined>(initial)
  const mesh: MeshLive = { ...meshLive(), root: () => root() }
  return { mesh, setRoot }
}

const rail = (data: ReturnType<typeof fixture>) => (
  <TrunkRail context={data.context} sessionID={ROOT} mesh={data.mesh} width={50} height={20} now={() => NOW} />
)

test("only failed and killed branches offer the dismiss control", async () => {
  const data = fixture({
    children: [
      { agent: "explore", state: "running" },
      { agent: "scout", state: "running" },
      { agent: "coder", state: "idle", updatedAt: NOW - 1_000 },
      { agent: "breaker", state: "failed" },
      { agent: "halted", state: "idle" },
    ],
    killed: ["ses_c4"],
    pending: ["ses_c1"],
  })
  const app = await mount(() => rail(data), { width: 50, height: 20 })
  try {
    const frame = app.captureCharFrame()
    const lines = frame.replace(/\n$/, "").split("\n")
    const lineOf = (agent: string) => lines.find((line) => line.includes(agent)) ?? ""
    // Waiting, running and finished rows never carry it.
    for (const agent of ["explore", "scout", "coder"]) expect(lineOf(agent)).not.toContain("×")
    expect(lineOf("breaker")).toContain("×")
    expect(lineOf("halted")).toContain("×")
    // One × for the failure, one for the kill.
    expect(frame.split("×").length - 1).toBe(2)
    expect(dismissCell(frame, "breaker")).toBeDefined()
    expect(dismissCell(frame, "halted")).toBeDefined()
  } finally {
    app.renderer.destroy()
  }
})

test("clicking the dismiss control hides that row only and does not open it", async () => {
  const opened: unknown[] = []
  const data = fixture({
    children: [
      { agent: "breaker", state: "failed" },
      { agent: "crashed", state: "failed" },
    ],
  })
  const withRouter = {
    ...data.context,
    ui: {
      ...data.context.ui,
      router: { ...data.context.ui.router, navigate: (destination: unknown) => opened.push(destination) },
    },
  } as unknown as Context
  const app = await mount(
    () => (
      <TrunkRail context={withRouter} sessionID={ROOT} mesh={data.mesh} width={50} height={20} now={() => NOW} />
    ),
    { width: 50, height: 20 },
  )
  try {
    const target = dismissCell(app.captureCharFrame(), "breaker")
    await app.mockMouse.click(target.x, target.y)
    await app.renderOnce()
    const frame = app.captureCharFrame()
    expect(frame).not.toContain("breaker")
    expect(frame).toContain("crashed")
    expect(opened).toEqual([])
  } finally {
    app.renderer.destroy()
  }
})

test("clicking the rest of a failed row still opens the child session", async () => {
  const opened: unknown[] = []
  const data = fixture({ children: [{ agent: "breaker", state: "failed" }] })
  const withRouter = {
    ...data.context,
    ui: {
      ...data.context.ui,
      router: { ...data.context.ui.router, navigate: (destination: unknown) => opened.push(destination) },
    },
  } as unknown as Context
  const app = await mount(
    () => (
      <TrunkRail context={withRouter} sessionID={ROOT} mesh={data.mesh} width={50} height={20} now={() => NOW} />
    ),
    { width: 50, height: 20 },
  )
  try {
    // Root, blank, then the branch label; the name sits left of its ×.
    await app.mockMouse.click(4, 2)
    expect(opened).toEqual([{ type: "session", sessionID: "ses_c0" }])
  } finally {
    app.renderer.destroy()
  }
})

test("dismissing leaves the mesh and the agent's failed state untouched", async () => {
  const data = fixture({ children: [{ agent: "breaker", state: "failed" }] })
  const dismissed = createDismissedBranches()
  const app = await mount(
    () => (
      <TrunkRail
        context={data.context}
        sessionID={ROOT}
        mesh={data.mesh}
        width={50}
        height={20}
        now={() => NOW}
        dismissed={dismissed}
      />
    ),
    { width: 50, height: 20 },
  )
  try {
    expect(app.captureCharFrame()).toContain("breaker")
    const child = directChildren({
      context: data.context,
      sessionID: ROOT,
      root: data.mesh.root(ROOT),
      killed: data.mesh.killed(),
    })[0]!
    dismissed.dismiss(ROOT, [child.sessionID])
    await app.renderOnce()
    expect(app.captureCharFrame()).not.toContain("breaker")
    // The mesh node is still failed, so Grove and the session keep showing it.
    expect(directChildren({
      context: data.context,
      sessionID: ROOT,
      root: data.mesh.root(ROOT),
      killed: data.mesh.killed(),
    })[0]!.state).toBe("failed")
    expect(
      buildGrovePanes({ context: data.context, root: data.mesh.root(ROOT), sessionID: ROOT, killed: data.mesh.killed() })[0]!
        .state,
    ).toBe("failed")
  } finally {
    app.renderer.destroy()
  }
})

test("an update while the branch stays failed does not undo its dismissal", async () => {
  const first = meshNode({
    sessionID: "ses_c0",
    agent: "breaker",
    state: "failed",
    createdAt: NOW - 4_000,
    updatedAt: NOW - 4_000,
  })
  const [root, setRoot] = createSignal(
    meshNode({ sessionID: ROOT, state: "idle", createdAt: NOW - 60_000, children: [first] }),
  )
  const mesh: MeshLive = { ...meshLive(), root: () => root() }
  const app = await mount(
    () => (
      <TrunkRail
        context={context({ sessions: [session({ id: ROOT })] })}
        sessionID={ROOT}
        mesh={mesh}
        width={50}
        height={20}
        now={() => NOW}
      />
    ),
    { width: 50, height: 20 },
  )
  try {
    const target = dismissCell(app.captureCharFrame(), "breaker")
    await app.mockMouse.click(target.x, target.y)
    await app.renderOnce()
    expect(app.captureCharFrame()).not.toContain("breaker")

    // A title/summary write or a late settle moves both times; the branch is
    // still the same continuous failure, so it must stay dismissed.
    setRoot(
      meshNode({
        sessionID: ROOT,
        state: "idle",
        createdAt: NOW - 60_000,
        children: [
          meshNode({
            sessionID: "ses_c0",
            agent: "breaker",
            state: "failed",
            createdAt: NOW - 4_000,
            updatedAt: NOW + 5_000,
            lastActivityAt: NOW + 5_000,
          }),
        ],
      }),
    )
    await app.renderOnce()
    expect(app.captureCharFrame()).not.toContain("breaker")
  } finally {
    app.renderer.destroy()
  }
})

test("a run after a dismissal clears it and the next failure shows again", async () => {
  const child = (state: "failed" | "running") =>
    meshNode({ sessionID: "ses_c0", agent: "breaker", state, createdAt: NOW - 4_000, updatedAt: NOW - 4_000 })
  const { mesh, setRoot } = reactiveMesh(
    meshNode({ sessionID: ROOT, state: "idle", createdAt: NOW - 60_000, children: [child("failed")] }),
  )
  const dismissed = createDismissedBranches()
  const app = await mount(
    () => (
      <TrunkRail
        context={context({ sessions: [session({ id: ROOT })] })}
        sessionID={ROOT}
        mesh={mesh}
        width={50}
        height={20}
        now={() => NOW}
        dismissed={dismissed}
      />
    ),
    { width: 50, height: 20 },
  )
  try {
    const target = dismissCell(app.captureCharFrame(), "breaker")
    await app.mockMouse.click(target.x, target.y)
    await app.renderOnce()
    expect(app.captureCharFrame()).not.toContain("breaker")
    expect(dismissed.count(ROOT)).toBe(1)

    // The branch runs again: it leaves `failed`, so the dismissal ends…
    setRoot(meshNode({ sessionID: ROOT, state: "idle", createdAt: NOW - 60_000, children: [child("running")] }))
    await app.renderOnce()
    expect(dismissed.count(ROOT)).toBe(0)
    expect(app.captureCharFrame()).toContain("breaker")

    // …and its next failure is a new continuous failure, so it shows.
    setRoot(
      meshNode({
        sessionID: ROOT,
        state: "idle",
        createdAt: NOW - 60_000,
        children: [
          meshNode({
            sessionID: "ses_c0",
            agent: "breaker",
            state: "failed",
            createdAt: NOW - 4_000,
            updatedAt: NOW + 5_000,
          }),
        ],
      }),
    )
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("breaker")
  } finally {
    app.renderer.destroy()
  }
})

test("finishing a dismissed branch clears its dismissal", async () => {
  const child = (state: "failed" | "idle") =>
    meshNode({ sessionID: "ses_c0", agent: "breaker", state, createdAt: NOW - 4_000, updatedAt: NOW - 1_000 })
  const { mesh, setRoot } = reactiveMesh(
    meshNode({ sessionID: ROOT, state: "idle", createdAt: NOW - 60_000, children: [child("failed")] }),
  )
  const dismissed = createDismissedBranches()
  const app = await mount(
    () => (
      <TrunkRail
        context={context({ sessions: [session({ id: ROOT })] })}
        sessionID={ROOT}
        mesh={mesh}
        width={50}
        height={20}
        now={() => NOW}
        dismissed={dismissed}
      />
    ),
    { width: 50, height: 20 },
  )
  try {
    dismissed.dismiss(ROOT, ["ses_c0"])
    await app.renderOnce()
    expect(dismissed.count(ROOT)).toBe(1)

    setRoot(meshNode({ sessionID: ROOT, state: "idle", createdAt: NOW - 60_000, children: [child("idle")] }))
    await app.renderOnce()
    expect(dismissed.count(ROOT)).toBe(0)
    expect(app.captureCharFrame()).toContain("breaker")

    // A later failure of the same session is new and shows.
    setRoot(
      meshNode({
        sessionID: ROOT,
        state: "idle",
        createdAt: NOW - 60_000,
        children: [
          meshNode({
            sessionID: "ses_c0",
            agent: "breaker",
            state: "failed",
            createdAt: NOW - 4_000,
            updatedAt: NOW + 5_000,
          }),
        ],
      }),
    )
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("breaker")
  } finally {
    app.renderer.destroy()
  }
})

test("a waiting dismissed branch clears its dismissal", async () => {
  // `ses_c0` always has a pending permission, so running reads as waiting.
  const ctx = withPending(context({ sessions: [session({ id: ROOT })], animations: false }), ["ses_c0"])
  const child = (state: "failed" | "running") =>
    meshNode({ sessionID: "ses_c0", agent: "breaker", state, createdAt: NOW - 4_000, updatedAt: NOW - 4_000 })
  const { mesh, setRoot } = reactiveMesh(
    meshNode({ sessionID: ROOT, state: "idle", createdAt: NOW - 60_000, children: [child("failed")] }),
  )
  const dismissed = createDismissedBranches()
  const app = await mount(
    () => (
      <TrunkRail
        context={ctx}
        sessionID={ROOT}
        mesh={mesh}
        width={50}
        height={20}
        now={() => NOW}
        dismissed={dismissed}
      />
    ),
    { width: 50, height: 20 },
  )
  try {
    dismissed.dismiss(ROOT, ["ses_c0"])
    await app.renderOnce()
    expect(dismissed.count(ROOT)).toBe(1)

    setRoot(meshNode({ sessionID: ROOT, state: "idle", createdAt: NOW - 60_000, children: [child("running")] }))
    await app.renderOnce()
    expect(dismissed.count(ROOT)).toBe(0)
    expect(app.captureCharFrame()).toContain("breaker")

    setRoot(
      meshNode({
        sessionID: ROOT,
        state: "idle",
        createdAt: NOW - 60_000,
        children: [
          meshNode({
            sessionID: "ses_c0",
            agent: "breaker",
            state: "failed",
            createdAt: NOW - 4_000,
            updatedAt: NOW + 5_000,
          }),
        ],
      }),
    )
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("breaker")
  } finally {
    app.renderer.destroy()
  }
})

test("a temporarily missing mesh tree does not wipe dismissals", async () => {
  const failed = () =>
    meshNode({ sessionID: "ses_c0", agent: "breaker", state: "failed", createdAt: NOW - 4_000, updatedAt: NOW - 4_000 })
  const tree = () =>
    meshNode({ sessionID: ROOT, state: "idle", createdAt: NOW - 60_000, children: [failed()] })
  const { mesh, setRoot } = reactiveMesh(tree())
  const dismissed = createDismissedBranches()
  const app = await mount(
    () => (
      <TrunkRail
        context={context({ sessions: [session({ id: ROOT })] })}
        sessionID={ROOT}
        mesh={mesh}
        width={50}
        height={20}
        now={() => NOW}
        dismissed={dismissed}
      />
    ),
    { width: 50, height: 20 },
  )
  try {
    dismissed.dismiss(ROOT, ["ses_c0"])
    await app.renderOnce()
    expect(dismissed.count(ROOT)).toBe(1)

    // An empty `roots` array or a failed poll leaves the client without a tree.
    setRoot(undefined)
    await app.renderOnce()
    expect(dismissed.count(ROOT)).toBe(1)

    // The next real tree still reports it failed, so the dismissal survives.
    setRoot(tree())
    await app.renderOnce()
    expect(app.captureCharFrame()).not.toContain("breaker")
  } finally {
    app.renderer.destroy()
  }
})

test("a dismissed branch that leaves the mesh is pruned", async () => {
  const failed = meshNode({
    sessionID: "ses_c0",
    agent: "breaker",
    state: "failed",
    createdAt: NOW - 4_000,
    updatedAt: NOW - 4_000,
  })
  const survivor = meshNode({
    sessionID: "ses_c1",
    agent: "worker",
    state: "running",
    createdAt: NOW - 3_000,
    updatedAt: NOW - 3_000,
  })
  const { mesh, setRoot } = reactiveMesh(
    meshNode({ sessionID: ROOT, state: "idle", createdAt: NOW - 60_000, children: [failed, survivor] }),
  )
  const dismissed = createDismissedBranches()
  const app = await mount(
    () => (
      <TrunkRail
        context={context({ sessions: [session({ id: ROOT })] })}
        sessionID={ROOT}
        mesh={mesh}
        width={50}
        height={20}
        now={() => NOW}
        dismissed={dismissed}
      />
    ),
    { width: 50, height: 20 },
  )
  try {
    dismissed.dismiss(ROOT, ["ses_c0"])
    await app.renderOnce()
    expect(dismissed.count(ROOT)).toBe(1)

    setRoot(meshNode({ sessionID: ROOT, state: "idle", createdAt: NOW - 60_000, children: [survivor] }))
    await app.renderOnce()
    expect(dismissed.count(ROOT)).toBe(0)
    expect(app.captureCharFrame()).not.toContain("breaker")
    expect(app.captureCharFrame()).toContain("worker")
  } finally {
    app.renderer.destroy()
  }
})

test("the narrow status row stops counting dismissed failures", async () => {
  const children = Array.from({ length: 24 }, (_, index) => ({
    agent: `agent${String(index).padStart(2, "0")}`,
    state: "failed" as const,
    createdAt: NOW - 10_000 + index,
  }))
  const data = fixture({ children })
  const dismissed = createDismissedBranches()
  const app = await mount(
    () => (
      <TrunkPills
        context={data.context}
        sessionID={ROOT}
        mesh={data.mesh}
        width={60}
        dismissed={dismissed}
      />
    ),
    { width: 60, height: 4 },
  )
  try {
    const before = Number(app.captureCharFrame().match(/\+(\d+)/)?.[1])
    expect(before).toBeGreaterThan(0)
    dismissed.dismiss(ROOT, ["ses_c23"])
    await app.renderOnce()
    const after = Number(app.captureCharFrame().match(/\+(\d+)/)?.[1])
    expect(after).toBe(before - 1)
  } finally {
    app.renderer.destroy()
  }
})

test("dismissals are pruned against the current failed set", () => {
  const dismissed = createDismissedBranches()
  dismissed.dismiss(ROOT, ["ses_a", "ses_b"])
  expect(dismissed.count(ROOT)).toBe(2)
  dismissed.prune(ROOT, ["ses_a"])
  expect(dismissed.count(ROOT)).toBe(1)
  expect(dismissed.isDismissed(ROOT, "ses_a")).toBe(true)
  expect(dismissed.isDismissed(ROOT, "ses_b")).toBe(false)
  dismissed.prune(ROOT, [])
  expect(dismissed.count(ROOT)).toBe(0)
})

/** Records the plugin's slots and commands and answers the mesh RPC. */
function recordingContext(input: { readonly failed: readonly string[] }) {
  const claims: SlotClaim[] = []
  const commands: KeymapCommand[] = []
  const calls: string[] = []
  const base = context({ sessions: [session({ id: ROOT })] })
  const rpc = () =>
    new Proxy(
      {},
      {
        get: (_target, property) => {
          if (property === "events") return new Proxy({}, { get: () => () => () => {} })
          return async () => {
            calls.push(String(property))
            if (property === "sessionStatus") {
              return {
                roots: [
                  {
                    ...meshNode({ sessionID: ROOT, agent: "build", state: "running" }),
                    children: input.failed.map((agent, index) =>
                      meshNode({
                        sessionID: `ses_f${index}`,
                        agent,
                        state: "failed",
                        cost: 0,
                        createdAt: NOW - 5_000,
                        updatedAt: NOW - 4_000,
                      }),
                    ),
                  },
                ],
                killed: [],
              }
            }
            return {}
          }
        },
      },
    )
  const value = {
    ...base,
    location: { directory: "D:/workspace" },
    client: { rpc } as unknown as Context["client"],
    ui: {
      ...base.ui,
      slot: (claim: SlotClaim) => {
        claims.push(claim)
        return () => {}
      },
      router: {
        ...base.ui.router,
        register: () => () => {},
        current: () => ({ type: "session" as const, sessionID: ROOT }),
      },
    },
    keymap: {
      ...base.keymap,
      layer: (factory: () => { readonly commands?: readonly KeymapCommand[] }) => {
        commands.push(...(factory().commands ?? []))
      },
    },
  } as unknown as Context
  return { context: value, claims, commands, calls }
}

type RailClaim = {
  readonly replace: "session.rail"
  readonly render: (input: { readonly sessionID: string; readonly width: number }) => JSX.Element
}

function enabledOf(command: KeymapCommand | undefined): boolean {
  if (command === undefined) return false
  return typeof command.enabled === "function" ? command.enabled() : command.enabled === true
}

test("the palette command dismisses every failure and disables itself", async () => {
  const recorded = recordingContext({ failed: ["breaker", "crashed"] })
  const cleanup = BanyanTui.setup(recorded.context)
  const command = recorded.commands.find((item) => item.id === "banyancode.dismiss-failed")
  const claim = recorded.claims.find((item) => "replace" in item && item.replace === "session.rail") as
    | RailClaim
    | undefined
  if (command === undefined) throw new Error("the plugin does not register the dismiss command")
  if (claim === undefined) throw new Error("the plugin does not claim the trunk rail")
  const app = await mount(() => claim.render({ sessionID: ROOT, width: 50 }), { width: 50, height: 20 })
  try {
    // `mesh.ensure` is a request: let it answer, then read the frame.
    await new Promise((resolve) => setTimeout(resolve, 0))
    await app.renderOnce()
    await app.renderOnce()
    expect(command.bind).toBeUndefined()
    expect(command.palette).toBe(true)
    expect(app.captureCharFrame()).toContain("breaker")
    expect(enabledOf(command)).toBe(true)

    await command.run()
    await app.renderOnce()
    const frame = app.captureCharFrame()
    expect(frame).not.toContain("breaker")
    expect(frame).not.toContain("crashed")
    expect(enabledOf(command)).toBe(false)
    // Hiding a branch must never kill or steer its agent.
    expect(recorded.calls).not.toContain("kill")
    expect(recorded.calls).not.toContain("steer")
  } finally {
    app.renderer.destroy()
    if (typeof cleanup === "function") await cleanup()
  }
})
