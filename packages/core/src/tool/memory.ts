export * as MemoryTools from "./memory"

import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer, Schema } from "effect"
import { Banyan } from "../banyancode"
import { PermissionV2 } from "../permission"
import { Tool } from "./tool"
import { Tools } from "./tools"

const MAX_ENTRIES_PER_SCOPE = 10000
const MAX_VALUE_SIZE_BYTES = 64 * 1024
const MAX_TOTAL_STORAGE_BYTES = 100 * 1024 * 1024

export const name_store = "memory_store"
export const name_recall = "memory_recall"
export const name_list = "memory_list"
export const name_forget = "memory_forget"
export const name_search = "memory_search"

export const InputStore = Schema.Struct({
  key: Schema.String,
  value: Schema.Unknown,
  context: Schema.optional(Schema.String),
  tags: Schema.optional(Schema.Array(Schema.String)),
  scope: Schema.optional(Schema.Literals(["global", "session"])),
  sessionID: Schema.optional(Schema.String),
  ttlSeconds: Schema.optional(Schema.Number),
})

export const InputRecall = Schema.Struct({
  key: Schema.String,
  scope: Schema.optional(Schema.Literals(["global", "session"])),
  sessionID: Schema.optional(Schema.String),
})

export const InputList = Schema.Struct({
  prefix: Schema.optional(Schema.String),
  tags: Schema.optional(Schema.Array(Schema.String)),
  scope: Schema.optional(Schema.Literals(["global", "session"])),
  sessionID: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.Number),
})

export const InputForget = Schema.Struct({
  key: Schema.String,
  scope: Schema.optional(Schema.Literals(["global", "session"])),
  sessionID: Schema.optional(Schema.String),
})

export const InputSearch = Schema.Struct({
  query: Schema.String,
  limit: Schema.optional(Schema.Number),
  scope: Schema.optional(Schema.Literals(["global", "session"])),
  sessionID: Schema.optional(Schema.String),
})

export const OutputStore = Schema.Struct({
  id: Schema.String,
  createdAt: Schema.Number,
})

export const OutputRecall = Schema.Struct({
  entry: Schema.NullOr(Schema.Unknown),
})

export const OutputList = Schema.Struct({
  entries: Schema.Array(Schema.Unknown),
})

export const OutputForget = Schema.Struct({
  ok: Schema.Boolean,
})

export const OutputSearch = Schema.Struct({
  entries: Schema.Array(Schema.Unknown),
  degraded: Schema.Boolean,
})

export class MemoryQuotaError extends Schema.TaggedErrorClass<MemoryQuotaError>()("Banyan/MemoryQuotaError", {
  message: Schema.String,
}) {}

const banyancodeEnabled = () => process.env.BANYANCODE_ENABLE !== "0"

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

function keywordSearch(query: string, entries: Banyan.MemoryEntry[]): Banyan.MemoryEntry[] {
  const lowerQuery = query.toLowerCase()
  return entries
    .filter((e) => {
      const keyMatch = e.key.toLowerCase().includes(lowerQuery)
      const valueStr = JSON.stringify(e.value).toLowerCase()
      const valueMatch = valueStr.includes(lowerQuery)
      const contextMatch = e.context?.toLowerCase().includes(lowerQuery) ?? false
      return keyMatch || valueMatch || contextMatch
    })
    .slice(0, 10)
}

export const locationLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    if (!banyancodeEnabled()) return

    const tools = yield* Tools.Service
    const permission = yield* PermissionV2.Service
    const repo = yield* Banyan.MemoryRepo
    const provider = yield* Banyan.EmbeddingProviderService

    yield* tools
      .register({
        [name_store]: Tool.make({
          description: "Store a memory entry with key-value pair, optional context, tags, scope, and TTL",
          input: InputStore,
          output: OutputStore,
          toModelOutput: ({ output }) => [
            { type: "text", text: `stored id=${output.id} createdAt=${output.createdAt}` },
          ],
          execute: (input) => {
            return Effect.gen(function* () {
              yield* permission.assert({
                action: name_store,
                resources: [input.key],
                save: ["*"],
                metadata: input,
                sessionID: (input.sessionID ?? "") as any,
                agent: "" as any,
                source: { type: "tool", messageID: "" as any, callID: "" },
              } as any)

              const valueSize = Buffer.byteLength(JSON.stringify(input.value), "utf8")
              if (valueSize > MAX_VALUE_SIZE_BYTES) {
                return yield* new MemoryQuotaError({
                  message: `Value size ${valueSize} exceeds limit ${MAX_VALUE_SIZE_BYTES}`,
                })
              }

              const scope = (input.scope ?? "global") as "global" | "session"
              const existing = yield* repo.list(scope, input.sessionID)
              if (existing.length >= MAX_ENTRIES_PER_SCOPE) {
                return yield* new MemoryQuotaError({
                  message: `Scope limit ${MAX_ENTRIES_PER_SCOPE} reached`,
                })
              }

              const allEntries = yield* repo.list("global")
              const totalSize = allEntries.reduce(
                (sum, e) => sum + Buffer.byteLength(JSON.stringify(e.value), "utf8"),
                0,
              )
              if (totalSize > MAX_TOTAL_STORAGE_BYTES) {
                return yield* new MemoryQuotaError({
                  message: `Total storage limit ${MAX_TOTAL_STORAGE_BYTES} reached`,
                })
              }

              const id = crypto.randomUUID()
              const now = Date.now()
              const entry = {
                id,
                key: input.key,
                value: input.value,
                context: input.context,
                tags: [...(input.tags ?? [])],
                scope,
                sessionID: input.sessionID,
                createdAt: now,
                expiresAt: input.ttlSeconds ? now + input.ttlSeconds * 1000 : undefined,
              }

              yield* repo.put(entry)

              return { id, createdAt: now }
            }).pipe(
              Effect.catch((e) =>
                e instanceof MemoryQuotaError
                  ? Effect.fail(new ToolFailure({ message: e.message }))
                  : Effect.fail(new ToolFailure({ message: `memory_store failed` })),
              ),
            )
          },
        }),
        [name_recall]: Tool.make({
          description: "Recall a memory entry by key",
          input: InputRecall,
          output: OutputRecall,
          toModelOutput: ({ output }) => [
            { type: "text", text: JSON.stringify(output.entry) },
          ],
          execute: (input) => {
            return Effect.gen(function* () {
              yield* permission.assert({
                action: name_recall,
                resources: [input.key],
                save: ["*"],
                metadata: input,
                sessionID: (input.sessionID ?? "") as any,
                agent: "" as any,
                source: { type: "tool", messageID: "" as any, callID: "" },
              } as any)

              const scope = (input.scope ?? "global") as "global" | "session"
              const results = yield* repo.search(scope, input.sessionID, input.key)

              if (results.length === 0) {
                return { entry: null }
              }

              const latest = results.sort((a, b) => b.createdAt - a.createdAt)[0]
              return { entry: latest.value }
            }).pipe(Effect.mapError(() => new ToolFailure({ message: `memory_recall failed` })))
          },
        }),
        [name_list]: Tool.make({
          description: "List memory entries with optional prefix filter, tag filter, scope, and sessionID",
          input: InputList,
          output: OutputList,
          toModelOutput: ({ output }) => [
            { type: "text", text: `found ${output.entries.length} entries` },
          ],
          execute: (input) => {
            return Effect.gen(function* () {
              yield* permission.assert({
                action: name_list,
                resources: ["*"],
                save: ["*"],
                metadata: input,
                sessionID: (input.sessionID ?? "") as any,
                agent: "" as any,
                source: { type: "tool", messageID: "" as any, callID: "" },
              } as any)

              const scope = (input.scope ?? "global") as "global" | "session"
              let entries = yield* repo.list(scope, input.sessionID)

              if (input.prefix) {
                entries = entries.filter((e) => e.key.startsWith(input.prefix!))
              }

              if (input.tags && input.tags.length > 0) {
                entries = entries.filter((e) => input.tags!.some((t) => e.tags.includes(t)))
              }

              if (input.limit) {
                entries = entries.slice(0, input.limit)
              }

              return { entries }
            }).pipe(Effect.mapError(() => new ToolFailure({ message: `memory_list failed` })))
          },
        }),
        [name_forget]: Tool.make({
          description: "Delete a memory entry by key",
          input: InputForget,
          output: OutputForget,
          toModelOutput: ({ output }) => [
            { type: "text", text: output.ok ? "deleted" : "not found" },
          ],
          execute: (input) => {
            return Effect.gen(function* () {
              yield* permission.assert({
                action: name_forget,
                resources: [input.key],
                save: ["*"],
                metadata: input,
                sessionID: (input.sessionID ?? "") as any,
                agent: "" as any,
                source: { type: "tool", messageID: "" as any, callID: "" },
              } as any)

              const scope = (input.scope ?? "global") as "global" | "session"
              const results = yield* repo.search(scope, input.sessionID, input.key)

              if (results.length === 0) {
                return { ok: false }
              }

              const latest = results.sort((a, b) => b.createdAt - a.createdAt)[0]
              yield* repo.forget(latest.id)

              return { ok: true }
            }).pipe(Effect.mapError(() => new ToolFailure({ message: `memory_forget failed` })))
          },
        }),
        [name_search]: Tool.make({
          description:
            "Search memory entries using semantic embedding search when available, falling back to keyword search. Returns degraded=true when embeddings are unavailable.",
          input: InputSearch,
          output: OutputSearch,
          toModelOutput: ({ output }) => [
            { type: "text", text: `found ${output.entries.length} entries (degraded=${output.degraded})` },
          ],
          execute: (input) => {
            return Effect.gen(function* () {
              yield* permission.assert({
                action: name_search,
                resources: [input.query],
                save: ["*"],
                metadata: input,
                sessionID: (input.sessionID ?? "") as any,
                agent: "" as any,
                source: { type: "tool", messageID: "" as any, callID: "" },
              } as any)

              const scope = (input.scope ?? "global") as "global" | "session"
              const allEntries = yield* repo.list(scope, input.sessionID)

              const model = yield* provider.model()

              if (model === undefined) {
                const keywordMatches = keywordSearch(input.query, allEntries)
                return { entries: keywordMatches, degraded: true }
              }

              const embedResult = yield* provider
                .embed(input.query)
                .pipe(
                  Effect.mapError(() => null),
                  Effect.catch(() => Effect.succeed(null)),
                )

              if (!embedResult || embedResult.length === 0) {
                return { entries: [], degraded: false }
              }

              const queryEmbedding = embedResult[0]

              const scored = allEntries.map((entry) => {
                const entryEmbedding = (entry as any)._embedding as Float32Array | undefined
                if (!entryEmbedding) return { entry, score: 0 }
                return { entry, score: cosineSimilarity(queryEmbedding, entryEmbedding) }
              })

              const limit = input.limit ?? 10
              const topResults = scored
                .filter((s) => s.score > 0)
                .sort((a, b) => b.score - a.score)
                .slice(0, limit)
                .map((s) => s.entry)

              return { entries: topResults, degraded: false }
            }).pipe(Effect.mapError(() => new ToolFailure({ message: `memory_search failed` })))
          },
        }),
      })
      .pipe(Effect.orDie)
  }),
)