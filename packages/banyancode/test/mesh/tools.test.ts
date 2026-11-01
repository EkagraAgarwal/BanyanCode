import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import type { Context } from "@opencode/plugin/effect/plugin"
import { BanyanConfig } from "../../src/config/index.js"
import { makeMesh, type MeshService } from "../../src/mesh/service.js"
import type { SessionPort } from "../../src/mesh/session-port.js"
import { buildMeshTools } from "../../src/mesh/tools.js"
import { makeSharedMemoryTool } from "../../src/mesh/shared-memory.js"
import { Definition, handlers } from "../../src/mesh/rpc.js"
import { emptyTokens, type MeshSessionSnapshot } from "../../src/mesh/types.js"
import { Storage } from "../../src/storage/index.js"
import type { Interface as StorageInterface } from "../../src/storage/service.js"

const snapshot = (sessionID: string, overrides: Partial<MeshSessionSnapshot> = {}): MeshSessionSnapshot => ({
  sessionID,
  agent: "coder",
  cost: 0,
  tokens: emptyTokens(),
  createdAt: 1_000,
  updatedAt: 2_000,
  ...overrides,
})

interface Harness {
  readonly storage: StorageInterface
  readonly mesh: MeshService
  readonly sessions: SessionPort
  readonly ctx: Context
  readonly prompts: Array<{ sessionID: string; text: string; delivery?: string }>
  readonly synthetics: Array<{ sessionID: string; text: string }>
  readonly interrupted: string[]
}

const withHarness = async (fn: (harness: Harness) => Promise<void>) => {
  const directory = await mkdtemp(join(tmpdir(), "banyancode-mesh-tools-"))
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const storage = yield* Storage.open({ projectRoot: directory, env: {} })
          const promptEvents: Harness["prompts"] = []
          const syntheticEvents: Harness["synthetics"] = []
          const interrupted: string[] = []
          const fixtures = new Map<string, MeshSessionSnapshot>()
          fixtures.set("root", snapshot("root", { agent: "orchestrator" }))
          fixtures.set("child", snapshot("child", { parentID: "root", agent: "coder" }))

          const sessions: SessionPort = {
            list: () => Effect.succeed([...fixtures.values()]),
            get: (sessionID) => Effect.succeed(fixtures.get(sessionID)),
            create: (input) => Effect.succeed({ id: `${input.parentID}-${input.agent}` }),
            prompt: (input) =>
              Effect.sync(() => {
                promptEvents.push({
                  sessionID: input.sessionID,
                  text: input.text,
                  ...(input.delivery === undefined ? {} : { delivery: input.delivery }),
                })
              }),
            wait: () => Effect.void,
            synthetic: (input) =>
              Effect.sync(() => {
                syntheticEvents.push({ sessionID: input.sessionID, text: input.text })
              }),
            interrupt: (sessionID) =>
              Effect.sync(() => {
                interrupted.push(sessionID)
                return true
              }),
            context: () =>
              Effect.succeed([
                { type: "assistant", content: [{ type: "text", text: "pass: looks good" }] },
              ] as never),
          }

          const config = BanyanConfig.make({
            directory,
            projectRoot: directory,
            globalDir: join(directory, "global-config"),
            env: {},
          })
          const kv = new Map<string, unknown>()
          const ctx = {
            permission: { assert: () => Effect.void },
            storage: {
              get: (key: string) => Effect.sync(() => kv.get(key) as never),
              set: (key: string, value: unknown) =>
                Effect.sync(() => {
                  kv.set(key, value)
                }),
              remove: (key: string) =>
                Effect.sync(() => {
                  kv.delete(key)
                }),
              scan: (options: { prefix: string; limit?: number }) =>
                Effect.sync(() => ({
                  entries: [...kv.entries()]
                    .filter(([key]) => key.startsWith(options.prefix))
                    .slice(0, options.limit ?? 1000)
                    .map(([key, value]) => ({ key, value: value as never })),
                })),
            },
          } as unknown as Context
          const mesh = yield* makeMesh({ storage, config, sessions })

          yield* Effect.promise(() =>
            fn({ storage, mesh, sessions, ctx, prompts: promptEvents, synthetics: syntheticEvents, interrupted }),
          )
        }),
      ),
    )
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

const context = (sessionID: string, agent: string) =>
  ({
    sessionID,
    agent,
    messageID: "msg_1",
    id: "call_1",
    progress: () => Effect.void,
  }) as never

const tool = (harness: Harness, name: string) => {
  const found = buildMeshTools({ ctx: harness.ctx, mesh: harness.mesh, sessions: harness.sessions }).find(
    (candidate) => candidate.name === name,
  )
  if (found === undefined) throw new Error(`tool not found: ${name}`)
  return found
}

const runTool = async (
  harness: Harness,
  name: string,
  input: Record<string, unknown>,
  sessionID = "root",
  agent = "orchestrator",
) =>
  (await Effect.runPromise(tool(harness, name).execute(input as never, context(sessionID, agent)))) as {
    output: Record<string, unknown>
    content?: string
  }

describe("mesh RPC surface", () => {
  test("owns the banyancode.mesh namespace with status, sessionStatus, limits, background, and status.updated", () => {
    expect(Definition.id).toBe("banyancode.mesh")
    expect(Object.keys(Definition.methods).sort()).toEqual([
      "background",
      "kill",
      "limits.get",
      "limits.set",
      "sessionStatus",
      "status",
      "steer",
    ])
    expect(Object.keys(Definition.events)).toEqual(["status.updated"])
  })
})

describe("mesh tools on a real plugin database", () => {
  test("subagent_message retries upsert one row and preserve the original createdAt", async () => {
    await withHarness(async (harness) => {
      const input = { kind: "inform", payload: { summary: "found the bug" } }
      const first = await runTool(harness, "subagent_message", input)
      const second = await runTool(harness, "subagent_message", input)
      expect(second.output.idempotencyKey).toBe(first.output.idempotencyKey)
      expect(second.output.createdAt).toBe(first.output.createdAt)
      expect(second.output.delivered).toBe(true)
      expect(second.output.pending).toBe(1)
      const count = await Effect.runPromise(
        harness.storage.query<{ count: number }>("SELECT COUNT(*) AS count FROM subagent_messages"),
      )
      expect(count[0]?.count).toBe(1)
    })
  })

  test("mesh_subscribe delivers peer messages once, then times out", async () => {
    await withHarness(async (harness) => {
      await runTool(harness, "subagent_message", { kind: "request", payload: { action: "status" } }, "child", "coder")
      const first = await runTool(harness, "mesh_subscribe", { parentSessionID: "root", timeoutMs: 100 })
      expect(first.output.messages).toHaveLength(1)
      expect(first.output.timedOut).toBe(false)
      expect((first.output.messages as Array<{ fromSession: string }>)[0]?.fromSession).toBe("child")

      const second = await runTool(harness, "mesh_subscribe", { parentSessionID: "root", timeoutMs: 40 })
      expect(second.output.messages).toHaveLength(0)
      expect(second.output.timedOut).toBe(true)
      expect(second.output.streamActive).toBe(false)
    })
  })

  test("checkpoint messages are visible to checkin from the root mailbox", async () => {
    await withHarness(async (harness) => {
      await runTool(
        harness,
        "subagent_message",
        { kind: "checkpoint", payload: { summary: "halfway", todos: [{ content: "tests", status: "in_progress" }] } },
        "child",
        "coder",
      )
      const checkin = await runTool(harness, "mesh_control", { action: "checkin" })
      const peers = checkin.output.result as Array<{
        agent: string
        sessionID: string
        lastCheckpoint?: { summary: string }
      }>
      expect(peers).toHaveLength(1)
      expect(peers[0]).toMatchObject({ agent: "coder", sessionID: "child" })
      expect(peers[0]?.lastCheckpoint?.summary).toBe("halfway")
    })
  })

  test("steer and kill deliver to the target session through v2 session APIs", async () => {
    await withHarness(async (harness) => {
      const steer = await runTool(harness, "mesh_control", {
        action: "steer",
        targetAgent: "coder",
        instruction: "focus on repos",
      })
      expect(steer.output.result).toBe("steered coder")
      expect(harness.prompts[0]).toMatchObject({ sessionID: "child", delivery: "steer" })
      expect(harness.prompts[0]?.text).toContain("focus on repos")

      const kill = await runTool(harness, "mesh_control", {
        action: "kill",
        targetAgent: "coder",
        reason: "superseded",
      })
      expect(kill.output.result).toBe("killed coder")
      expect(harness.interrupted).toEqual(["child"])
    })
  })

  test("shared_memory inherits session scope to the root and enforces expectedVersion", async () => {
    await withHarness(async (harness) => {
      const shared = makeSharedMemoryTool({ ctx: harness.ctx, sessions: harness.sessions, projectID: "proj" })
      const exec = async (input: Record<string, unknown>, sessionID: string, agent: string) =>
        (await Effect.runPromise(shared.execute(input as never, context(sessionID, agent)))) as {
          output: Record<string, unknown>
        }

      const written = await exec({ op: "write", key: "research:mesh", payload: { found: true } }, "child", "coder")
      expect(written.output.ok).toBe(true)

      const read = await exec({ op: "read", key: "research:mesh" }, "root", "orchestrator")
      const entries = read.output.entries as Array<{ value: unknown; version: number }>
      expect(entries[0]?.value).toEqual({ found: true })
      expect(entries[0]?.version).toBe(1)

      const stale = await exec(
        { op: "write", key: "research:mesh", payload: {}, expectedVersion: 99 },
        "child",
        "coder",
      )
      expect(stale.output.error).toBe("stale_write")

      const deleted = await exec({ op: "delete", key: "research:mesh" }, "root", "orchestrator")
      expect(deleted.output.deleted).toBe(1)
      const listed = await exec({ op: "list" }, "root", "orchestrator")
      expect(listed.output.entries).toHaveLength(0)
    })
  })

  test("review dispatch completes the request and injects the verdict into the parent", async () => {
    await withHarness(async (harness) => {
      const queued = await Effect.runPromise(
        harness.mesh.queueReview({
          parentSessionID: "root",
          reviewSpec: { targetAgent: "reviewer", description: "check the mesh" },
        }),
      )
      const request = await Effect.runPromise(harness.mesh.reviews.getByID(queued.reviewID))
      expect(request?.status).toBe("pending")
      await Effect.runPromise(harness.mesh.dispatchReview(request!))
      const completed = await Effect.runPromise(harness.mesh.reviews.getByID(queued.reviewID))
      expect(completed?.status).toBe("completed")
      expect(completed?.result).toEqual({ text: "pass: looks good", childSessionID: "root-reviewer" })
      expect(harness.synthetics.some((event) => event.text.includes(`<review_result reviewID="${queued.reviewID}">`))).toBe(
        true,
      )
    })
  })

  test("mesh RPC status reports the session tree", async () => {
    await withHarness(async (harness) => {
      const stopped: string[] = []
      const rpc = handlers({
        mesh: harness.mesh,
        background: (sessionID) => Effect.sync(() => void stopped.push(sessionID)),
      })
      const rpcContext = { error: () => { throw new Error("unexpected rpc error") } } as never
      const status = await Effect.runPromise(rpc.status({}, rpcContext))
      expect(status.roots).toHaveLength(1)
      expect(status.roots[0]?.sessionID).toBe("root")
      expect(status.roots[0]?.children.map((node) => node.sessionID)).toEqual(["child"])

      const scoped = await Effect.runPromise(rpc.sessionStatus({ sessionID: "child" }, rpcContext))
      expect(scoped.roots[0]?.sessionID).toBe("child")

      const limits = await Effect.runPromise(rpc["limits.get"]({}, rpcContext))
      expect(limits.maxSubagents).toBe(5)
      expect(limits.maxSubagentsLimit).toBe(20)

      await Effect.runPromise(rpc.background({ sessionID: "child" }, rpcContext))
      expect(stopped).toEqual(["child"])
    })
  })

  test("mesh RPC steer and kill reach the mesh service", async () => {
    await withHarness(async (harness) => {
      const calls: string[] = []
      const rpc = handlers({
        mesh: {
          ...harness.mesh,
          steer: (input) => Effect.sync(() => (calls.push(`steer:${input.targetAgent}:${input.instruction}`), { delivered: 1 })),
          kill: (input) => Effect.sync(() => (calls.push(`kill:${input.targetAgent}:${input.reason}`), { killed: 1 })),
        },
        background: () => Effect.void,
      })
      const rpcContext = { error: () => { throw new Error("unexpected rpc error") } } as never
      const steered = await Effect.runPromise(
        rpc.steer({ parentSessionID: "root", targetAgent: "coder", instruction: "focus" }, rpcContext),
      )
      const killed = await Effect.runPromise(
        rpc.kill({ parentSessionID: "root", targetAgent: "coder", reason: "done" }, rpcContext),
      )
      expect(steered.delivered).toBe(1)
      expect(killed.killed).toBe(1)
      expect(calls).toEqual(["steer:coder:focus", "kill:coder:done"])
    })
  })
})

