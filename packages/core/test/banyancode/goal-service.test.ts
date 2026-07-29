import { describe, expect, test } from "bun:test"
import { Effect, Layer, Queue } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { GoalService, GoalConflictError } from "../../src/banyancode/goal-service"
import { tmpdir } from "../fixture/tmpdir"
import path from "path"

process.env.BANYANCODE_ENABLE = "1"

const buildLayer = (dbPath: string) =>
  GoalService.defaultLayer.pipe(Layer.provide(Database.layerFromPath(dbPath)))

describe("GoalService", () => {
  test("setGoal creates an active goal and getActiveGoal returns it", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)

    const program = Effect.gen(function* () {
      const svc = yield* GoalService.Service
      const created = yield* svc.setGoal({
        parentSessionID: "ses_parent_1",
        condition: "all packages pass bun typecheck",
        planPath: "./plan.md",
        priority: "normal",
      })
      expect(created.status).toBe("active")
      expect(created.iterationCount).toBe(0)
      expect(created.parentSessionID).toBe("ses_parent_1")
      expect(created.condition).toBe("all packages pass bun typecheck")
      expect(created.planPath).toBe("./plan.md")
      expect(created.priority).toBe("normal")
      expect(created.lastReviewVerdict).toBeNull()

      const active = yield* svc.getActiveGoal("ses_parent_1")
      expect(active?.id).toBe(created.id)
      expect(active?.status).toBe("active")
    }).pipe(Effect.provide(buildLayer(dbPath)), Effect.provide(dbLayer))

    await Effect.runPromise(program)
  })

  test("setGoal fails with GoalConflictError when an active goal already exists", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)

    const program = Effect.gen(function* () {
      const svc = yield* GoalService.Service
      const first = yield* svc.setGoal({
        parentSessionID: "ses_parent_2",
        condition: "first goal",
      })

      const second = yield* svc
        .setGoal({
          parentSessionID: "ses_parent_2",
          condition: "second goal (should fail)",
        })
        .pipe(Effect.flip)

      expect(second).toBeInstanceOf(GoalConflictError)
      const err = second as GoalConflictError
      expect(err.parentSessionID).toBe("ses_parent_2")
      expect(err.existingGoalID).toBe(first.id)
    }).pipe(Effect.provide(buildLayer(dbPath)), Effect.provide(dbLayer))

    await Effect.runPromise(program)
  })

  test("recordReviewVerdict bumps iteration_count and stamps the verdict", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)

    const program = Effect.gen(function* () {
      const svc = yield* GoalService.Service
      const goal = yield* svc.setGoal({
        parentSessionID: "ses_parent_3",
        condition: "ship the /goal command",
        planPath: "./plan.md",
      })

      const updated = yield* svc.recordReviewVerdict({
        id: goal.id,
        reviewID: "review_1",
        verdict: "fail",
        reason: "step 3 not done",
      })

      expect(updated.iterationCount).toBe(1)
      expect(updated.lastReviewID).toBe("review_1")
      expect(updated.lastReviewVerdict).toBe("fail")
      expect(updated.lastReviewReason).toBe("step 3 not done")

      const after = yield* svc.recordReviewVerdict({
        id: goal.id,
        reviewID: "review_2",
        verdict: "pass",
        reason: null,
      })
      expect(after.iterationCount).toBe(2)
      expect(after.lastReviewVerdict).toBe("pass")
    }).pipe(Effect.provide(buildLayer(dbPath)), Effect.provide(dbLayer))

    await Effect.runPromise(program)
  })

  test("achieve transitions active to achieved exactly once", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)

    const program = Effect.gen(function* () {
      const svc = yield* GoalService.Service
      const goal = yield* svc.setGoal({
        parentSessionID: "ses_parent_4",
        condition: "ship it",
      })

      const achieved = yield* svc.achieve(goal.id, "all tests passing")
      expect(achieved.status).toBe("achieved")
      expect(achieved.achievedAt).not.toBeNull()
      expect(achieved.achievedAt!).toBeGreaterThan(0)

      // Second achieve on a terminal row is a no-op (idempotent)
      const again = yield* svc.achieve(goal.id, "should not move updated_at much")
      expect(again.status).toBe("achieved")
      expect(again.achievedAt).toBe(achieved.achievedAt)

      // getActiveGoal returns undefined once terminal
      const active = yield* svc.getActiveGoal("ses_parent_4")
      expect(active).toBeUndefined()
    }).pipe(Effect.provide(buildLayer(dbPath)), Effect.provide(dbLayer))

    await Effect.runPromise(program)
  })

  test("block sets status=blocked and blockedAt, listGoals returns the terminal row", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)

    const program = Effect.gen(function* () {
      const svc = yield* GoalService.Service
      const goal = yield* svc.setGoal({
        parentSessionID: "ses_parent_5",
        condition: "achieve impossible",
      })

      const blocked = yield* svc.block(goal.id, "exceeded banyancode_max_goal_iterations")
      expect(blocked.status).toBe("blocked")
      expect(blocked.blockedAt).not.toBeNull()

      const all = yield* svc.listGoals("ses_parent_5")
      expect(all.length).toBe(1)
      expect(all[0]?.status).toBe("blocked")
    }).pipe(Effect.provide(buildLayer(dbPath)), Effect.provide(dbLayer))

    await Effect.runPromise(program)
  })

  test("cancel marks the active goal cancelled", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)

    const program = Effect.gen(function* () {
      const svc = yield* GoalService.Service
      const goal = yield* svc.setGoal({
        parentSessionID: "ses_parent_6",
        condition: "user decided to bail",
      })

      const cancelled = yield* svc.cancel(goal.id, "user-cancelled-via-cli")
      expect(cancelled.status).toBe("cancelled")
      expect(cancelled.achievedAt).toBeNull()
      expect(cancelled.blockedAt).toBeNull()
    }).pipe(Effect.provide(buildLayer(dbPath)), Effect.provide(dbLayer))

    await Effect.runPromise(program)
  })

  test("events queue emits GoalSet / GoalReviewRecorded / GoalAchieved envelopes", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)

    const program = Effect.gen(function* () {
      const svc = yield* GoalService.Service
      const queue = svc.events()

      const goal = yield* svc.setGoal({
        parentSessionID: "ses_parent_7",
        condition: "drive the events queue",
      })
      yield* svc.recordReviewVerdict({
        id: goal.id,
        reviewID: "review_events",
        verdict: "pass",
        reason: "all green",
      })
      yield* svc.achieve(goal.id, "events test")

      const seen: string[] = []
      for (let i = 0; i < 3; i++) {
        const e = yield* Queue.take(queue)
        seen.push(e.type)
      }
      expect(seen).toContain("banyancode.goal.set")
      expect(seen).toContain("banyancode.goal.review_recorded")
      expect(seen).toContain("banyancode.goal.achieved")
    }).pipe(Effect.provide(buildLayer(dbPath)), Effect.provide(dbLayer))

    await Effect.runPromise(program)
  })
})