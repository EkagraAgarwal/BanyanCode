export * as SubagentMessageTool from "./subagent-message"

import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer, Schema } from "effect"
import { Banyan } from "../banyancode"
import { PermissionV2 } from "../permission"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "subagent_message"

export const Input = Schema.Struct({
  to: Schema.optional(Schema.String),
  kind: Schema.Literals(["request", "inform", "answer", "poll", "steer", "checkpoint", "plan", "kill"]),
  payload: Schema.Unknown,
  /**
   * Idempotency key for deduplication. If omitted, falls back to
   * `lk_${sessionID}_${callID}` where `callID` is the V1 tool-runtime's
   * per-attempt call id (stable for one in-flight call, NOT across LLM-
   * generated retries). For retries, the LLM MUST echo back `idempotencyKey`
   * and `createdAt` from the first call's return value.
   */
  idempotencyKey: Schema.optional(Schema.String),
  /**
   * Creation timestamp from the first call. Required when `idempotencyKey` is
   * provided on a retry so the server can detect which call is the original.
   */
  createdAt: Schema.optional(Schema.Number),
})

export const Output = Schema.Struct({
  delivered: Schema.Boolean,
  pending: Schema.Number,
  /** Stable idempotency key for this call; echo back on retry. */
  idempotencyKey: Schema.String,
  /** Creation timestamp of the (possibly pre-existing) row; echo back on retry. */
  createdAt: Schema.Number,
})

const banyancodeEnabled = () => process.env.BANYANCODE_ENABLE !== "0"

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    if (!banyancodeEnabled()) return

    const tools = yield* Tools.Service
    const permission = yield* PermissionV2.Service
    const bus = yield* Banyan.SubagentBus
    const repo = yield* Banyan.SubagentMessagesRepo

    yield* tools
      .register({
        [name]: Tool.make({
          description:
            `Send a message to a peer subagent or the orchestrator. Kinds:
- "request" — ask a peer to perform an action. payload: { action: string, ...args }
- "inform" — notify a peer of something. payload: { ... }
- "answer" — respond to a request. payload: { result: any }
- "poll" — check peer status. payload: {}
- "steer" — orchestrator injects an instruction into a subagent's current plan. payload: { instruction: string, priority?: "low"|"normal"|"high" }
- "checkpoint" — subagent reports its current state. payload: { summary: string, todos: Array<{content, status}>, blockers?: string[] }
- "plan" — orchestrator hands a subagent its initial plan at spawn time. payload: { title: string, steps: Array<{content, status}>, exitCriteria: string }
- "kill" — orchestrator terminates a subagent gracefully. payload: { reason: string }

Retry contract: if this tool is called again with the same \`idempotencyKey\` (and
\`createdAt\` if it was set on the first call), the server returns the original
\`id\` and \`createdAt\` without creating a duplicate row. If \`idempotencyKey\` is
omitted on the first call, the tool generates a fallback key
\\\`lk_\\\${"$"}{sessionID}_\\\${"$"}{callID}\\\`. For any retry, you MUST echo back both
\`idempotencyKey\` and \`createdAt\` from the first call's response.`,
          input: Input,
          output: Output,
          toModelOutput: ({ output }) => [
            { type: "text", text: `delivered=${output.delivered}, pending=${output.pending}, idempotencyKey=${output.idempotencyKey}` },
          ],
          execute: (input, context) => {
            return Effect.gen(function* () {
              yield* permission.assert({
                action: name,
                resources: [input.kind],
                save: ["*"],
                metadata: input,
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
              })

              // Fallback idempotency key: only for the first call (no key provided).
              // Retries must echo back the key from the first response.
              const idempotencyKey =
                input.idempotencyKey ?? `lk_${context.sessionID}_${context.toolCallID}`

              const result = yield* bus.publishOrFetch({
                id: idempotencyKey,
                parentSessionID: context.sessionID,
                fromSession: context.sessionID,
                fromAgent: context.agent,
                toAgent: input.to,
                kind: input.kind,
                payload: input.payload,
                createdAt: input.createdAt ?? Date.now(),
              })

              const pending = yield* repo.listPending(context.sessionID)

              return {
                delivered: true,
                pending: pending.length,
                idempotencyKey: result.id,
                createdAt: result.createdAt,
              }
            }).pipe(Effect.mapError(() => new ToolFailure({ message: `subagent_message failed` })))
          },
        }),
      })
      .pipe(Effect.orDie)
  }),
)
