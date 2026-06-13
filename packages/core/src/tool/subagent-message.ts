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
  kind: Schema.Literals(["request", "inform", "answer", "poll"]),
  payload: Schema.Unknown,
})

export const Output = Schema.Struct({
  delivered: Schema.Boolean,
  pending: Schema.Number,
})

const banyancodeEnabled = () => process.env.BANYANCODE_ENABLE === "1"

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
            "Send a message to a subagent or broadcast to all subagents in the mesh. Fire-and-persist semantics — no acknowledgement required.",
          input: Input,
          output: Output,
          toModelOutput: ({ output }) => [
            { type: "text", text: `delivered=${output.delivered}, pending=${output.pending}` },
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

              const message = {
                id: crypto.randomUUID(),
                parentSessionID: context.sessionID,
                fromSession: context.sessionID,
                fromAgent: context.agent,
                toAgent: input.to,
                kind: input.kind,
                payload: input.payload,
                createdAt: Date.now(),
              }

              yield* bus.publish(message)
              const pending = yield* repo.listPending(context.sessionID)

              return { delivered: true, pending: pending.length }
            }).pipe(Effect.mapError(() => new ToolFailure({ message: `subagent_message failed` })))
          },
        }),
      })
      .pipe(Effect.orDie)
  }),
)
