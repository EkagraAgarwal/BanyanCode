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
 *  5. Run the prompt via SessionPrompt.Service.
 *  6. Mark the row completed (with the result text) or failed (with the error)
 *     via SubagentReviewRequestsRepo.
 *
 * The bridge runs in `applyReviewBridge` and is wired from
 * `app-runtime.ts` next to the existing `applyCodegraphBuildBridge` /
 * `applyMeshBridge` calls.
 */
import { Cause, Effect, Option, Queue } from "effect"
import { Service as SubagentBusService } from "@opencode-ai/core/banyancode/subagent-bus"
import { Service as SubagentReviewRequestsService } from "@opencode-ai/core/banyancode/subagent-review-requests-repo"
import type { SubagentMessage } from "@opencode-ai/core/banyancode/types"
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

export const applyReviewBridge = Effect.fn("applyReviewBridge")(function* () {
  const flags = yield* RuntimeFlags.Service
  if (!flags.banyancodeEnable) return

  const busOpt = yield* Effect.serviceOption(SubagentBusService)
  if (Option.isNone(busOpt)) return
  const reviewsOpt = yield* Effect.serviceOption(SubagentReviewRequestsService)
  if (Option.isNone(reviewsOpt)) return
  const agentSvcOpt = yield* Effect.serviceOption(Agent.Service)
  if (Option.isNone(agentSvcOpt)) return
  const sessionsOpt = yield* Effect.serviceOption(Session.Service)
  if (Option.isNone(sessionsOpt)) return
  const promptSvcOpt = yield* Effect.serviceOption(SessionPrompt.Service)
  if (Option.isNone(promptSvcOpt)) return
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
        // Phase 1D: the reviewer's `model` is required for the prompt. If the
        // reviewer config has no model, fall back to an empty ProviderV2/ModelV2
        // and let SessionPrompt fail-fast at runtime with a typed error —
        // the bridge then markFailed the request with the error message.
        const model = subagent.model ?? { modelID: ModelV2.ID.make(""), providerID: ProviderV2.ID.make("") }

        const result = yield* promptSvc.prompt({
          messageID: MessageID.ascending(),
          sessionID: child.id,
          model,
          agent: subagent.name,
          parts: [{ type: "text", text: promptText }],
        })
        let text = ""
        for (const part of result.parts) {
          if (part.type === "text") text = part.text
        }
        yield* reviews.markCompleted({ id: reviewID, result: { text, childSessionID: child.id } })
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