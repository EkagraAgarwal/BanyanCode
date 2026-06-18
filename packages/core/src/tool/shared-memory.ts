export * as SharedMemoryTool from "./shared-memory"

import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer, Schema } from "effect"
import { PermissionV2 } from "../permission"
import { Tool } from "./tool"
import { Tools } from "./tools"
import { Banyan } from "../banyancode"
import { NotFoundError, StaleWriteError } from "../banyancode/types"

export const name = "shared_memory"

export const Input = Schema.Struct({
  op: Schema.Literals(["read", "write", "list", "delete"]),
  key: Schema.optional(Schema.String),
  id: Schema.optional(Schema.String),
  value: Schema.optional(Schema.Unknown),
  tags: Schema.optional(Schema.Array(Schema.String)),
  scope: Schema.optional(Schema.Literals(["global", "session"])),
  sessionID: Schema.optional(Schema.String),
  expectedVersion: Schema.optional(Schema.Number),
  agentID: Schema.optional(Schema.String),
})

export const Output = Schema.Struct({
  ok: Schema.Boolean,
  entries: Schema.Array(Schema.Unknown),
  error: Schema.optional(Schema.String),
  staleWrite: Schema.optional(Schema.Struct({
    expectedVersion: Schema.Number,
    currentVersion: Schema.Number,
  })),
  version: Schema.optional(Schema.Number),
  updatedAt: Schema.optional(Schema.Number),
  deleted: Schema.optional(Schema.Number),
})

const banyancodeEnabled = () => process.env.BANYANCODE_ENABLE !== "0"

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    if (!banyancodeEnabled()) return

    const tools = yield* Tools.Service
    const permission = yield* PermissionV2.Service
    const memoryRepo = yield* Banyan.MemoryRepo

    yield* tools
      .register({
        [name]: Tool.make({
          description: "Read, write, list, or delete entries in shared memory accessible across subagents.",
          input: Input,
          output: Output,
          toModelOutput: ({ output }) => [{ type: "text", text: JSON.stringify(output) }],
          execute: (input, context) => {
            return Effect.gen(function* () {
              const effectiveAgentID = input.agentID ?? context.agent
              const effectiveScope = input.scope ?? "session"
              const effectiveSessionID = input.sessionID ?? context.sessionID
              const effectiveKey = input.key ?? ""
              const effectiveID = input.id ?? effectiveKey

              yield* permission.assert({
                action: name,
                resources: [effectiveKey],
                save: ["*"],
                metadata: input,
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
              })

              if (input.op === "write" && !input.key) {
                return { ok: false, entries: [] as unknown[], error: "write requires key" }
              }
              if (input.op === "delete" && !input.key) {
                return { ok: false, entries: [] as unknown[], error: "delete requires key" }
              }
              if ((input.op === "read" || input.op === "write") && !input.id && !input.key) {
                return { ok: false, entries: [] as unknown[], error: "read/write requires id or key" }
              }

              switch (input.op) {
                case "write": {
                  if (input.expectedVersion !== undefined) {
                    // Use conditional update - first check if row exists and version matches
                    const existing = yield* memoryRepo.get(effectiveID)

                    if (!existing) {
                      // Row doesn't exist, fall back to put
                      yield* memoryRepo.put({
                        id: effectiveID,
                        key: effectiveKey,
                        value: input.value ?? null,
                        tags: input.tags ? [...input.tags] : [],
                        scope: effectiveScope,
                        sessionID: effectiveSessionID,
                        agentID: effectiveAgentID,
                      })
                      const created = yield* memoryRepo.get(effectiveID)
                      return {
                        ok: true,
                        entries: [] as unknown[],
                        version: created?.version,
                        updatedAt: created?.updatedAt,
                      }
                    }

                    if (existing.version !== input.expectedVersion) {
                      return {
                        ok: false,
                        entries: [] as unknown[],
                        error: "stale_write",
                        staleWrite: {
                          expectedVersion: input.expectedVersion,
                          currentVersion: existing.version,
                        },
                      }
                    }

                    // Versions match, perform update
                    const updated = yield* memoryRepo.update({
                      id: effectiveID,
                      expectedVersion: input.expectedVersion,
                      value: input.value,
                      agentID: effectiveAgentID,
                      tags: input.tags ? [...input.tags] : undefined,
                    })

                    return {
                      ok: true,
                      entries: [] as unknown[],
                      version: updated.version,
                      updatedAt: updated.updatedAt,
                    }
                  }

                  // Regular put
                  yield* memoryRepo.put({
                    id: effectiveID,
                    key: effectiveKey,
                    value: input.value ?? null,
                    tags: input.tags ? [...input.tags] : [],
                    scope: effectiveScope,
                    sessionID: effectiveSessionID,
                    agentID: effectiveAgentID,
                  })
                  const created = yield* memoryRepo.get(effectiveID)
                  return {
                    ok: true,
                    entries: [] as unknown[],
                    version: created?.version,
                    updatedAt: created?.updatedAt,
                  }
                }
                case "read": {
                  const entry = yield* memoryRepo.get(effectiveID)
                  if (!entry) {
                    return { ok: false, entries: [] as unknown[] }
                  }
                  return {
                    ok: true,
                    entries: [{
                      id: entry.id,
                      key: entry.key,
                      value: entry.value,
                      context: entry.context,
                      tags: [...entry.tags],
                      version: entry.version,
                      updatedAt: entry.updatedAt,
                      namespace: entry.namespace,
                      agentID: entry.agentID,
                    }],
                  }
                }
                case "list": {
                  const entries = yield* memoryRepo.list(effectiveScope, effectiveSessionID)
                  return {
                    ok: true,
                    entries: entries.map((e) => ({
                      id: e.id,
                      key: e.key,
                      value: e.value,
                      context: e.context,
                      tags: [...e.tags],
                      version: e.version,
                      updatedAt: e.updatedAt,
                      agentID: e.agentID,
                      namespace: e.namespace,
                    })),
                  }
                }
                case "delete": {
                  const existed = yield* memoryRepo.forgetByKey({
                    key: effectiveKey,
                    scope: effectiveScope,
                    sessionID: effectiveSessionID,
                  })
                  return {
                    ok: true,
                    entries: [] as unknown[],
                    deleted: existed,
                  }
                }
              }
            }).pipe(Effect.mapError(() => new ToolFailure({ message: `shared_memory failed for ${input.op}` })))
          },
        }),
      })
      .pipe(Effect.orDie)
  }),
)