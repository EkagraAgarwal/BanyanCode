export * as MemoryCandidateTool from "./memory-candidate"

import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer, Schema } from "effect"
import { Banyan } from "../banyancode"
import { PermissionV2 } from "../permission"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "memory_candidate_emit"

export const Input = Schema.Struct({
  key: Schema.String,
  value: Schema.Unknown,
  context: Schema.optional(Schema.String),
  tags: Schema.optional(Schema.Array(Schema.String)),
  scope: Schema.optional(Schema.Literals(["session", "global"])),
  sessionID: Schema.optional(Schema.String),
})

export const Output = Schema.Struct({
  id: Schema.String,
  status: Schema.Literals(["pending"]),
  version: Schema.Number,
  createdAt: Schema.Number,
})

const banyancodeEnabled = () => process.env.BANYANCODE_ENABLE !== "0"

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    if (!banyancodeEnabled()) return

    const tools = yield* Tools.Service
    const permission = yield* PermissionV2.Service
    const memoryService = yield* Banyan.MemoryService

    yield* tools
      .register({
        [name]: Tool.make({
          description:
            "Emit a candidate memory entry (status: pending). Use this for durable, behavior-changing facts you want the main agent to consider promoting. Read-only operations should use memory_recall/memory_list/memory_search.",
          input: Input,
          output: Output,
          toModelOutput: ({ output }) => [
            { type: "text", text: `candidate emitted id=${output.id} status=${output.status}` },
          ],
          execute: (input, context) =>
            Effect.gen(function* () {
              yield* permission.assert({
                action: name,
                resources: [input.key],
                save: ["*"],
                metadata: input,
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
              })

              const entry = yield* memoryService.emitCandidate({
                key: input.key,
                value: input.value,
                context: input.context,
                tags: input.tags ? [...input.tags] : [],
                scope: input.scope ?? "session",
                sessionID: input.sessionID ?? context.sessionID,
                agentID: context.agent,
              })

              return {
                id: entry.id,
                status: "pending" as const,
                version: entry.version,
                createdAt: entry.createdAt,
              }
            }).pipe(Effect.mapError(() => new ToolFailure({ message: `memory_candidate_emit failed` }))),
        }),
      })
      .pipe(Effect.orDie)
  }),
)
