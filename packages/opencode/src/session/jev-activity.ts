import { Effect, Option, Schema } from "effect"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { PartID, type MessageID, type SessionID } from "./schema"
import { Session } from "./session"

// Production publisher for the durable Jev activity UI pipeline
// (SessionV1.JevActivityPart → message.part.updated → part table → TUI row
// under the target assistant message).
//
// Integration (TaskTool or an explicit jev_judge hook; only Session.Service is
// required — TaskTool already yields it at tool/task.ts:151 and has
// ctx.sessionID / ctx.messageID):
//
//   const jev = yield* JevActivity.start({
//     sessionID: ctx.sessionID,
//     messageID: ctx.messageID,           // verified existing assistant message
//     operationID: `task:${ctx.callID}`,  // stable across running → terminal
//     feature: "task-dispatch",
//   })
//   const answer = ...                    // typed decision, never raw model text
//   yield* jev.finish({ status: "completed", choice: answer.choice, summary: answer.reason })
//   // on error: yield* jev.finish({ status: "failed", summary: reason })
//
// `start` verifies the target message EXISTS with role "assistant" (fails with
// TargetError otherwise — jev rows must never attach to user turns, which the
// TUI does not render), publishes the `running` part through
// Session.updatePart, and returns a handle whose `finish` republishes the SAME
// part id so the part table upserts running → terminal in place. `choice` and
// `summary` MUST be pre-redacted bounded strings (≤120 / ≤400 chars) — never a
// raw model transcript or provider payload. `latency` defaults to the elapsed
// wall time since `start`.

export class TargetError extends Schema.TaggedErrorClass<TargetError>()("JevActivityTargetError", {
  message: Schema.String,
}) {}

export interface StartInput {
  readonly sessionID: SessionID
  /** Target assistant message — verified to exist with role "assistant" before anything is published. */
  readonly messageID: MessageID
  /** Stable identity of the underlying operation; unchanged across running → terminal. */
  readonly operationID: string
  /** Feature that made the decision (e.g. "command-gate", "router"). */
  readonly feature: string
  /** Optional explicit stable part id; defaults to a fresh PartID. */
  readonly partID?: PartID
}

export interface FinishInput {
  readonly status: Exclude<SessionV1.JevActivityStatus, "running">
  /** Pre-redacted decision label (≤120 chars). */
  readonly choice?: string
  /** Pre-redacted one-line summary (≤400 chars). */
  readonly summary?: string
  /** Defaults to elapsed wall time since start(). */
  readonly latency?: { readonly ms: number }
  /** Informational token/cost accounting; never rolled into session cost/tokens. */
  readonly usage?: { readonly input: number; readonly output: number; readonly cost?: number }
}

export interface Handle {
  readonly partID: PartID
  readonly operationID: string
  /** Republishes the SAME part id so the part table upserts in place. */
  readonly finish: (input: FinishInput) => Effect.Effect<SessionV1.JevActivityPart, TargetError>
}

// Schema-bound validation happens here (typed failure) instead of dying inside
// the durable event commit, so an over-redacted choice/summary is a normal
// error the caller can observe and never reaches the part table.
const submit = (sessions: Session.Interface, part: SessionV1.JevActivityPart) =>
  Schema.decodeUnknownEffect(SessionV1.JevActivityPart)(part).pipe(
    Effect.mapError((error) => new TargetError({ message: `invalid jev activity part: ${String(error)}` })),
    Effect.flatMap((validated) => sessions.updatePart(validated)),
  )

export const start: (input: StartInput) => Effect.Effect<Handle, TargetError, Session.Service> = Effect.fn(
  "JevActivity.start",
)(function* (input: StartInput) {
  const sessions = yield* Session.Service
  const found = yield* sessions.findMessage(input.sessionID, (message) => message.info.id === input.messageID).pipe(
    Effect.catchTag("NotFoundError", (error) =>
      Effect.fail(new TargetError({ message: `jev activity session ${input.sessionID} not found: ${error.message}` })),
    ),
  )
  if (Option.isNone(found))
    return yield* new TargetError({
      message: `jev activity target message ${input.messageID} does not exist in session ${input.sessionID}`,
    })
  if (found.value.info.role !== "assistant")
    return yield* new TargetError({
      message: `jev activity requires an existing assistant message; ${input.messageID} is a ${found.value.info.role} message`,
    })

  const partID = input.partID ?? PartID.ascending()
  const startedAt = Date.now()
  yield* submit(sessions, {
    id: partID,
    sessionID: input.sessionID,
    messageID: input.messageID,
    type: "jev_activity",
    operationID: input.operationID,
    feature: input.feature,
    status: "running",
  })

  return {
    partID,
    operationID: input.operationID,
    finish: (outcome: FinishInput) =>
      submit(sessions, {
        id: partID,
        sessionID: input.sessionID,
        messageID: input.messageID,
        type: "jev_activity",
        operationID: input.operationID,
        feature: input.feature,
        status: outcome.status,
        choice: outcome.choice,
        summary: outcome.summary,
        latency: outcome.latency ?? { ms: Math.max(0, Date.now() - startedAt) },
        usage: outcome.usage,
      }),
  }
})

export * as JevActivity from "./jev-activity"
