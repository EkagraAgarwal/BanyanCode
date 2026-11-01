import { Cause, Effect } from "effect"
import type { SessionMessage } from "@opencode/schema/session-message"
import type { ReviewsRepo } from "./review-repo.js"
import type { SessionPort } from "./session-port.js"
import type { SubagentReviewRequest } from "./types.js"

/** v1 review-bridge prompt; kept byte-for-byte so reviewer behaviour is stable. */
export const formatReviewPrompt = (request: {
  readonly reviewID: string
  readonly diff: string | null
  readonly description: string | null
  readonly paths: readonly string[] | null
  readonly priority: string | null
  readonly reason: string | null
}): string => {
  const lines: string[] = []
  lines.push(`Review request ${request.reviewID}:`)
  if (request.description) lines.push("", "Description:", request.description)
  if (request.paths && request.paths.length > 0) {
    lines.push("", "Focus paths:", ...request.paths.map((path) => `  - ${path}`))
  }
  if (request.reason) lines.push("", "Reason:", request.reason)
  if (request.diff) lines.push("", "Diff:", "```diff", request.diff, "```")
  if (request.priority) lines.push("", `Priority: ${request.priority}`)
  lines.push("", "Return pass / fail / blocked with a one-paragraph rationale.")
  return lines.join("\n")
}

export const lastAssistantText = (messages: readonly SessionMessage.Info[]): string => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.type !== "assistant") continue
    const text = message.content
      .flatMap((part) => (part.type === "text" ? [part.text] : []))
      .join("\n")
      .trim()
    if (text.length > 0) return text
  }
  return ""
}

const renderResult = (reviewID: string, text: string) =>
  [`<review_result reviewID="${reviewID}">`, text, "</review_result>"].join("\n")

export interface ReviewDispatchDeps {
  readonly sessions: SessionPort
  readonly reviews: ReviewsRepo
  readonly modelForAgent: (agentID: string) => Effect.Effect<
    { readonly providerID: string; readonly id: string; readonly variant?: string } | undefined
  >
  /** `banyancode_goal_evaluator_model` ("provider/model") — v1's fallback. */
  readonly evaluatorModel: () => Effect.Effect<string | undefined>
}

const parseModelRef = (value: string | undefined) => {
  if (value === undefined) return undefined
  const slash = value.indexOf("/")
  if (slash <= 0 || slash === value.length - 1) return undefined
  return { providerID: value.slice(0, slash), id: value.slice(slash + 1) }
}

/**
 * Dispatch one queued review. The conditional `pending → dispatched` update
 * makes this safe against a crash-recovery pass racing the live call: exactly
 * one dispatcher wins. Failures mark the row `failed` so recovery never spins
 * on a poisoned request.
 */
export const dispatchReview = (deps: ReviewDispatchDeps) => (request: SubagentReviewRequest) =>
  Effect.gen(function* () {
    const won = yield* deps.reviews.markDispatched(request.id)
    if (!won) return
    yield* Effect.gen(function* () {
      // Model priority mirrors v1: the reviewer agent's own model, then the
      // parent session's model. v2 resolves an agent/default model when both
      // are absent, so an empty result is still safe.
      const parent = yield* deps.sessions.get(request.parentSessionID)
      const model =
        (yield* deps.modelForAgent(request.targetAgent)) ??
        parseModelRef(yield* deps.evaluatorModel()) ??
        parent?.model
      const child = yield* deps.sessions.create({
        parentID: request.parentSessionID,
        title: `Review: ${request.id}`,
        agent: request.targetAgent,
        ...(model === undefined ? {} : { model }),
      })
      yield* deps.sessions.prompt({
        sessionID: child.id,
        text: formatReviewPrompt({
          reviewID: request.id,
          diff: request.diff,
          description: request.description,
          paths: request.paths,
          priority: request.priority,
          reason: request.reason,
        }),
      })
      yield* deps.sessions.wait(child.id)
      const messages = yield* deps.sessions.context(child.id)
      const text = lastAssistantText(messages)
      yield* deps.reviews.markCompleted({ id: request.id, result: { text, childSessionID: child.id } })
      // Deliver the verdict into the orchestrator session so its next turn can
      // act on it. Ignore a parent that disappeared while the reviewer ran.
      yield* deps.sessions
        .synthetic({ sessionID: request.parentSessionID, text: renderResult(request.id, text) })
        .pipe(Effect.catchCause(() => Effect.void))
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("mesh: review dispatch failed", { reviewID: request.id, cause: Cause.pretty(cause) }).pipe(
          Effect.andThen(
            deps.reviews.markFailed({ id: request.id, result: { error: Cause.pretty(cause) } }),
          ),
          Effect.catchCause(() => Effect.void),
        ),
      ),
    )
  })
