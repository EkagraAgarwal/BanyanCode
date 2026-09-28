import { Effect, Exit, Option, Schema } from "effect"
import { Banyan } from "@opencode-ai/core/banyancode"
import { Jev } from "@opencode-ai/core/banyancode/jev"
import { Session } from "@/session/session"
import { JevActivity } from "@/session/jev-activity"
import * as Tool from "./tool"

// Explicit `jev_judge` hook: the model asks Jev one bounded Choice question
// and gets a typed verdict back (task.ts is the separate, internal routing
// caller of the same core client). Contract:
//   - the privacy warning ships in the description: `state`/`question` leave
//     the machine for the configured Jev backend;
//   - NO request is made unless a visible durable activity started first —
//     JevActivity.start verifies the CURRENT assistant message (ctx.messageID)
//     and a failed start skips `Jev.decide` entirely;
//   - operationID is the stable ctx.callID, so running → terminal upserts the
//     SAME part id under this one tool call;
//   - exactly one Jev request per call, no double usage: the activity's
//     `usage` is informational and never rolls into session cost/tokens;
//   - every unavailable outcome (disabled / missing-key / network / invalid)
//     is a fail-safe response that escalates the question back to the model
//     (Jev.decide never throws; we still branch on `ok`).

const MAX_STATE = 8_000
const MAX_QUESTION = 1_000
const MAX_CHOICE = 120 // SessionV1.JevActivityPart.choice bound
const MAX_CHOICES = 8
const MAX_SUMMARY = 400 // SessionV1.JevActivityPart.summary bound

const id = "jev_judge"
const TITLE = "Jev judge"

const DESCRIPTION = [
  "Ask Jev (TypeSafe System One) to answer ONE bounded Choice question and return its typed verdict (choice + confidence + probabilities).",
  "Use it only for enumerable, no-writing decisions with 2-8 mutually exclusive options — never for planning, writing, or open-ended questions.",
  "PRIVACY WARNING: `state` and `question` are sent to an external Jev endpoint (default https://api.typesafe.ai) — never include secrets, credentials, API keys, private keys, passwords, or personal data.",
  "The user sees this tool call and a durable Jev activity row under it; exactly one Jev request is made per call, and only after that activity is visible.",
  'When the response is `status="unavailable"` (disabled, no API key, network error), treat the question as UNANSWERED: decide it yourself or ask the user — never claim Jev returned a choice.',
].join("\n")

export const Parameters = Schema.Struct({
  state: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(MAX_STATE)).annotate({
    description: `The bounded facts the decision is about, at most ${MAX_STATE} characters. Strip secrets and personal data — this text leaves the machine.`,
  }),
  question: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(MAX_QUESTION)).annotate({
    description: `The decision phrased about \`state\`, at most ${MAX_QUESTION} characters.`,
  }),
  choices: Schema.Array(Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(MAX_CHOICE)))
    .check(Schema.isMinLength(2), Schema.isMaxLength(MAX_CHOICES))
    .annotate({
      description: `2 to ${MAX_CHOICES} mutually exclusive, non-blank answers, each at most ${MAX_CHOICE} characters.`,
    }),
})

interface JevJudgeMetadata {
  status: string
  reason?: string
  choice?: string
  confidence?: number
  backend?: string
  model?: string
}

const bound = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

// Fail-safe escalation: the question is unanswered, so the model decides or
// asks — it must never present an unavailable verdict as a Jev choice.
const failSafe = (reason: string): string =>
  [
    `<jev_judge status="unavailable">`,
    `Jev did not answer: ${reason}`,
    `</jev_judge>`,
    `Treat the question as UNANSWERED: decide it yourself from the state, or ask the user. Do not claim Jev returned a choice.`,
  ].join("\n")

export const JevJudgeTool = Tool.define(
  id,
  Effect.gen(function* () {
    const sessions = yield* Session.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (
        params: Schema.Schema.Type<typeof Parameters>,
        ctx: Tool.Context,
      ): Effect.Effect<Tool.ExecuteResult<JevJudgeMetadata>> =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: id,
            patterns: ["*"],
            always: ["*"],
            metadata: { question: params.question },
          })

          const banyanCfgOpt = yield* Effect.serviceOption(Banyan.BanyanConfigService)
          const banyanCfg = Option.isSome(banyanCfgOpt) ? yield* banyanCfgOpt.value.get() : undefined
          const resolution = Jev.resolve(banyanCfg)
          if (!resolution.enabled) {
            const reason =
              banyanCfg?.banyancode_jev_enabled === false
                ? "Jev is disabled (banyancode_jev_enabled=false)"
                : `no Jev API key for the ${resolution.backend} backend (set BANYANCODE_JEV_API_KEY)`
            return { title: TITLE, metadata: { status: "unavailable", reason }, output: failSafe(reason) }
          }

          // Visible activity BEFORE any request: if the current message is not
          // a usable assistant target, `Jev.decide` must never run.
          const activity = yield* JevActivity.start({
            sessionID: ctx.sessionID,
            messageID: ctx.messageID,
            operationID: ctx.callID ?? `jev-judge:${crypto.randomUUID()}`,
            feature: "jev-judge",
          }).pipe(
            Effect.provideService(Session.Service, sessions),
            Effect.catchCause(() => Effect.succeed(undefined)),
          )
          if (!activity) {
            const reason = "no visible Jev activity could start for this message; no request was sent"
            return { title: TITLE, metadata: { status: "unavailable", reason }, output: failSafe(reason) }
          }

          const decision = yield* Effect.promise(() =>
            Jev.decide({
              state: params.state,
              question: params.question,
              choices: params.choices,
              config: banyanCfg,
            }),
          )

          if (!decision.ok) {
            yield* activity
              .finish({
                status: "failed",
                summary: bound(`${decision.reason}: ${decision.message}`, MAX_SUMMARY),
                latency: { ms: decision.latencyMs },
              })
              .pipe(Effect.catchCause(() => Effect.void))
            const reason = `${decision.reason}: ${decision.message}`
            return { title: TITLE, metadata: { status: "unavailable", reason }, output: failSafe(reason) }
          }

          const settled = yield* activity
            .finish({
              status: "completed",
              choice: decision.choice,
              summary: bound(`Jev selected ${decision.choice}`, MAX_SUMMARY),
              latency: { ms: decision.latencyMs },
              usage: decision.usage
                ? {
                    input: decision.usage.inputTokens ?? 0,
                    output: decision.usage.outputTokens ?? 0,
                    cost: decision.usage.cost,
                  }
                : undefined,
            })
            .pipe(Effect.exit)
          if (Exit.isFailure(settled)) {
            const reason = "Jev answered but its activity could not be completed; do not apply the decision"
            return { title: TITLE, metadata: { status: "unavailable", reason }, output: failSafe(reason) }
          }

          return {
            title: TITLE,
            metadata: {
              status: "ok",
              choice: decision.choice,
              confidence: decision.confidence,
              backend: decision.backend,
              model: decision.model,
            },
            output: JSON.stringify({
              status: "ok",
              choice: decision.choice,
              confidence: decision.confidence,
              probabilities: decision.probabilities,
              backend: decision.backend,
              model: decision.model,
              latencyMs: decision.latencyMs,
              advisory: "Weigh this decision against the evidence before acting.",
            }),
          }
        }).pipe(Effect.orDie),
    }
  }),
)
