export * as MeshSubscribeTool from "./mesh-subscribe"

import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer, Schema, Stream } from "effect"
import { MeshCoordinator } from "../banyancode/mesh-coordinator"
import { PermissionV2 } from "../permission"
import { Tool } from "./tool"
import { Tools } from "./tools"

const banyancodeEnabled = () => process.env.BANYANCODE_ENABLE !== "0"

export const name = "mesh_subscribe"

const SubagentMessageSchema = Schema.Struct({
  id: Schema.String,
  parentSessionID: Schema.String,
  fromSession: Schema.String,
  fromAgent: Schema.String,
  toSession: Schema.optional(Schema.String),
  toAgent: Schema.optional(Schema.String),
  kind: Schema.Literals(["request", "inform", "answer", "poll", "steer", "checkpoint", "plan", "kill"]),
  payload: Schema.Unknown,
  deliveredAt: Schema.optional(Schema.Number),
  createdAt: Schema.Number,
})

export const Input = Schema.Struct({
  parentSessionID: Schema.String,
  agentName: Schema.optional(Schema.String),
  maxMessages: Schema.optional(Schema.Number),
})

export const Output = Schema.Struct({
  messages: Schema.Array(SubagentMessageSchema),
  streamActive: Schema.Boolean,
})

export const locationLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    if (!banyancodeEnabled()) return
    const tools = yield* Tools.Service
    const permission = yield* PermissionV2.Service
    const coordinator = yield* MeshCoordinator.Service

    yield* tools.register({
      [name]: Tool.make({
        description:
          "Subscribe to peer subagent activity for this parent session. " +
          "Returns the first N messages as an initial batch; the stream " +
          "remains active for the session lifetime. Use this in place of " +
          "polling mesh_control.status to wait for specific subagent results.",
        input: Input,
        output: Output,
        toModelOutput: ({ output }) => [
          { type: "text", text: `messages=${output.messages.length} streamActive=${output.streamActive}` },
        ],
        execute: (input, context) => {
          return Effect.gen(function* () {
            yield* permission.assert({
              action: name,
              resources: [input.parentSessionID],
              save: ["*"],
              metadata: input,
              sessionID: context.sessionID,
              agent: context.agent,
              source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
            })
            const stream = yield* coordinator.subscribe({
              parentSessionID: input.parentSessionID as any,
              agentName: input.agentName,
            })
            const maxMessages = input.maxMessages ?? 10
            const messages = yield* stream.pipe(Stream.take(maxMessages), Stream.runCollect)
            return { messages: [...messages], streamActive: true }
          }).pipe(
            Effect.mapError((e) =>
              e instanceof ToolFailure
                ? e
                : new ToolFailure({ message: `mesh_subscribe failed` }),
            ),
          )
        },
      }),
    })
  }),
)
