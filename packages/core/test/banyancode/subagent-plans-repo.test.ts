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

  test("setStepStatus happy path updates the targeted step and bumps updatedAt", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "plans-step-happy.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)
    const serviceLayer = Banyan.subagentPlansRepoLayer

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)

        const repo = yield* Banyan.SubagentPlansRepo

        yield* repo.put({
          id: "plan-step-happy",
          parentSessionID: "parent-1",
          agent: "agent-1",
          sessionID: "session-1",
          title: "Step happy",
          steps: [
            { content: "Step 0", status: "pending" },
            { content: "Step 1", status: "pending" },
          ],
          exitCriteria: "Done",
          status: "active",
          createdAt: Date.now(),
        })

        const before = (yield* repo.getByID("plan-step-happy"))!

        const afterFirst = yield* repo.setStepStatus("plan-step-happy", 0, "in_progress")
        expect(afterFirst).toBeDefined()
        expect(afterFirst?.steps[0]).toEqual({ content: "Step 0", status: "in_progress" })
        expect(afterFirst?.steps[1]).toEqual({ content: "Step 1", status: "pending" })
        expect(afterFirst?.updatedAt).toBeGreaterThanOrEqual(before.updatedAt)

        const afterSecond = yield* repo.setStepStatus("plan-step-happy", 1, "completed")
        expect(afterSecond?.steps[0]).toEqual({ content: "Step 0", status: "in_progress" })
        expect(afterSecond?.steps[1]).toEqual({ content: "Step 1", status: "completed" })
        expect(afterSecond?.updatedAt).toBeGreaterThanOrEqual(afterFirst!.updatedAt)

        const persisted = yield* repo.getByID("plan-step-happy")
        expect(persisted?.steps).toEqual([
          { content: "Step 0", status: "in_progress" },
          { content: "Step 1", status: "completed" },
        ])
        expect(persisted?.updatedAt).toBe(afterSecond?.updatedAt)
      }).pipe(Effect.provide(serviceLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("setStepStatus returns undefined for an unknown planID and does not create a row", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "plans-step-unknown.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)
    const serviceLayer = Banyan.subagentPlansRepoLayer

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)

        const repo = yield* Banyan.SubagentPlansRepo

        yield* repo.put({
          id: "plan-exists",
          parentSessionID: "parent-1",
          agent: "agent-1",
          sessionID: "session-1",
          title: "Exists",
          steps: [{ content: "Step 0", status: "pending" }],
          exitCriteria: "Done",
          status: "active",
          createdAt: Date.now(),
        })

        const result = yield* repo.setStepStatus("nonexistent", 0, "completed")
        expect(result).toBeUndefined()

        const all = yield* repo.listByParent("parent-1")
        expect(all.length).toBe(1)
        expect(all[0].id).toBe("plan-exists")
      }).pipe(Effect.provide(serviceLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("setStepStatus with out-of-bounds stepIndex is a no-op", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "plans-step-oob.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)
    const serviceLayer = Banyan.subagentPlansRepoLayer

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)

        const repo = yield* Banyan.SubagentPlansRepo
        const createdAt = Date.now() - 5_000

        yield* repo.put({
          id: "plan-step-oob",
          parentSessionID: "parent-1",
          agent: "agent-1",
          sessionID: "session-1",
          title: "OOB",
          steps: [{ content: "Step 0", status: "pending" }],
          exitCriteria: "Done",
          status: "active",
          createdAt,
        })

        const before = (yield* repo.getByID("plan-step-oob"))!
        expect(before.steps.length).toBe(1)

        const result = yield* repo.setStepStatus("plan-step-oob", 5, "completed")
        expect(result).toBeDefined()
        expect(result?.steps).toEqual([{ content: "Step 0", status: "pending" }])
        expect(result?.updatedAt).toBe(before.updatedAt)

        const after = yield* repo.getByID("plan-step-oob")
        expect(after?.steps).toEqual([{ content: "Step 0", status: "pending" }])
        expect(after?.updatedAt).toBe(before.updatedAt)
      }).pipe(Effect.provide(serviceLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("setStepStatus races on different steps preserve both updates", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "plans-step-race.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)
    const serviceLayer = Banyan.subagentPlansRepoLayer

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)

        const repo = yield* Banyan.SubagentPlansRepo

        yield* repo.put({
          id: "plan-step-race",
          parentSessionID: "parent-1",
          agent: "agent-1",
          sessionID: "session-1",
          title: "Race",
          steps: [
            { content: "Step 0", status: "pending" },
            { content: "Step 1", status: "pending" },
          ],
          exitCriteria: "Done",
          status: "active",
          createdAt: Date.now(),
        })

        // Fire both updates through the same DB connection simultaneously. The
        // single-transaction read-modify-write inside setStepStatus must
        // serialize them so neither update is lost.
        const [a, b] = yield* Effect.all(
          [
            repo.setStepStatus("plan-step-race", 0, "in_progress"),
            repo.setStepStatus("plan-step-race", 1, "completed"),
          ],
          { concurrency: "unbounded" },
        )

        const persisted = yield* repo.getByID("plan-step-race")
        expect(persisted?.steps).toEqual([
          { content: "Step 0", status: "in_progress" },
          { content: "Step 1", status: "completed" },
        ])

        // Whichever we returned last should match the persisted snapshot.
        const last = [a, b].filter((p) => p !== undefined).pop()
        expect(last?.steps).toEqual(persisted?.steps)
      }).pipe(Effect.provide(serviceLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("setStepStatus does not implicitly promote the next step", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "plans-step-noprop.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)
    const serviceLayer = Banyan.subagentPlansRepoLayer

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)

        const repo = yield* Banyan.SubagentPlansRepo

        yield* repo.put({
          id: "plan-step-noprop",
          parentSessionID: "parent-1",
          agent: "agent-1",
          sessionID: "session-1",
          title: "NoProp",
          steps: [
            { content: "Step 0", status: "pending" },
            { content: "Step 1", status: "pending" },
          ],
          exitCriteria: "Done",
          status: "active",
          createdAt: Date.now(),
        })

        const after = yield* repo.setStepStatus("plan-step-noprop", 0, "completed")
        expect(after?.steps[0]).toEqual({ content: "Step 0", status: "completed" })
        // Step 1 must still be pending — the repo never auto-promotes.
        expect(after?.steps[1]).toEqual({ content: "Step 1", status: "pending" })

        const persisted = yield* repo.getByID("plan-step-noprop")
        expect(persisted?.steps[1]).toEqual({ content: "Step 1", status: "pending" })
      }).pipe(Effect.provide(serviceLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })
})
