import type { Context } from "@opencode/plugin/effect/plugin"
import { Tool } from "@opencode/schema/tool"
import { Effect, Schema, Semaphore } from "effect"
import type { SessionPort } from "./session-port.js"
import { GLOBAL_NOTE_AGENTS } from "./types.js"

/**
 * `shared_memory` parity without the dropped memory feature: the plugin's own
 * KV store is the backing store, namespaced by project and by the root
 * orchestration session. Writes from a subagent land on the root session, so
 * the lead and every peer read the same notes (v1's session-scope inheritance).
 * Retries are idempotent: writing the same id/key upserts a version bump.
 */
export const SHARED_MEMORY_TOOL = "shared_memory"

const OP_LITERALS = ["read", "write", "list", "delete"] as const

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export const Input = Schema.Struct({
  op: Schema.optional(Schema.Literals(OP_LITERALS)),
  key: Schema.optional(Schema.String),
  id: Schema.optional(Schema.String),
  payload: Schema.optional(Schema.Unknown),
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
  staleWrite: Schema.optional(
    Schema.Struct({
      expectedVersion: Schema.Number,
      currentVersion: Schema.Number,
    }),
  ),
  version: Schema.optional(Schema.Number),
  updatedAt: Schema.optional(Schema.Number),
  deleted: Schema.optional(Schema.Number),
})

/** Recover the "LLM stuffed the whole invocation into payload" failure mode. */
export const normalizeSharedMemoryInput = (input: typeof Input.Type): typeof Input.Type => {
  if (input.op) return input
  const stuffed = input.value ?? input.payload
  if (!isRecord(stuffed) || typeof stuffed.op !== "string") return input
  if (!OP_LITERALS.includes(stuffed.op as never)) return input
  return {
    op: stuffed.op as (typeof OP_LITERALS)[number],
    key: typeof stuffed.key === "string" ? stuffed.key : input.key,
    id: typeof stuffed.id === "string" ? stuffed.id : input.id,
    payload: "payload" in stuffed ? stuffed.payload : undefined,
    value: "value" in stuffed ? stuffed.value : input.value,
    tags: Array.isArray(stuffed.tags) ? (stuffed.tags as string[]) : input.tags,
    scope: stuffed.scope === "global" || stuffed.scope === "session" ? stuffed.scope : input.scope,
    sessionID: typeof stuffed.sessionID === "string" ? stuffed.sessionID : input.sessionID,
    expectedVersion: typeof stuffed.expectedVersion === "number" ? stuffed.expectedVersion : input.expectedVersion,
    agentID: typeof stuffed.agentID === "string" ? stuffed.agentID : input.agentID,
  }
}

interface SharedNote {
  readonly id: string
  readonly key: string
  readonly value: unknown
  readonly context?: string
  readonly tags: readonly string[]
  readonly version: number
  readonly updatedAt: number
  readonly agentID?: string
  readonly namespace?: string
}

const notePrefix = (projectID: string, scope: "global" | "session", owner: string) =>
  `banyancode:shared-memory:${projectID}:${scope}:${owner}:`

const isNote = (value: unknown): value is SharedNote =>
  isRecord(value) &&
  typeof value.id === "string" &&
  typeof value.key === "string" &&
  typeof value.version === "number" &&
  typeof value.updatedAt === "number" &&
  Array.isArray(value.tags)

const readNotes = (ctx: Context, prefix: string) =>
  Effect.gen(function* () {
    const result = yield* ctx.storage.scan({ prefix, limit: 1000 })
    return result.entries.flatMap((entry) => (isNote(entry.value) ? [entry.value] : []))
  })

export const makeSharedMemoryTool = (deps: {
  readonly ctx: Context
  readonly sessions: SessionPort
  readonly projectID: string
}): Tool.Info<typeof Input, typeof Output> => {
  const writeLock = Semaphore.makeUnsafe(1)
  const rootOf = (sessionID: string) =>
    Effect.gen(function* () {
      const start = yield* deps.sessions.get(sessionID)
      if (start === undefined) return sessionID
      let current: { readonly sessionID: string; readonly parentID?: string } = start
      const seen = new Set<string>()
      while (current.parentID !== undefined) {
        if (seen.has(current.sessionID)) break
        seen.add(current.sessionID)
        const parent = yield* deps.sessions.get(current.parentID)
        if (parent === undefined) break
        current = parent
      }
      return current.sessionID
    })

  return {
    name: SHARED_MEMORY_TOOL,
    description:
      "Read, write, list, or delete entries in shared memory — the key-value store shared across subagents and the lead agent. Use to exchange findings between agents instead of re-searching: write results under a namespaced key (e.g. 'research:topic:name') and let peers read that key rather than duplicating the work. Writes are session-scoped and inherited to the root (lead) session, so a subagent's write is immediately visible to the lead and to peers. Retries are idempotent: re-writing the same key with the same value updates the entry instead of duplicating it.\n\nCALL SHAPE: pass op, key, tags, scope, and payload as TOP-LEVEL parameters. op is REQUIRED: 'read' | 'write' | 'list' | 'delete'. The value to store on write goes in the payload parameter. Do NOT nest the call inside the payload/value parameter — a call like shared_memory(value={op: 'write', key: ...}) is auto-recovered but is an error pattern.",
    input: Input,
    output: Output,
    options: { permission: SHARED_MEMORY_TOOL },
    execute: (input, context) =>
      Effect.gen(function* () {
        const normalized = normalizeSharedMemoryInput(input)
        if (!normalized.op) {
          return {
            output: {
              ok: false,
              entries: [] as unknown[],
              error:
                "op is required — pass op, key, and payload as TOP-LEVEL parameters. Example: shared_memory(op='write', key='research:topic', payload={...}). Do not nest the call inside the value/payload parameter.",
            },
            content: "op is required",
          }
        }
        const effectivePayload = normalized.payload !== undefined ? normalized.payload : normalized.value
        const effectiveAgentID = normalized.agentID ?? context.agent
        const effectiveScope = normalized.scope ?? "session"
        const effectiveSessionID =
          normalized.sessionID ?? (yield* rootOf(context.sessionID))
        const effectiveKey = normalized.key ?? ""
        const effectiveID = normalized.id ?? effectiveKey

        yield* deps.ctx.permission.assert({
          action: SHARED_MEMORY_TOOL,
          resources: [effectiveKey],
          save: ["*"],
          metadata: normalized,
          sessionID: context.sessionID,
          agent: context.agent,
          source: { type: "tool", messageID: context.messageID, id: context.id },
        })

        if (normalized.op === "write" && effectiveKey.length === 0) {
          return { output: { ok: false, entries: [] as unknown[], error: "write requires key" }, content: "write requires key" }
        }
        if (normalized.op === "delete" && effectiveKey.length === 0) {
          return {
            output: { ok: false, entries: [] as unknown[], error: "delete requires key" },
            content: "delete requires key",
          }
        }
        if (normalized.op === "write" && effectiveScope === "global" && !GLOBAL_NOTE_AGENTS.has(context.agent)) {
          const error = `agent "${context.agent || "<unknown>"}" may not write scope=global memory via shared_memory. Use memory_candidate_emit for durable facts; only the build / orchestrator agent may write canonical global memory.`
          return { output: { ok: false, entries: [] as unknown[], error }, content: error }
        }

        const owner = effectiveScope === "global" ? "global" : effectiveSessionID
        const prefix = notePrefix(deps.projectID, effectiveScope, owner)
        const keyFor = (id: string) => `${prefix}${id}`

        const readAll = () => readNotes(deps.ctx, prefix)
        const readOne = (id: string) =>
          deps.ctx.storage.get(keyFor(id)).pipe(Effect.map((value) => (isNote(value) ? value : undefined)))
        const writeNote = (note: SharedNote) =>
          deps.ctx.storage.set(keyFor(note.id), note as never).pipe(Effect.asVoid)

        if (normalized.op === "write") {
          return yield* writeLock.withPermit(
            Effect.gen(function* () {
              const current = yield* readOne(effectiveID)
              if (normalized.expectedVersion !== undefined) {
                if (current !== undefined && current.version !== normalized.expectedVersion) {
                  return {
                    output: {
                      ok: false,
                      entries: [] as unknown[],
                      error: "stale_write",
                      staleWrite: {
                        expectedVersion: normalized.expectedVersion,
                        currentVersion: current.version,
                      },
                    },
                    content: "stale_write",
                  }
                }
              }
              const now = Date.now()
              const note: SharedNote = {
                id: effectiveID,
                key: effectiveKey,
                value: effectivePayload ?? null,
                ...(current?.context === undefined ? {} : { context: current.context }),
                tags: normalized.tags === undefined ? (current?.tags ?? []) : [...normalized.tags],
                version: (current?.version ?? 0) + 1,
                updatedAt: now,
                ...(effectiveAgentID === undefined ? {} : { agentID: effectiveAgentID }),
                ...(current?.namespace === undefined ? {} : { namespace: current.namespace }),
              }
              yield* writeNote(note)
              return {
                output: { ok: true, entries: [] as unknown[], version: note.version, updatedAt: note.updatedAt },
                content: `shared_memory write ${note.key} v${note.version}`,
              }
            }),
          )
        }

        if (normalized.op === "read") {
          const exact = yield* readOne(effectiveID)
          const entry =
            exact ??
            (normalized.id === undefined && effectiveKey.length > 0
              ? (yield* readAll()).filter((note) => note.key === effectiveKey).sort((a, b) => b.updatedAt - a.updatedAt)[0]
              : undefined)
          return entry === undefined
            ? { output: { ok: false, entries: [] as unknown[] }, content: "no entry" }
            : { output: { ok: true, entries: [entry] }, content: JSON.stringify(entry) }
        }

        if (normalized.op === "list") {
          const entries = yield* readAll()
          return {
            output: { ok: true, entries: [...entries].sort((a, b) => a.updatedAt - b.updatedAt) },
            content: `shared_memory ${entries.length} entries`,
          }
        }

        return yield* writeLock.withPermit(
          Effect.gen(function* () {
            const matches = (yield* readAll()).filter((note) => note.key === effectiveKey)
            yield* Effect.forEach(matches, (note) => deps.ctx.storage.remove(keyFor(note.id)), { discard: true })
            return {
              output: { ok: true, entries: [] as unknown[], deleted: matches.length },
              content: `shared_memory deleted ${matches.length}`,
            }
          }),
        )
      }).pipe(
        Effect.mapError((error) =>
          error instanceof Tool.Error
            ? error
            : new Tool.Error({
                message: `shared_memory failed for ${input.op ?? "unknown"}`,
                error,
              }),
        ),
      ),
  }
}
