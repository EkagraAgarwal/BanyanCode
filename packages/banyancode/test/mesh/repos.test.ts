import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { Storage } from "../../src/storage/index.js"
import type { Interface as StorageInterface } from "../../src/storage/service.js"
import { makeMessagesRepo } from "../../src/mesh/messages-repo.js"
import { makePlansRepo } from "../../src/mesh/plans-repo.js"
import { makeReviewsRepo } from "../../src/mesh/review-repo.js"
import type { SubagentMessage } from "../../src/mesh/types.js"

const withStorage = async (fn: (storage: StorageInterface) => Promise<void>) => {
  const directory = await mkdtemp(join(tmpdir(), "banyancode-mesh-repos-"))
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const storage = yield* Storage.open({ projectRoot: directory, env: {} })
          yield* Effect.promise(() => fn(storage))
        }),
      ),
    )
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

const message = (overrides: Partial<SubagentMessage> = {}): SubagentMessage => ({
  id: "msg-1",
  parentSessionID: "root",
  fromSession: "child",
  fromAgent: "coder",
  kind: "inform",
  payload: { summary: "halfway" },
  createdAt: 1_000,
  ...overrides,
})

describe("mesh messages repo", () => {
  test("publishOrFetch is idempotent and never clears delivered_at on redelivery", async () => {
    await withStorage(async (storage) => {
      const repo = makeMessagesRepo(storage)
      const first = await Effect.runPromise(repo.publishOrFetch(message()))
      expect(first).toEqual({ id: "msg-1", createdAt: 1_000, created: true })

      await Effect.runPromise(repo.markDelivered("msg-1", 2_000))
      // A retry with a fresh tool call id and a later createdAt must return the
      // original row and must not un-deliver it.
      const retry = await Effect.runPromise(repo.publishOrFetch(message({ createdAt: 9_999 })))
      expect(retry).toEqual({ id: "msg-1", createdAt: 1_000, created: false })
      expect((await Effect.runPromise(repo.get("msg-1")))?.deliveredAt).toBe(2_000)
      expect(await Effect.runPromise(repo.listPending("root"))).toHaveLength(0)
      expect(await Effect.runPromise(repo.countPending("root"))).toBe(0)
      expect(await Effect.runPromise(repo.listByParent("root", true))).toHaveLength(1)
    })
  })

  test("put upserts and stores a versioned payload envelope", async () => {
    await withStorage(async (storage) => {
      const repo = makeMessagesRepo(storage)
      await Effect.runPromise(repo.put(message()))
      await Effect.runPromise(repo.put(message({ payload: { summary: "done" } })))
      const rows = await Effect.runPromise(storage.query<{ payload: string }>("SELECT payload FROM subagent_messages"))
      expect(rows).toHaveLength(1)
      const parsed = JSON.parse(rows[0]!.payload) as { _v: number; data: unknown }
      expect(parsed._v).toBe(1)
      expect(parsed.data).toEqual({ summary: "done" })
      expect((await Effect.runPromise(repo.get("msg-1")))?.payload).toEqual({ summary: "done" })
    })
  })

  test("peers reports the latest sender within the window", async () => {
    await withStorage(async (storage) => {
      const repo = makeMessagesRepo(storage)
      const now = Date.now()
      await Effect.runPromise(repo.put(message({ id: "a", createdAt: now - 10 })))
      await Effect.runPromise(
        repo.put(message({ id: "b", fromSession: "child", fromAgent: "scout", createdAt: now })),
      )
      const peers = await Effect.runPromise(repo.peers("root"))
      expect(peers).toHaveLength(1)
      expect(peers[0]).toMatchObject({ sessionID: "child", agent: "scout", status: "active", lastSeenAt: now })
    })
  })
})

describe("mesh plans repo", () => {
  test("put/get round-trips steps and setStepStatus updates only the target index", async () => {
    await withStorage(async (storage) => {
      const repo = makePlansRepo(storage)
      await Effect.runPromise(
        repo.put({
          id: "plan-1",
          parentSessionID: "root",
          agent: "coder",
          sessionID: "child",
          title: "Implement mesh",
          steps: [
            { content: "repos", status: "completed" },
            { content: "tools", status: "in_progress" },
          ],
          exitCriteria: "tests green",
          status: "active",
          createdAt: 1_000,
          updatedAt: 1_000,
        }),
      )
      const updated = await Effect.runPromise(repo.setStepStatus("plan-1", 1, "completed"))
      expect(updated?.steps.map((step) => step.status)).toEqual(["completed", "completed"])
      expect(updated?.updatedAt).toBeGreaterThanOrEqual(1_000)

      // Out-of-bounds is a no-op; unknown ids return undefined.
      const untouched = await Effect.runPromise(repo.setStepStatus("plan-1", 9, "cancelled"))
      expect(untouched?.steps.map((step) => step.status)).toEqual(["completed", "completed"])
      expect(await Effect.runPromise(repo.setStepStatus("missing", 0, "completed"))).toBeUndefined()

      await Effect.runPromise(repo.markCompleted("plan-1"))
      expect((await Effect.runPromise(repo.getByID("plan-1")))?.status).toBe("completed")
      expect(await Effect.runPromise(repo.listBySession("child"))).toHaveLength(1)
    })
  })
})

describe("mesh review requests repo", () => {
  test("pending -> dispatched is conditional and terminal states persist a result", async () => {
    await withStorage(async (storage) => {
      const repo = makeReviewsRepo(storage)
      await Effect.runPromise(
        repo.put({
          id: "review-1",
          parentSessionID: "root",
          targetAgent: "reviewer",
          diff: "diff --git a b",
          description: "check the mesh",
          paths: ["packages/banyancode/src/mesh"],
          priority: "high",
          reason: "pre-merge",
          status: "pending",
          createdAt: 1_000,
          updatedAt: 1_000,
          result: null,
        }),
      )
      expect(await Effect.runPromise(repo.listPending())).toHaveLength(1)
      expect(await Effect.runPromise(repo.markDispatched("review-1"))).toBe(true)
      expect(await Effect.runPromise(repo.markDispatched("review-1"))).toBe(false)
      expect((await Effect.runPromise(repo.getByID("review-1")))?.status).toBe("dispatched")
      expect(await Effect.runPromise(repo.listPending())).toHaveLength(0)

      await Effect.runPromise(repo.markCompleted({ id: "review-1", result: { text: "pass", childSessionID: "rev" } }))
      const completed = await Effect.runPromise(repo.getByID("review-1"))
      expect(completed?.status).toBe("completed")
      expect(completed?.result).toEqual({ text: "pass", childSessionID: "rev" })
      expect(completed?.paths).toEqual(["packages/banyancode/src/mesh"])
    })
  })

  test("markFailed records the failure payload", async () => {
    await withStorage(async (storage) => {
      const repo = makeReviewsRepo(storage)
      await Effect.runPromise(
        repo.put({
          id: "review-2",
          parentSessionID: "root",
          targetAgent: "reviewer",
          diff: null,
          description: null,
          paths: null,
          priority: null,
          reason: null,
          status: "dispatched",
          createdAt: 1_000,
          updatedAt: 1_000,
          result: null,
        }),
      )
      await Effect.runPromise(repo.markFailed({ id: "review-2", result: { error: "boom" } }))
      const failed = await Effect.runPromise(repo.getByID("review-2"))
      expect(failed?.status).toBe("failed")
      expect(failed?.result).toEqual({ error: "boom" })
    })
  })
})
