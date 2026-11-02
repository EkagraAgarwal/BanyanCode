/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import type { Context, SlotClaim } from "@opencode/plugin/tui/context"
import BanyanTui from "../src/tui"
import { context, mount, session } from "./harness"

const ROOT = "ses_root"
/** The rail reads the real clock through the plugin's live data, so the fixture uses it too. */
const AT = Date.now()

function meshNode(input: {
  readonly sessionID: string
  readonly agent?: string
  readonly state: "running" | "idle" | "failed"
}): Record<string, unknown> {
  return {
    sessionID: input.sessionID,
    agent: input.agent,
    state: input.state,
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    createdAt: AT - 5_000,
    updatedAt: AT - 1_000,
    children: [],
  }
}

/** A harness context that records the plugin's slot claims and answers the mesh RPC. */
function recordingContext() {
  const claims: SlotClaim[] = []
  const base = context({ sessions: [session({ id: ROOT })] })
  const rpc = () =>
    new Proxy(
      {},
      {
        get: (_target, property) => {
          if (property === "events") return new Proxy({}, { get: () => () => () => {} })
          return async () => {
            if (property === "sessionStatus") {
              return {
                roots: [
                  {
                    ...meshNode({ sessionID: ROOT, agent: "build", state: "running" }),
                    children: [
                      meshNode({ sessionID: "ses_child_running", agent: "explore", state: "running" }),
                      meshNode({ sessionID: "ses_child_done", agent: "coder", state: "idle" }),
                    ],
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
      router: { ...base.ui.router, register: () => () => {} },
    },
  } as unknown as Context
  return { context: value, claims }
}

type RailClaim = {
  readonly replace: "session.rail"
  readonly render: (input: { readonly sessionID: string; readonly width: number }) => import("solid-js").JSX.Element
}
type PillsClaim = {
  readonly replace: "session.composer.pills"
  readonly render: (input: { readonly sessionID: string }) => import("solid-js").JSX.Element
}

function railClaim(claims: readonly SlotClaim[]): RailClaim {
  const claim = claims.find((item) => "replace" in item && item.replace === "session.rail")
  if (!claim) throw new Error("the plugin does not claim the trunk rail")
  return claim as unknown as RailClaim
}

function pillsClaim(claims: readonly SlotClaim[]): PillsClaim {
  const claim = claims.find((item) => "replace" in item && item.replace === "session.composer.pills")
  if (!claim) throw new Error("the plugin does not claim the composer pills")
  return claim as unknown as PillsClaim
}

test("the plugin claims the trunk rail and the narrow pill row", () => {
  const recorded = recordingContext()
  const cleanup = BanyanTui.setup(recorded.context)
  try {
    expect(recorded.claims.some((claim) => "replace" in claim && claim.replace === "session.rail")).toBe(true)
    expect(recorded.claims.some((claim) => "replace" in claim && claim.replace === "session.composer.pills")).toBe(
      true,
    )
  } finally {
    if (typeof cleanup === "function") void cleanup()
  }
})

test("the rail claim renders live mesh children at the width the host gives it", async () => {
  const recorded = recordingContext()
  const cleanup = BanyanTui.setup(recorded.context)
  const claim = railClaim(recorded.claims)
  const app = await mount(() => claim.render({ sessionID: ROOT, width: 40 }), { width: 40, height: 20 })
  try {
    // `mesh.ensure` is a request: let it answer, then read the frame.
    await new Promise((resolve) => setTimeout(resolve, 0))
    await app.renderOnce()
    await app.renderOnce()
    const frame = app.captureCharFrame()
    expect(frame).toContain("◉")
    expect(frame).toContain("explore")
    expect(frame).toContain("coder")
    expect(frame).toContain("┤")
  } finally {
    app.renderer.destroy()
    if (typeof cleanup === "function") await cleanup()
  }
})

test("the pill claim renders nothing for a session with no subagents", async () => {
  const recorded = recordingContext()
  const cleanup = BanyanTui.setup(recorded.context)
  const claim = pillsClaim(recorded.claims)
  const app = await mount(() => claim.render({ sessionID: "ses_no_children" }), { width: 60, height: 4 })
  try {
    await new Promise((resolve) => setTimeout(resolve, 0))
    await app.renderOnce()
    // A row of nothing keeps the composer where it was.
    expect(app.captureCharFrame().replace(/\s/g, "")).toBe("")
  } finally {
    app.renderer.destroy()
    if (typeof cleanup === "function") await cleanup()
  }
})
