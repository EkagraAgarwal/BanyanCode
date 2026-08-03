import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer, Ref } from "effect"
import path from "path"
import os from "os"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SubagentReviewRequests } from "@opencode-ai/core/banyancode/subagent-review-requests-repo"
import { SubagentMessagesRepo } from "@opencode-ai/core/banyancode/subagent-messages-repo"
import { SubagentPlans } from "@opencode-ai/core/banyancode/subagent-plans-repo"
import { SubagentBus } from "@opencode-ai/core/banyancode/subagent-bus"
import { MeshCoordinator } from "@opencode-ai/core/banyancode/mesh-coordinator"
import { Banyan } from "@opencode-ai/core/banyancode"
import { applyReviewBridge } from "@/effect/banyancode-review-bridge"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { Agent } from "@/agent/agent"
import { EventV2Bridge } from "@/event-v2-bridge"
import { BackgroundJob } from "@/background/job"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { testEffect, pollWithTimeout } from "../lib/effect"
import { disposeAllInstances } from "../fixture/fixture"

process.env.BANYANCODE_ENABLE = "1"

afterEach(async () => {
  await disposeAllInstances()
})

const TEST_DB_PATH = path.join(
  os.tmpdir(),
  `opencode-review-bridge-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
)

type PromptCall = {
  sessionID: string
  model?: { providerID: string; modelID: string }
  agent?: string
  text: string
}

// All prompt calls the mock SessionPrompt receives, in order. The bridge is
// the only caller: (1) the child review prompt, (2) the parent-session
// verdict injection (forked + ignored).
const promptCalls = await Effect.runPromise(Ref.make<PromptCall[]>([]))

// Reviewer agent stub. The REAL reviewer (`agent.ts:441-493`) has NO `model`
// field — that is the exact bug this test guards. `model` stays undefined so
// the bridge must exercise its fallback resolution (config → parent model).
const mockAgentLayer = Layer.mock(Agent.Service, {
  get: (name: string) =>
    Effect.succeed(
      name === "reviewer"
        ? ({
            name: "reviewer",
            mode: "subagent",
            model: undefined,
            permission: [],
            options: {},
          } as any)
        : undefined,
    ),
})

// Mock SessionPrompt: keeps the bridge's code path real (model resolution,
// markDispatched/markCompleted, injection) while faking only the LLM round
// trip. The child review prompt fails when the resolved model is empty —
// mirroring `Provider.getModel("", "")` throwing ModelNotFoundError, which is
// what the OLD bridge hit (it dispatched with `{ modelID: "", providerID: "" }`).
const mockPromptLayer = Layer.mock(SessionPrompt.Service, {
  prompt: (input: any) =>
    Effect.gen(function* () {
      const text = (input.parts ?? []).map((p: any) => p?.text ?? "").join("\n")
      yield* Ref.update(promptCalls, (calls) => [
        ...calls,
        {
          sessionID: String(input.sessionID),
          model: input.model,
          agent: input.agent,
          text,
        },
      ])
      if (text.startsWith("Review request") && (!input.model?.modelID || !input.model?.providerID)) {
        // Die (not fail): `prompt`'s typed error channel is `Image.Error`, and
        // a defect is what the bridge's catchCause observes — same as a real
        // `Provider.getModel("", "")` ModelNotFoundError.
        return yield* Effect.die(new Error(`ModelNotFoundError: ${input.model?.providerID}/${input.model?.modelID}`))
      }
      return {
        info: { role: "assistant" as const },
        parts: [{ type: "text" as const, text: "pass - the diff is correct, no issues found" }],
      } as any
    }),
})

// BanyanConfigService mock: reads a per-test override. Test 1 keeps it empty
// (parent model fallback); test 2 sets `banyancode_goal_evaluator_model`
// (config fallback); test 3 leaves both empty (typed failure path).
const configRef = await Effect.runPromise(
  Ref.make<{ banyancode_goal_evaluator_model?: string }>({}),
)
const mockConfigLayer = Layer.mock(Banyan.BanyanConfigService, {
  get: () => Effect.map(Ref.get(configRef), (cfg) => cfg as any),
})

const dbLayer = Database.layerFromPath(TEST_DB_PATH)
const eventsLayer = EventV2.defaultLayer.pipe(Layer.provide(dbLayer))
const bridgeEventsLayer = EventV2Bridge.layer.pipe(Layer.provide(eventsLayer))
const flagsLayer = RuntimeFlags.layer({})

const reviewsLayer = SubagentReviewRequests.defaultLayer.pipe(Layer.provide(dbLayer))
const messagesLayer = SubagentMessagesRepo.defaultLayer.pipe(Layer.provide(dbLayer))
const busLayer = SubagentBus.layer.pipe(
  Layer.provide(messagesLayer),
  Layer.provide(dbLayer),
)
const plansLayer = SubagentPlans.defaultLayer.pipe(Layer.provide(dbLayer))

const meshLayer = MeshCoordinator.layer.pipe(
  Layer.provide(busLayer),
  Layer.provide(plansLayer),
  Layer.provide(reviewsLayer),
  Layer.provide(eventsLayer),
  Layer.provide(dbLayer),
)

const sessionLayer = Session.layer.pipe(
  Layer.provide(BackgroundJob.defaultLayer),
  Layer.provide(flagsLayer),
  Layer.provide(bridgeEventsLayer),
  Layer.provide(SessionExecution.noopLayer),
  Layer.provide(SessionV2.defaultLayer.pipe(Layer.provide(dbLayer))),
  Layer.provide(dbLayer),
)

const it = testEffect(
  Layer.mergeAll(
    dbLayer,
    eventsLayer,
    bridgeEventsLayer,
    flagsLayer,
    reviewsLayer,
    messagesLayer,
    busLayer,
    plansLayer,
    meshLayer,
    sessionLayer,
    mockPromptLayer,
    mockAgentLayer,
    mockConfigLayer,
  ),
)

describe("review-bridge", () => {
  it.instance(
    "resolves the parent session model and delivers the verdict into the parent session",
    () =>
      Effect.gen(function* () {
        yield* Ref.set(configRef, {})
        yield* Ref.set(promptCalls, [])

        const sessions = yield* Session.Service
        const reviews = yield* SubagentReviewRequests.Service
        const mesh = yield* MeshCoordinator.Service

        const parent = yield* sessions.create({
          title: "orchestrator session",
          agent: "orchestrator",
          model: {
            id: ModelV2.ID.make("test-model"),
            providerID: ProviderV2.ID.make("test-provider"),
          },
        })

        const { reviewID } = yield* mesh.review({
          parentSessionID: parent.id,
          reviewSpec: {
            targetAgent: "reviewer",
            description: "review the diff",
            diff: "--- a/src/a.ts\n+++ b/src/a.ts\n",
            paths: ["src/a.ts"],
            priority: "high",
            reason: "exit criteria 5",
          },
        })

        yield* applyReviewBridge().pipe(Effect.scoped)

        // (a) the review row reaches a terminal state.
        const row = yield* pollWithTimeout(
          Effect.gen(function* () {
            const r = yield* reviews.getByID(reviewID)
            return r && r.status !== "pending" && r.status !== "dispatched" ? r : undefined
          }),
          "review row never reached a terminal state",
        )
        expect(row.status).toBe("completed")
        expect((row.result as any).text).toContain("pass")
        const childSessionID = (row.result as any).childSessionID as string
        expect(childSessionID).toBeDefined()

        // (b) the verdict result is written to the row.

        // Clean context: the bridge creates a fresh child session per dispatch.
        const children = yield* sessions.children(parent.id)
        expect(children.map((c) => String(c.id))).toContain(childSessionID)

        // The child review prompt used the parent session's model (non-empty).
        const calls = yield* Ref.get(promptCalls)
        const reviewCall = calls.find((c) => c.text.startsWith("Review request"))
        expect(reviewCall).toBeDefined()
        expect(reviewCall?.model?.modelID).toBe("test-model")
        expect(reviewCall?.model?.providerID).toBe("test-provider")

        // (c) the verdict was injected into the parent session.
        const injected = yield* pollWithTimeout(
          Effect.gen(function* () {
            const all = yield* Ref.get(promptCalls)
            return all.find((c) => c.sessionID === String(parent.id) && c.text.includes("<review_result"))
          }),
          "verdict was never injected into the parent session",
        )
        expect(injected.agent).toBe("orchestrator")
        expect(injected.text).toContain(reviewID)
        expect(injected.text).toContain("pass")
        expect(injected.text).toContain("<review_result")
      }),
  )

  it.instance(
    "falls back to banyancode_goal_evaluator_model when the reviewer and parent session have no model",
    () =>
      Effect.gen(function* () {
        yield* Ref.set(configRef, { banyancode_goal_evaluator_model: "eval-provider/eval-model" })
        yield* Ref.set(promptCalls, [])

        const sessions = yield* Session.Service
        const reviews = yield* SubagentReviewRequests.Service
        const mesh = yield* MeshCoordinator.Service

        // No model on the parent session — the config must supply it.
        const parent = yield* sessions.create({ title: "orchestrator session", agent: "orchestrator" })

        const { reviewID } = yield* mesh.review({
          parentSessionID: parent.id,
          reviewSpec: { targetAgent: "reviewer", description: "review the diff" },
        })

        yield* applyReviewBridge().pipe(Effect.scoped)

        const row = yield* pollWithTimeout(
          Effect.gen(function* () {
            const r = yield* reviews.getByID(reviewID)
            return r && r.status !== "pending" && r.status !== "dispatched" ? r : undefined
          }),
          "review row never reached a terminal state",
        )
        expect(row.status).toBe("completed")

        const calls = yield* Ref.get(promptCalls)
        const reviewCall = calls.find((c) => c.text.startsWith("Review request"))
        expect(reviewCall?.model?.modelID).toBe("eval-model")
        expect(reviewCall?.model?.providerID).toBe("eval-provider")
      }),
  )

  it.instance(
    "fails the review request with a typed error instead of dispatching an empty model",
    () =>
      Effect.gen(function* () {
        yield* Ref.set(configRef, {})
        yield* Ref.set(promptCalls, [])

        const sessions = yield* Session.Service
        const reviews = yield* SubagentReviewRequests.Service
        const mesh = yield* MeshCoordinator.Service

        // No reviewer model, no config model, no parent model → nothing to
        // dispatch with. The bridge must mark the row failed (not leave it
        // stuck in `dispatched`) and never call the prompt for the review.
        const parent = yield* sessions.create({ title: "orchestrator session", agent: "orchestrator" })

        const { reviewID } = yield* mesh.review({
          parentSessionID: parent.id,
          reviewSpec: { targetAgent: "reviewer", description: "review the diff" },
        })

        yield* applyReviewBridge().pipe(Effect.scoped)

        const row = yield* pollWithTimeout(
          Effect.gen(function* () {
            const r = yield* reviews.getByID(reviewID)
            return r && r.status !== "pending" && r.status !== "dispatched" ? r : undefined
          }),
          "review row never reached a terminal state",
        )
        expect(row.status).toBe("failed")
        expect(String((row.result as any).error)).toContain("no model")

        const calls = yield* Ref.get(promptCalls)
        expect(calls.find((c) => c.text.startsWith("Review request"))).toBeUndefined()
      }),
  )
})
