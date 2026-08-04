/**
 * Phase 1D review-bridge.
 *
 * Mirrors the `banyancode-codegraph-bridge.ts` pattern: a single global
 * Dequeue (here, `SubagentBus.subscribeAll()`) is drained by exactly one
 * consumer. Per AGENTS.md "Service events queue ownership", this bridge is
 * the SOLE consumer of the global SubagentBus queue — do not add a second
 * `Queue.take` loop on the same handle, even inside the core layer, or the
 * TUI will drop half of every review dispatch.
 *
 * On each `kind: "review"` SubagentMessage:
 *  1. Look up the agent by name (must be `reviewer` with `mode === "subagent"`).
 *     Anything else → markFailed with the reason, no SessionPrompt call.
 *  2. Create a child session under the orchestrator (the message's
 *     `parentSessionID`) via Session.Service.
 *  3. Compute the child permission ruleset via
 *     `deriveSubagentSessionPermission(parent, subagent)`.
 *  4. Format a review prompt from the `reviewSpec` payload fields.
 *  5. Resolve the reviewer model (reviewer agent's own model →
 *     `banyancode_goal_evaluator_model` → parent session model; never an
 *     empty model — `Provider.getModel("", "")` throws and strands the row
 *     in `dispatched`). When nothing resolves, mark the request failed with
 *     a typed error.
 *  6. Run the prompt via SessionPrompt.Service.
 *  7. Mark the row completed (with the result text) or failed (with the error)
 *     via SubagentReviewRequestsRepo.
 *  8. Inject the verdict into the parent session (synthetic text part) so the
 *     orchestrator LLM can read it on its next turn and call
 *     `goal(action="record_review", reviewID, verdict, reason)`.
 *
 * The bridge runs in `applyReviewBridge` and is wired from
 * `app-runtime.ts` next to the existing `applyCodegraphBuildBridge` /
 * `applyMeshBridge` calls.
 */
import { Cause, Effect, Option, Queue, Schema } from "effect"
import { Service as SubagentBusService } from "@opencode-ai/core/banyancode/subagent-bus"
import { Service as SubagentReviewRequestsService } from "@opencode-ai/core/banyancode/subagent-review-requests-repo"
import type { SubagentMessage } from "@opencode-ai/core/banyancode/types"
import { Banyan } from "@opencode-ai/core/banyancode"
import { SessionID, MessageID } from "@/session/schema"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { Agent } from "@/agent/agent"
import { EventV2Bridge } from "@/event-v2-bridge"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { deriveSubagentSessionPermission } from "@/agent/subagent-permissions"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"

const formatReviewPrompt = (msg: SubagentMessage): string => {
  // The `payload` is `{ reviewID, diff?, description?, paths?, priority?, reason? }`
  // per the MeshCoordinator.review contract. We assemble a review prompt that
  // the `reviewer` agent (read-only) can act on.
  const payload = (msg.payload ?? {}) as Record<string, unknown>
  const reviewID = typeof payload.reviewID === "string" ? payload.reviewID : (msg.reviewID ?? msg.id)
  const diff = typeof payload.diff === "string" ? payload.diff : undefined
  const description = typeof payload.description === "string" ? payload.description : undefined
  const paths = Array.isArray(payload.paths)
    ? (payload.paths as ReadonlyArray<unknown>).filter((p): p is string => typeof p === "string")
    : undefined
  const priority = typeof payload.priority === "string" ? payload.priority : undefined
  const reason = typeof payload.reason === "string" ? payload.reason : undefined

  const lines: string[] = []
  lines.push(`Review request ${reviewID}:`)
  if (description) lines.push("", "Description:", description)
  if (paths && paths.length > 0) {
    lines.push("", "Focus paths:", ...paths.map((p) => `  - ${p}`))
  }
  if (reason) lines.push("", "Reason:", reason)
  if (diff) lines.push("", "Diff:", "```diff", diff, "```")
  if (priority) lines.push("", `Priority: ${priority}`)
  lines.push("", "Return pass / fail / blocked with a one-paragraph rationale.")
  return lines.join("\n")
}

/**
 * Raised when a review request cannot be dispatched because no model can be
 * resolved: the reviewer agent defines no `model`, `banyancode_goal_evaluator_model`
 * is unset, and the parent session has no model. Dispatching with an empty
 * model would throw `Provider.getModel("", "")` (ModelNotFoundError) and
 * leave the request stuck in `dispatched` forever.
 */
export class ReviewerModelUnavailableError extends Schema.TaggedErrorClass<ReviewerModelUnavailableError>()(
  "Banyan/ReviewerModelUnavailableError",
  {
    reviewID: Schema.String,
    reason: Schema.String,
  },
) {}

// Resolve the model for a review dispatch. Priority order:
//   1. The reviewer agent's own `model` (custom reviewer overrides).
//   2. `banyancode_goal_evaluator_model` from BanyanConfigService, a
//      "provider/model-id" string (mirrors the parse in `readAgentModelOverride`,
//      prompt.ts:97-108, and the task tool's agent-override split, task.ts:271-276).
//   3. The parent session's `Session.Info.model`.
//   4. Fail with `ReviewerModelUnavailableError` — never dispatch an empty model.
const resolveReviewerModel = Effect.fnUntraced(function* (input: {
  reviewID: string
  subagentModel: Agent.Info["model"]
  parentModel: Session.Info["model"]
}) {
  if (input.subagentModel?.modelID && input.subagentModel.providerID) {
    return {
      providerID: input.subagentModel.providerID,
      modelID: input.subagentModel.modelID,
    }
  }

  const cfgOpt = yield* Effect.serviceOption(Banyan.BanyanConfigService)
  if (Option.isSome(cfgOpt)) {
    const cfg = yield* cfgOpt.value.get()
    const evaluator = cfg.banyancode_goal_evaluator_model
    if (evaluator) {
      const parts = evaluator.split("/")
      if (parts.length >= 2 && parts[0].length > 0) {
        return {
          providerID: ProviderV2.ID.make(parts[0]),
          modelID: ModelV2.ID.make(parts.slice(1).join("/")),
        }
      }
    }
  }

  if (input.parentModel?.providerID && input.parentModel.id) {
    return {
      providerID: input.parentModel.providerID,
      modelID: input.parentModel.id,
    }
  }

  return yield* new ReviewerModelUnavailableError({
    reviewID: input.reviewID,
    reason:
      "reviewer agent has no model, banyancode_goal_evaluator_model is unset, and the parent session has no model",
  })
})

// Renders the review result delivered into the parent session. Contains the
// reviewID (so the orchestrator can correlate with `mesh_control(action=
// "review")`'s returned reviewID) plus the reviewer's verdict + reasoning.
const renderReviewResult = (reviewID: string, text: string): string =>
  [`<review_result reviewID="${reviewID}">`, text, `</review_result>`].join("\n")

export const applyReviewBridge = Effect.fn("applyReviewBridge")(function* () {
  const flags = yield* RuntimeFlags.Service
  if (!flags.banyancodeEnable) {
    yield* Effect.logWarning("review-bridge: disabled (banyancodeEnable=false)")
    return
  }

  const busOpt = yield* Effect.serviceOption(SubagentBusService)
  if (Option.isNone(busOpt)) {
    yield* Effect.logWarning("review-bridge: disabled (SubagentBus not in scope)")
    return
  }
  const reviewsOpt = yield* Effect.serviceOption(SubagentReviewRequestsService)
  if (Option.isNone(reviewsOpt)) {
    yield* Effect.logWarning("review-bridge: disabled (SubagentReviewRequests not in scope)")
    return
  }
  const agentSvcOpt = yield* Effect.serviceOption(Agent.Service)
  if (Option.isNone(agentSvcOpt)) {
    yield* Effect.logWarning("review-bridge: disabled (Agent not in scope)")
    return
  }
  const sessionsOpt = yield* Effect.serviceOption(Session.Service)
  if (Option.isNone(sessionsOpt)) {
    yield* Effect.logWarning("review-bridge: disabled (Session not in scope)")
    return
  }
  const promptSvcOpt = yield* Effect.serviceOption(SessionPrompt.Service)
  if (Option.isNone(promptSvcOpt)) {
    yield* Effect.logWarning("review-bridge: disabled (SessionPrompt not in scope)")
    return
  }
  // EventV2Bridge is optional — used for status republish. If absent, we
  // just skip the re-publish step. `eventsOpt` is captured in closure so the
  // drain's R-channel does NOT widen to require EventV2Bridge when it's
  // absent at composition time.
  const eventsOpt = yield* Effect.serviceOption(EventV2Bridge.Service)

  const bus = busOpt.value
  const reviews = reviewsOpt.value
  const agentSvc = agentSvcOpt.value
  const sessions = sessionsOpt.value
  const promptSvc = promptSvcOpt.value
  const events = Option.isSome(eventsOpt) ? eventsOpt.value : undefined

  const queue = yield* bus.subscribeAll()

  // Drain the global SubagentBus queue. Only `kind: "review"` messages are
  // ours — every other kind passes through unchanged. We do NOT republish
  // them via EventV2Bridge: that is the subagent-consumer's job, and the
  // bridge is the sole owner of this queue.
  const work = Effect.gen(function* () {
    while (true) {
      const msg = yield* Queue.take(queue)
      if (msg.kind !== "review") continue
      yield* Effect.gen(function* () {
        const reviewID = msg.reviewID
        if (!reviewID) {
          yield* Effect.logWarning("review-bridge: dropping review message without reviewID", { msgID: msg.id })
          return
        }

        // 1. Validate the agent.
        const subagent = yield* agentSvc.get(msg.toAgent ?? "reviewer")
        if (!subagent) {
          yield* reviews.markFailed({
            id: reviewID,
            result: { error: `agent not found: ${msg.toAgent ?? "reviewer"}` },
          })
          return
        }
        if (subagent.mode !== "subagent") {
          yield* reviews.markFailed({
            id: reviewID,
            result: { error: `agent ${subagent.name} has mode=${subagent.mode}; reviewer must be subagent` },
          })
          return
        }

        // 2. Create a child session under the orchestrator.
        const parent = yield* sessions.get(msg.parentSessionID as SessionID).pipe(
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              yield* Effect.logError("review-bridge: failed to load parent session", {
                cause: Cause.pretty(cause),
              })
              return yield* Effect.fail(cause)
            }),
          ),
        )

        const childPermission = deriveSubagentSessionPermission({
          parentSessionPermission: parent.permission ?? [],
          subagent,
        })

        const child = yield* sessions.create({
          parentID: parent.id,
          title: `Review: ${msg.id}`,
          agent: subagent.name,
          permission: childPermission,
        })

        yield* reviews.markDispatched(reviewID)

        // 3. Format the review prompt and run it.
        const promptText = formatReviewPrompt(msg)
        // Phase 1D fix: the reviewer agent has no `model` field. Resolve the
        // model in order (reviewer agent's own model →
        // `banyancode_goal_evaluator_model` → parent session model) and NEVER
        // dispatch with an empty model — `Provider.getModel("", "")` throws
        // ModelNotFoundError and the request would stay `dispatched` forever.
        // When nothing resolves, fail the request with a typed error.
        const model = yield* resolveReviewerModel({
          reviewID,
          subagentModel: subagent.model,
          parentModel: parent.model,
        }).pipe(
          Effect.catchTag("Banyan/ReviewerModelUnavailableError", (error) =>
            Effect.gen(function* () {
              yield* reviews.markFailed({ id: reviewID, result: { error: error.reason } })
              return undefined
            }),
          ),
        )
        if (!model) return

        const result = yield* promptSvc.prompt({
          messageID: MessageID.ascending(),
          sessionID: child.id,
          model,
          agent: subagent.name,
          parts: [{ type: "text", text: promptText }],
        })
        const text = result.parts.findLast((part) => part.type === "text")?.text ?? ""
        yield* reviews.markCompleted({ id: reviewID, result: { text, childSessionID: child.id } })

        // Deliver the verdict into the parent session so the orchestrator
        // LLM reads it on its next turn and can call `goal(action=
        // "record_review", reviewID, verdict, reason)`. Mirrors the
        // task-result injection (task.ts:318-322): a synthetic text part,
        // forked + ignored so a busy parent session never stalls the
        // SubagentBus drain loop.
        yield* Effect.forkDetach(
          promptSvc
            .prompt({
              sessionID: parent.id,
              agent: parent.agent ?? "orchestrator",
              parts: [{ type: "text", synthetic: true, text: renderReviewResult(reviewID, text) }],
            })
            .pipe(Effect.ignore),
        )
      }).pipe(Effect.catchCause((cause) => Effect.logError("review-bridge: dispatch failed", { cause })))
    }
  }).pipe(
    Effect.catchCause((cause) => Effect.logError("review-bridge: drain loop failed; stopping", { cause })),
  )

  // Detached fiber — the bridge must survive the AppRuntime runFork caller
  // scope. Mirrors the codegraph-bridge / system-bridge / memory-bridge
  // pattern.
  yield* Effect.forkDetach(work)
})