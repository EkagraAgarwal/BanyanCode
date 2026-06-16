export * as SharedMemoryTool from "./shared-memory"

import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer, Schema } from "effect"
import { Banyan } from "../banyancode"
import { PermissionV2 } from "../permission"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "shared_memory"

export const Input = Schema.Struct({
  op: Schema.Literals(["read", "write", "list", "delete"]),
  key: Schema.String,
  value: Schema.optional(Schema.Unknown),
  tags: Schema.optional(Schema.Array(Schema.String)),
  parentSessionID: Schema.String.pipe(Schema.optional),
})

export const Output = Schema.Struct({
  ok: Schema.Boolean,
  entries: Schema.Array(Schema.Unknown),
})

const banyancodeEnabled = () => process.env.BANYANCODE_ENABLE === "1"

export const locationLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    if (!banyancodeEnabled()) return

    const tools = yield* Tools.Service
    const permission = yield* PermissionV2.Service
    const repo = yield* Banyan.MemoryRepo

    yield* tools
      .register({
        [name]: Tool.make({
          description: "Read, write, list, or delete entries in shared memory accessible across subagents.",
          input: Input,
          output: Output,
          toModelOutput: ({ output }) => [{ type: "text", text: JSON.stringify(output) }],
          execute: (input, context) => {
            return Effect.gen(function* () {
              const parentSessionID = input.parentSessionID ?? context.sessionID

              yield* permission.assert({
                action: name,
                resources: [parentSessionID],
                save: ["*"],
                metadata: input,
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool" as const, messageID: context.assistantMessageID, callID: context.toolCallID },
              })

              const compositeKey = `${parentSessionID}:${input.key}`

              switch (input.op) {
                case "write": {
                  // Use composite key as id so concurrent writes to the same key trigger onConflictDoUpdate
                  yield* repo.put({
                    id: compositeKey,
                    key: input.key,
                    value: input.value ?? null,
                    tags: [...(input.tags ?? [])],
                    scope: "session",
                    sessionID: parentSessionID,
                    createdAt: Date.now(),
                  })
                  return { ok: true, entries: [] }
                }
                case "read": {
                  const entries = yield* repo.list("session", parentSessionID)
                  const entry = entries.find((e) => e.key === input.key)
                  return { ok: entry !== undefined, entries: entry ? [entry] : [] }
                }
                case "list": {
                  const entries = yield* repo.list("session", parentSessionID)
                  const filtered = input.tags
                    ? entries.filter((e) => input.tags!.some((t) => e.tags.includes(t)))
                    : entries
                  const mapped = filtered.map((e) => ({
                    key: e.key,
                    value: e.value,
                    tags: e.tags,
                  }))
                  return { ok: true, entries: mapped }
                }
                case "delete": {
                  const entries = yield* repo.list("session", parentSessionID)
                  const entry = entries.find((e) => e.key === input.key)
                  if (!entry) return { ok: false, entries: [] }
                  yield* repo.forget(entry.id)
                  return { ok: true, entries: [] }
                }
              }
            }).pipe(Effect.mapError(() => new ToolFailure({ message: `shared_memory failed for ${input.op}` })))
          },
        }),
      })
      .pipe(Effect.orDie)
  }),
)