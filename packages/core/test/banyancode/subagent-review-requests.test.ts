import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { tmpdir } from "../fixture/tmpdir"
import path from "path"
import { SubagentReviewRequests } from "../../src/banyancode/subagent-review-requests-repo"

process.env.BANYANCODE_ENABLE = "1"

describe("SubagentReviewRequestsRepo", () => {
  test("listPending returns only pending rows, oldest first", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)
    const repoLayer = SubagentReviewRequests.defaultLayer.pipe(Layer.provide(dbLayer))

    await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* SubagentReviewRequests.Service
        const base = {
          parentSessionID: "ses_parent",
          targetAgent: "reviewer",
          diff: null,
          description: null,
          paths: null,
          priority: null,
          reason: null,
          result: null,
        } as const
        yield* repo.put({ ...base, id: "r1", status: "pending", createdAt: 100 })
        yield* repo.put({ ...base, id: "r2", status: "completed", createdAt: 200 })
        yield* repo.put({ ...base, id: "r3", status: "pending", createdAt: 300 })

        const pending = yield* repo.listPending()
        expect(pending.map((r) => r.id)).toEqual(["r1", "r3"])
      }).pipe(Effect.provide(repoLayer), Effect.scoped),
    )
  })

  test("markDispatched only transitions pending rows (conditional)", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)
    const repoLayer = SubagentReviewRequests.defaultLayer.pipe(Layer.provide(dbLayer))

    await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* SubagentReviewRequests.Service
        const base = {
          parentSessionID: "ses_parent",
          targetAgent: "reviewer",
          diff: null,
          description: null,
          paths: null,
          priority: null,
          reason: null,
          result: null,
        } as const
        yield* repo.put({ ...base, id: "a", status: "pending", createdAt: 100 })
        yield* repo.put({ ...base, id: "b", status: "completed", createdAt: 200 })

        // First dispatch wins.
        yield* repo.markDispatched("a")
        expect((yield* repo.getByID("a"))?.status).toBe("dispatched")

        // A second dispatch (e.g. the queue path racing the poll path) no-ops.
        yield* repo.markDispatched("a")
        expect((yield* repo.getByID("a"))?.status).toBe("dispatched")

        // Terminal rows are never resurrected to dispatched.
        yield* repo.markDispatched("b")
        expect((yield* repo.getByID("b"))?.status).toBe("completed")
      }).pipe(Effect.provide(repoLayer), Effect.scoped),
    )
  })
})
