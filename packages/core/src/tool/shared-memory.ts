export * as SharedMemoryTool from "./shared-memory"

import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer, Schema } from "effect"
import { PermissionV2 } from "../permission"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "shared_memory"

export const Input = Schema.Struct({
  op: Schema.Literals(["read", "write", "list", "delete"]),
  key: Schema.String,
  value: Schema.optional(Schema.Unknown),
  tags: Schema.optional(Schema.Array(Schema.String)),
})

export const Output = Schema.Struct({
  ok: Schema.Boolean,
  entries: Schema.Array(Schema.Unknown),
})

const store = new Map<string, { value: unknown; tags: string[] }>()
const banyancodeEnabled = () => process.env.BANYANCODE_ENABLE === "1"

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    if (!banyancodeEnabled()) return

    const tools = yield* Tools.Service
    const permission = yield* PermissionV2.Service

    yield* tools
      .register({
        [name]: Tool.make({
          description: "Read, write, list, or delete entries in shared memory accessible across subagents.",
          input: Input,
          output: Output,
          toModelOutput: ({ output }) => [{ type: "text", text: JSON.stringify(output) }],
          execute: (input, context) => {
            return Effect.gen(function* () {
              yield* permission.assert({
                action: name,
                resources: [input.key],
                save: ["*"],
                metadata: input,
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
              })

              switch (input.op) {
                case "write": {
                  store.set(input.key, { value: input.value ?? null, tags: [...(input.tags ?? [])] })
                  return { ok: true, entries: [] }
                }
                case "read": {
                  const entry = store.get(input.key)
                  return { ok: entry !== undefined, entries: entry ? [entry] : [] }
                }
                case "list": {
                  const entries = input.tags
                    ? Array.from(store.entries())
                        .filter(([, v]) => input.tags!.some((t) => v.tags.includes(t)))
                        .map(([k, v]) => ({ key: k, ...v }))
                    : Array.from(store.entries()).map(([k, v]) => ({ key: k, ...v }))
                  return { ok: true, entries }
                }
                case "delete": {
                  const existed = store.delete(input.key)
                  return { ok: existed, entries: [] }
                }
              }
            }).pipe(Effect.mapError(() => new ToolFailure({ message: `shared_memory failed for ${input.op}` })))
          },
        }),
      })
      .pipe(Effect.orDie)
  }),
)
