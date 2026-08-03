import { describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import path from "path"
import { Effect, Layer, Queue } from "effect"
import { ToolCall } from "@opencode-ai/llm"
import { Database } from "@opencode-ai/core/database/database"
import { GoalService, GoalConflictError } from "../../src/banyancode/goal-service"
import { DEFAULT_MAX_GOAL_ITERATIONS } from "../../src/v1/config/banyan-config"
import { GoalTool } from "../../src/tool/goal"
import { Tool } from "../../src/tool/tool"
import { ToolCatalog } from "../../src/tool/tool-catalog"
import { ApplicationTools } from "../../src/tool/application-tools"
import { ToolOutputStore } from "../../src/tool-output-store"
import type { Interface as PermissionV2Interface } from "../../src/permission"
import { PermissionV2 } from "../../src/permission"
import { tmpdir } from "../fixture/tmpdir"

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

  test("setGoal while an active goal exists auto-cancels the stale goal", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)

    const program = Effect.gen(function* () {
      const svc = yield* GoalService.Service
      const first = yield* svc.setGoal({
        parentSessionID: "ses_parent_2",
        condition: "first goal",
      })
      expect(first.status).toBe("active")

      // No completion in between: a stale active goal (e.g. from an aborted
      // loop) must not block reuse of /goal — the second set auto-cancels it.
      const second = yield* svc.setGoal({
        parentSessionID: "ses_parent_2",
        condition: "second goal (reuses the session)",
      })
      expect(second.status).toBe("active")
      expect(second.id).not.toBe(first.id)

      const firstAfter = yield* svc.getGoal(first.id)
      expect(firstAfter?.status).toBe("cancelled")

      const active = yield* svc.getActiveGoal("ses_parent_2")
      expect(active?.id).toBe(second.id)
    }).pipe(Effect.provide(buildLayer(dbPath)), Effect.provide(dbLayer))

    await Effect.runPromise(program)
  })

  test("setGoal keeps the id-collision check (explicit duplicate id still conflicts)", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)

    const program = Effect.gen(function* () {
      const svc = yield* GoalService.Service
      const id = "fixed-goal-id"
      const first = yield* svc.setGoal({
        id,
        parentSessionID: "ses_parent_2b",
        condition: "first goal with explicit id",
      })
      expect(first.status).toBe("active")

      const second = yield* svc
        .setGoal({
          id,
          parentSessionID: "ses_parent_2b",
          condition: "duplicate id should fail",
        })
        .pipe(Effect.flip)

      expect(second).toBeInstanceOf(GoalConflictError)
      const err = second as GoalConflictError
      expect(err.parentSessionID).toBe("ses_parent_2b")
      expect(err.existingGoalID).toBe(first.id)
    }).pipe(Effect.provide(buildLayer(dbPath)), Effect.provide(dbLayer))

    await Effect.runPromise(program)
  })

  test("setGoal → achieve → setGoal again works (goal is reusable after a goal ends)", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)

    const program = Effect.gen(function* () {
      const svc = yield* GoalService.Service
      const first = yield* svc.setGoal({
        parentSessionID: "ses_parent_2c",
        condition: "round one",
      })
      const achieved = yield* svc.achieve(first.id, "done")
      expect(achieved.status).toBe("achieved")

      const second = yield* svc.setGoal({
        parentSessionID: "ses_parent_2c",
        condition: "round two",
      })
      expect(second.status).toBe("active")
      expect(second.id).not.toBe(first.id)

      // The achieved goal stays terminal; only the new goal is active.
      const firstAfter = yield* svc.getGoal(first.id)
      expect(firstAfter?.status).toBe("achieved")
      const active = yield* svc.getActiveGoal("ses_parent_2c")
      expect(active?.id).toBe(second.id)
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

  test("goal tool: set defaults planPath and record_review blocks at max iterations", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)

    const sessionID = "ses_tool_goal"
    const messageID = "msg_tool_goal"
    const makeContext = (): Tool.Context => ({
      sessionID: sessionID as Tool.Context["sessionID"],
      agent: "orchestrator" as Tool.Context["agent"],
      assistantMessageID: messageID as Tool.Context["assistantMessageID"],
      toolCallID: randomUUID(),
    })
    const makeCall = (input: unknown): ToolCall => ({
      type: "tool-call",
      id: randomUUID(),
      name: GoalTool.name,
      input,
    })
    const mockPermission: PermissionV2Interface = {
      assert: () => Effect.void,
      ask: () => Effect.void,
      reply: () => Effect.void,
      configured: () => Effect.void,
      list: () => Effect.succeed([]),
      get: () => Effect.void,
      forSession: () => Effect.void,
    } as unknown as PermissionV2Interface

    const outputStore = Layer.mock(ToolOutputStore.Service, {
      bound: (input) => Effect.sync(() => ({ output: input.output, outputPaths: [] as const })),
    })
    const catalogLayer = ToolCatalog.layer.pipe(
      Layer.provide(ApplicationTools.layer),
      Layer.provide(outputStore),
    )
    const permissionLayer = Layer.succeed(PermissionV2.Service, mockPermission as never)
    const layer = GoalTool.locationLayer.pipe(
      Layer.provideMerge(catalogLayer),
      Layer.provideMerge(permissionLayer),
      Layer.provideMerge(GoalService.defaultLayer.pipe(Layer.provide(dbLayer))),
    )

    const program = Effect.gen(function* () {
      const catalog = yield* ToolCatalog.Service
      const tool = (yield* catalog.list()).get(GoalTool.name)
      if (!tool) return yield* Effect.die("goal tool not registered")

      // `set` without planPath defaults it to ./plan.md
      const setOutput = yield* Tool.settle(
        tool,
        makeCall({ action: "set", condition: "fix everything" }),
        makeContext(),
      )
      const setResult = (setOutput.structured as { result: { goal: { planPath: string | null } } }).result
      expect(setResult.goal.planPath).toBe("./plan.md")

      // A failing review at the default max (5) blocks the goal and reports the loop ended.
      let lastResult: { goal: { status: string }; loopEnded?: boolean; reason?: string } | undefined
      for (let i = 1; i <= DEFAULT_MAX_GOAL_ITERATIONS; i++) {
        const output = yield* Tool.settle(
          tool,
          makeCall({
            action: "record_review",
            reviewID: `review-${i}`,
            verdict: "fail",
            reason: "not done yet",
          }),
          makeContext(),
        )
        lastResult = (output.structured as { result: typeof lastResult }).result
      }
      expect(lastResult?.loopEnded).toBe(true)
      expect(lastResult?.reason).toBe("max iterations reached")
      expect(lastResult?.goal.status).toBe("blocked")

      const svc = yield* GoalService.Service
      const goals = yield* svc.listGoals(sessionID)
      expect(goals[0]?.status).toBe("blocked")
    }).pipe(Effect.provide(layer), Effect.scoped)

    // Tool.settle reads ToolTelemetry / AdaptedCatalog via serviceOption, which
    // degrade gracefully when absent; the cast matches codegraph-remove-tool.test.ts.
    await Effect.runPromise(program as unknown as Effect.Effect<unknown, never, never>)
  })
})