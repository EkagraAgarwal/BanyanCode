export * as MemoryTools from "./memory"

import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer, Schema } from "effect"
import { Banyan } from "../banyancode"
import { PermissionV2 } from "../permission"
import { Tool } from "./tool"
import { Tools } from "./tools"
import { Hash } from "../util/hash"
import { stableStringify } from "../util/encode"

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

/**
 * Agents allowed to write canonical global memory. Subagents (anything not in
 * this list) must use `memory_candidate_emit` for durable facts and only write
 * directly to `session` scope.
 */
const GLOBAL_WRITE_ALLOWLIST = new Set<string>(["build", "orchestrator"])

const guardGlobalWrite = (scope: "global" | "session", agent: string): string | null => {
  if (scope !== "global") return null
  if (GLOBAL_WRITE_ALLOWLIST.has(agent)) return null
  return `agent "${agent || "<unknown>"}" may not write scope=global memory. Use memory_candidate_emit for durable facts; only the build / orchestrator agent may write canonical global memory.`
}

/**
 * Resolve the effective scope + sessionID for a memory tool call.
 *
 * Subagents (sessions whose `parent_id` chain resolves to a DIFFERENT root
 * session) default to `scope="session"` under the ROOT parent session id, so
 * their writes are visible to the build/orchestrator that spawned them.
 * Callers whose session IS the root keep today's behavior exactly
 * (memory_store defaults to `scope="global"`). An explicit input.scope or
 * input.sessionID always wins.
 */
const resolveScopeAndSession = (
  inputScope: "global" | "session" | undefined,
  inputSessionID: string | undefined,
  contextSessionID: string,
  rootSessionID: string,
): { scope: "global" | "session"; sessionID: string } => {
  const isSubagent = rootSessionID !== contextSessionID
  return {
    scope: (inputScope ?? (isSubagent ? "session" : "global")) as "global" | "session",
    sessionID: inputSessionID ?? (isSubagent ? rootSessionID : contextSessionID),
  }
}

/**
 * Deterministic id for memory_store: an LLM retry of the same write (same
 * scope / session / key / content) must upsert the SAME row. Re-storing the
 * same key with different content produces a different hash → a new row,
 * which preserves the "recall picks latest" semantics.
 */
export const deriveMemoryStoreId = (
  scope: "global" | "session",
  sessionID: string | undefined,
  key: string,
  value: unknown,
): string => {
  const sid = sessionID ?? "global"
  return `mem:${Hash.fast(`${scope}|${sid}|${key}|${stableStringify(value)}`)}`
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

    yield* tools
      .register({
        [name_store]: Tool.make({
          description:
            "Store a memory entry with key-value pair, optional context, tags, scope, and TTL. scope=global is only allowed for build / orchestrator; other agents should use memory_candidate_emit for durable facts. Subagent calls default to scope=session under the root parent session so the orchestrator can read them.",
input: InputStore,
           contract: { visibility: "public" },
          output: OutputStore,
          toModelOutput: ({ output }) => [
            { type: "text", text: `stored id=${output.id} createdAt=${output.createdAt}` },
          ],
          execute: (input, context) => {
            return Effect.gen(function* () {
              yield* permission.assert({
                action: name_store,
                resources: [input.key],
                save: ["*"],
                metadata: input,
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
              })

              const rootSessionID = yield* repo.resolveRootSessionID(context.sessionID)
              const { scope, sessionID } = resolveScopeAndSession(
                input.scope,
                input.sessionID,
                context.sessionID,
                rootSessionID,
              )

              const guard = guardGlobalWrite(scope, context.agent)
              if (guard) {
                return yield* new MemoryQuotaError({ message: guard })
              }

              const valueSize = Buffer.byteLength(JSON.stringify(input.value), "utf8")
              if (valueSize > MAX_VALUE_SIZE_BYTES) {
                return yield* new MemoryQuotaError({
                  message: `Value size ${valueSize} exceeds limit ${MAX_VALUE_SIZE_BYTES}`,
                })
              }

              const existing = yield* repo.list(scope, sessionID)
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

              const id = deriveMemoryStoreId(scope, sessionID, input.key, input.value)
              const now = Date.now()

              yield* repo.put({
                id,
                key: input.key,
                value: input.value,
                context: input.context,
                tags: [...(input.tags ?? [])],
                scope,
                sessionID,
                agentID: context.agent,
                createdAt: now,
                expiresAt: input.ttlSeconds ? now + input.ttlSeconds * 1000 : undefined,
              })

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
          description:
            "Recall a memory entry by key. Use at the start of a task to retrieve facts stored in previous sessions before re-investigating. Returns the most recent entry when multiple exist with the same key; returns null when nothing matches. Subagent calls default to session scope under the root parent session.",
          input: InputRecall,
           contract: { visibility: "public" },
          output: OutputRecall,
          toModelOutput: ({ output }) => [
            { type: "text", text: JSON.stringify(output.entry) },
          ],
          execute: (input, context) => {
            return Effect.gen(function* () {
              yield* permission.assert({
                action: name_recall,
                resources: [input.key],
                save: ["*"],
                metadata: input,
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
              })

              const rootSessionID = yield* repo.resolveRootSessionID(context.sessionID)
              const { scope, sessionID } = resolveScopeAndSession(
                input.scope,
                input.sessionID,
                context.sessionID,
                rootSessionID,
              )
              const results = yield* repo.search(scope, sessionID, input.key)

              if (results.length === 0 && input.scope === undefined) {
                // Cross-caller fallback: a subagent's memory_store defaults to
                // session scope under the ROOT session id, but a root lead's
                // unscoped recall defaults to global — without this, the lead
                // silently misses the subagent's write. Same primitive
                // shared_memory uses (tool/shared-memory.ts:73-78). An
                // explicit input.scope always wins (no fallback).
                const sessionFallback = yield* repo.getLatestSessionScoped(input.key)
                if (sessionFallback) {
                  return { entry: sessionFallback.value }
                }
                return { entry: null }
              }

              const latest = results.sort((a, b) => b.createdAt - a.createdAt)[0]
              return { entry: latest.value }
            }).pipe(Effect.mapError(() => new ToolFailure({ message: `memory_recall failed` })))
          },
        }),
        [name_list]: Tool.make({
          description:
            "List memory entries with optional prefix filter, tag filter, scope, and sessionID. Use to survey what has been stored — for example, to enumerate prior findings before synthesizing a result. Subagent calls default to session scope under the root parent session.",
          input: InputList,
           contract: { visibility: "public" },
          output: OutputList,
          toModelOutput: ({ output }) => [
            { type: "text", text: `found ${output.entries.length} entries` },
          ],
          execute: (input, context) => {
            return Effect.gen(function* () {
              yield* permission.assert({
                action: name_list,
                resources: ["*"],
                save: ["*"],
                metadata: input,
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
              })

              const rootSessionID = yield* repo.resolveRootSessionID(context.sessionID)
              const { scope, sessionID } = resolveScopeAndSession(
                input.scope,
                input.sessionID,
                context.sessionID,
                rootSessionID,
              )
              let entries = yield* repo.list(scope, sessionID)

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
          description:
            "Delete a memory entry by key. Use when stored memory is wrong, stale, or no longer wanted — for example after a user correction. Deletes the most recent entry when multiple share the key. Subagent calls default to session scope under the root parent session.",
          input: InputForget,
           contract: { visibility: "public" },
          output: OutputForget,
          toModelOutput: ({ output }) => [
            { type: "text", text: output.ok ? "deleted" : "not found" },
          ],
          execute: (input, context) => {
            return Effect.gen(function* () {
              yield* permission.assert({
                action: name_forget,
                resources: [input.key],
                save: ["*"],
                metadata: input,
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
              })

              const rootSessionID = yield* repo.resolveRootSessionID(context.sessionID)
              const { scope, sessionID } = resolveScopeAndSession(
                input.scope,
                input.sessionID,
                context.sessionID,
                rootSessionID,
              )
              const results = yield* repo.search(scope, sessionID, input.key)

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
            "Search memory entries using BM25-ranked FTS5 across keys, titles, bodies, and kinds.",
          input: InputSearch,
           contract: { visibility: "public" },
          output: OutputSearch,
          toModelOutput: ({ output }) => [
            { type: "text", text: `found ${output.entries.length} entries` },
          ],
          execute: (input, context) => {
            return Effect.gen(function* () {
              yield* permission.assert({
                action: name_search,
                resources: [input.query],
                save: ["*"],
                metadata: input,
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
              })

              const rootSessionID = yield* repo.resolveRootSessionID(context.sessionID)
              const { scope, sessionID } = resolveScopeAndSession(
                input.scope,
                input.sessionID,
                context.sessionID,
                rootSessionID,
              )
              const ranked = yield* repo.searchRanked({
                query: input.query,
                limit: input.limit ?? 10,
                scope,
                sessionID,
              })
              return { entries: ranked.entries, degraded: false }
            }).pipe(Effect.mapError(() => new ToolFailure({ message: `memory_search failed` })))
          },
        }),
      })
      .pipe(Effect.orDie)
  }),
)