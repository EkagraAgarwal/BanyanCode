import { expect, test } from "bun:test"
import type { Context } from "@opencode/plugin/tui/context"
import { childState, canSteer, directChildren, pendingCount } from "../src/data/mesh"
import { context, meshNode, session } from "./harness"

const root = session({ id: "ses_root", title: "root" })
const sessions = [root]

function withPending(permissions: Readonly<Record<string, number>>, forms: Readonly<Record<string, number>> = {}) {
  const base = context({ sessions })
  return {
    ...base,
    data: {
      ...base.data,
      session: {
        ...base.data.session,
        permission: {
          ...base.data.session.permission,
          list: (id: string) => Array.from({ length: permissions[id] ?? 0 }, (_, index) => ({ id: `${id}_p${index}` })),
        },
        form: {
          ...base.data.session.form,
          list: (id: string) => Array.from({ length: forms[id] ?? 0 }, (_, index) => ({ id: `${id}_f${index}` })),
        },
      },
    },
  } as unknown as Context
}

function tree() {
  return meshNode({
    sessionID: "ses_root",
    state: "running",
    children: [
      meshNode({ sessionID: "ses_idle", agent: "explore", state: "idle", title: "finished" }),
      meshNode({ sessionID: "ses_run", agent: "coder", state: "running" }),
      meshNode({ sessionID: "ses_retry", agent: "coder", state: "retry" }),
      meshNode({ sessionID: "ses_failed", agent: "scout", state: "failed" }),
      meshNode({ sessionID: "ses_killed", agent: "coder", state: "idle" }),
      meshNode({ sessionID: "ses_interrupted", agent: "coder", state: "interrupted" }),
      meshNode({ sessionID: "ses_waiting", agent: "coder", state: "running" }),
    ],
  })
}

test("child state separates running, waiting, done and failed", () => {
  expect(childState({ state: "running" } as never)).toBe("running")
  expect(childState({ state: "retry" } as never)).toBe("running")
  expect(childState({ state: "idle" } as never)).toBe("done")
  expect(childState({ state: "unknown" } as never)).toBe("done")
  expect(childState({ state: "failed" } as never)).toBe("failed")
  expect(childState({ state: "interrupted" } as never)).toBe("failed")
  // A pending permission wins over running: the agent is blocked on the user.
  expect(childState({ state: "running" } as never, { pending: 1 })).toBe("waiting")
  // A killed session is durable in the status tree, so it is never "done".
  expect(childState({ state: "idle" } as never, { killed: true })).toBe("failed")
})

test("pending count reads permissions and questions for the session", () => {
  expect(pendingCount(withPending({ ses_child: 2 }, { ses_child: 1 }), "ses_child")).toBe(3)
  expect(pendingCount(withPending({}), "ses_child")).toBe(0)
})

test("canSteer allows running, waiting, done and failed, and refuses killed", () => {
  expect(canSteer("running")).toBe(true)
  expect(canSteer("waiting")).toBe(true)
  expect(canSteer("done")).toBe(true)
  expect(canSteer("failed")).toBe(true)
  // Raw mesh states map onto the same four: retry runs, idle is done, interrupted failed.
  expect(canSteer("retry")).toBe(true)
  expect(canSteer("idle")).toBe(true)
  expect(canSteer("interrupted")).toBe(true)
  // A killed session is durable and hidden from status, so it cannot be revived.
  expect(canSteer("failed", { killed: true })).toBe(false)
  expect(canSteer("running", { killed: true })).toBe(false)
  // No mesh report yet, or no node at all.
  expect(canSteer("unknown")).toBe(false)
  expect(canSteer(undefined)).toBe(false)
})

test("direct children carry real state, order, tokens and titles", () => {
  const children = directChildren({
    context: withPending({ ses_waiting: 1 }),
    sessionID: "ses_root",
    root: tree(),
    killed: new Set(["ses_killed"]),
  })
  expect(children.map((child) => child.sessionID)).toEqual([
    "ses_idle",
    "ses_run",
    "ses_retry",
    "ses_failed",
    "ses_killed",
    "ses_interrupted",
    "ses_waiting",
  ])
  expect(children.map((child) => child.state)).toEqual([
    "done",
    "running",
    "running",
    "failed",
    "failed",
    "failed",
    "waiting",
  ])
  expect(children[0]!.title).toBe("finished")
  expect(children[0]!.agent).toBe("explore")
  expect(children[6]!.pending).toBe(1)
  expect(directChildren({ context: withPending({}), sessionID: "ses_root", root: undefined })).toEqual([])
})

test("direct children of a nested session come from that node, not the root", () => {
  const root = meshNode({
    sessionID: "ses_root",
    state: "running",
    children: [
      meshNode({
        sessionID: "ses_mid",
        state: "running",
        children: [meshNode({ sessionID: "ses_leaf", agent: "scout", state: "running" })],
      }),
    ],
  })
  const children = directChildren({ context: withPending({}), sessionID: "ses_mid", root })
  expect(children.map((child) => child.sessionID)).toEqual(["ses_leaf"])
  expect(directChildren({ context: withPending({}), sessionID: "ses_leaf", root })).toEqual([])
})
