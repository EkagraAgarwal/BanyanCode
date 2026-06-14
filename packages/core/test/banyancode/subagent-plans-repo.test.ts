import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import { Banyan } from "@opencode-ai/core/banyancode"
import { tmpdir } from "../fixture/tmpdir"
import path from "path"
import type { SubagentPlan } from "@opencode-ai/core/banyancode/subagent-plans-repo"

describe("SubagentPlansRepo", () => {
  test("put and getByID round-trip", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "plans.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)
    const serviceLayer = Banyan.subagentPlansRepoLayer

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)

        const repo = yield* Banyan.SubagentPlansRepo
        const plan: Omit<SubagentPlan, "updatedAt"> = {
          id: "plan-1",
          parentSessionID: "parent-session-1",
          agent: "agent-1",
          sessionID: "session-1",
          title: "Test Plan",
          steps: [
            { content: "Step 1", status: "pending" },
            { content: "Step 2", status: "in_progress" },
          ],
          exitCriteria: "All steps completed",
          status: "active",
          createdAt: Date.now(),
        }

        yield* repo.put(plan)
        const retrieved = yield* repo.getByID("plan-1")

        expect(retrieved).toBeDefined()
        expect(retrieved?.id).toBe("plan-1")
        expect(retrieved?.title).toBe("Test Plan")
        expect(retrieved?.steps).toEqual([
          { content: "Step 1", status: "pending" },
          { content: "Step 2", status: "in_progress" },
        ])
        expect(retrieved?.status).toBe("active")
      }).pipe(Effect.provide(serviceLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("listByParent returns all plans for an orchestrator session", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "plans-list.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)
    const serviceLayer = Banyan.subagentPlansRepoLayer

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)

        const repo = yield* Banyan.SubagentPlansRepo
        const parentSessionID = "parent-session-2"

        for (let i = 0; i < 3; i++) {
          yield* repo.put({
            id: `plan-parent2-${i}`,
            parentSessionID,
            agent: `agent-${i}`,
            sessionID: `session-${i}`,
            title: `Plan ${i}`,
            steps: [{ content: `Step ${i}`, status: "pending" as const }],
            exitCriteria: "Done",
            status: "active",
            createdAt: Date.now(),
          })
        }

        const plans = yield* repo.listByParent(parentSessionID)
        expect(plans.length).toBe(3)
        expect(plans.map((p) => p.id).sort()).toEqual(["plan-parent2-0", "plan-parent2-1", "plan-parent2-2"])
      }).pipe(Effect.provide(serviceLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("listBySession returns plans for a specific subagent", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "plans-session.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)
    const serviceLayer = Banyan.subagentPlansRepoLayer

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)

        const repo = yield* Banyan.SubagentPlansRepo
        const sessionID = "session-specific"

        yield* repo.put({
          id: "plan-session-1",
          parentSessionID: "parent-1",
          agent: "agent-1",
          sessionID,
          title: "Plan for session",
          steps: [{ content: "Step", status: "pending" }],
          exitCriteria: "Done",
          status: "active",
          createdAt: Date.now(),
        })
        yield* repo.put({
          id: "plan-session-2",
          parentSessionID: "parent-1",
          agent: "agent-1",
          sessionID,
          title: "Another plan for session",
          steps: [{ content: "Step", status: "pending" }],
          exitCriteria: "Done",
          status: "active",
          createdAt: Date.now(),
        })
        yield* repo.put({
          id: "plan-other-session",
          parentSessionID: "parent-1",
          agent: "agent-2",
          sessionID: "other-session",
          title: "Plan for other session",
          steps: [{ content: "Step", status: "pending" }],
          exitCriteria: "Done",
          status: "active",
          createdAt: Date.now(),
        })

        const plans = yield* repo.listBySession(sessionID)
        expect(plans.length).toBe(2)
        expect(plans.every((p) => p.sessionID === sessionID)).toBe(true)
      }).pipe(Effect.provide(serviceLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("markCompleted and markCancelled update the status", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "plans-status.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)
    const serviceLayer = Banyan.subagentPlansRepoLayer

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)

        const repo = yield* Banyan.SubagentPlansRepo

        yield* repo.put({
          id: "plan-status-1",
          parentSessionID: "parent-1",
          agent: "agent-1",
          sessionID: "session-1",
          title: "Plan to complete",
          steps: [{ content: "Step", status: "pending" }],
          exitCriteria: "Done",
          status: "active",
          createdAt: Date.now(),
        })
        yield* repo.put({
          id: "plan-status-2",
          parentSessionID: "parent-1",
          agent: "agent-1",
          sessionID: "session-1",
          title: "Plan to cancel",
          steps: [{ content: "Step", status: "pending" }],
          exitCriteria: "Done",
          status: "active",
          createdAt: Date.now(),
        })

        yield* repo.markCompleted("plan-status-1")
        yield* repo.markCancelled("plan-status-2")

        const completed = yield* repo.getByID("plan-status-1")
        expect(completed?.status).toBe("completed")

        const cancelled = yield* repo.getByID("plan-status-2")
        expect(cancelled?.status).toBe("cancelled")
      }).pipe(Effect.provide(serviceLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })
})
