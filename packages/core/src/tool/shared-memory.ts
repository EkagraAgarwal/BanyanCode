export * as SharedMemoryTool from "./shared-memory"

import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer, Schema } from "effect"
import { PermissionV2 } from "../permission"
import { Tool } from "./tool"
import { Tools } from "./tools"
import { Banyan } from "../banyancode"
import { NotFoundError, StaleWriteError } from "../banyancode/types"

export const name = "shared_memory"

const OP_LITERALS = ["read", "write", "list", "delete"] as const

export const Input = Schema.Struct({
  // `op` is optional at the schema level so stuffed-invocation recovery in
  // execute() can run: LLMs occasionally serialize the WHOLE call into the
  // value/payload parameter (see normalizeSharedMemoryInput). The description
  // still mandates a top-level op, and execute() rejects with a teaching
  // error when op is genuinely absent.
  op: Schema.optional(Schema.Literals(["read", "write", "list", "delete"])),
  key: Schema.optional(Schema.String),
  id: Schema.optional(Schema.String),
  // The value to store on write. `payload` is the canonical name — `value`
  // is a deprecated alias kept so existing callers keep working. A param
  // named `value` invited LLMs to nest the whole invocation inside it.
  payload: Schema.optional(Schema.Unknown),
  value: Schema.optional(Schema.Unknown),
  tags: Schema.optional(Schema.Array(Schema.String)),
  scope: Schema.optional(Schema.Literals(["global", "session"])),
  sessionID: Schema.optional(Schema.String),
  expectedVersion: Schema.optional(Schema.Number),
  agentID: Schema.optional(Schema.String),
})

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null

/**
 * Recover the "stuffed invocation" failure mode: the LLM serializes the
 * entire call into the value/payload parameter —
 *
 *   shared_memory(value: { op: "write", key: "research:x", value: {...} })
 *
 * leaving the top-level `op` (and friends) missing, which the strict decode
 * previously rejected with an opaque "Missing key at 'op'" error. This only
 * unwraps when the top-level `op` is ABSENT and the payload carries a valid
 * `op` literal — a legitimate stored payload that happens to contain an
 * `op` key is untouched whenever the top-level op was provided.
 */
export const normalizeSharedMemoryInput = (
  input: typeof Input.Type,
): typeof Input.Type & { op: NonNullable<typeof Input.Type["op"]> } | typeof Input.Type => {
  if (input.op) return input
  const stuffed = (input.value ?? input.payload) as unknown
  if (!isRecord(stuffed) || typeof stuffed.op !== "string" || !OP_LITERALS.includes(stuffed.op as never)) {
    return input
  }
  const op = stuffed.op as (typeof OP_LITERALS)[number]
  return {
    op,
    key: typeof stuffed.key === "string" ? stuffed.key : input.key,
    id: typeof stuffed.id === "string" ? stuffed.id : input.id,
    payload: "payload" in stuffed ? stuffed.payload : undefined,
    value: "value" in stuffed ? stuffed.value : undefined,
    tags: Array.isArray(stuffed.tags) ? (stuffed.tags as string[]) : input.tags,
    scope: stuffed.scope === "global" || stuffed.scope === "session" ? stuffed.scope : input.scope,
    sessionID: typeof stuffed.sessionID === "string" ? stuffed.sessionID : input.sessionID,
    expectedVersion: typeof stuffed.expectedVersion === "number" ? stuffed.expectedVersion : input.expectedVersion,
    agentID: typeof stuffed.agentID === "string" ? stuffed.agentID : input.agentID,
  }
}

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

/**
 * Agents allowed to write canonical global memory. Subagents (anything not in
 * this list) must write to scope=session only and emit candidates for durable
 * facts via memory_candidate_emit.
 */
const GLOBAL_WRITE_ALLOWLIST = new Set<string>(["build", "orchestrator"])

const guardGlobalWrite = (scope: "global" | "session", agent: string): string | null => {
  if (scope !== "global") return null
  if (GLOBAL_WRITE_ALLOWLIST.has(agent)) return null
  return `agent "${agent || "<unknown>"}" may not write scope=global memory via shared_memory. Use memory_candidate_emit for durable facts; only the build / orchestrator agent may write canonical global memory.`
}

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    if (!banyancodeEnabled()) return

    const tools = yield* Tools.Service
    const permission = yield* PermissionV2.Service
    const memoryRepo = yield* Banyan.MemoryRepo

    yield* tools
      .register({
        [name]: Tool.make({
          description:
            "Read, write, list, or delete entries in shared memory — the key-value store shared across subagents and the lead agent. Use to exchange findings between agents instead of re-searching: write results under a namespaced key (e.g. 'research:topic:name') and let peers read that key rather than duplicating the work. Writes are session-scoped and inherited to the root (lead) session, so a subagent's write is immediately visible to the lead and to peers. Retries are idempotent: re-writing the same key with the same value updates the entry instead of duplicating it.\n\nCALL SHAPE: pass op, key, tags, scope, and payload as TOP-LEVEL parameters. op is REQUIRED: 'read' | 'write' | 'list' | 'delete'. The value to store on write goes in the payload parameter. Do NOT nest the call inside the payload/value parameter — a call like shared_memory(value={op: 'write', key: ...}) is auto-recovered but is an error pattern.",
          input: Input,
           contract: { visibility: "public" },
          output: Output,
          toModelOutput: ({ output }) => [{ type: "text", text: JSON.stringify(output) }],
          execute: (input, context) => {
            return Effect.gen(function* () {
              const normalized = normalizeSharedMemoryInput(input)
              if (!normalized.op) {
                return {
                  ok: false,
                  entries: [] as unknown[],
                  error:
                    "op is required — pass op, key, and payload as TOP-LEVEL parameters. Example: shared_memory(op='write', key='research:topic', payload={...}). Do not nest the call inside the value/payload parameter.",
                }
              }
              const effectivePayload = normalized.payload !== undefined ? normalized.payload : normalized.value
              const effectiveAgentID = normalized.agentID ?? context.agent
              const effectiveScope = normalized.scope ?? "session"
              // Subagent writes land on the ROOT parent session (walked via
              // the `session.parent_id` chain) so the parent can read/list
              // them under its own session id. Explicit input.sessionID wins.
              const effectiveSessionID =
                normalized.sessionID ?? (yield* memoryRepo.resolveRootSessionID(context.sessionID))
              const effectiveKey = normalized.key ?? ""
              const effectiveID = normalized.id ?? effectiveKey

              yield* permission.assert({
                action: name,
                resources: [effectiveKey],
                save: ["*"],
                metadata: normalized,
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
              })

              if (normalized.op === "write" && !normalized.key) {
                return { ok: false, entries: [] as unknown[], error: "write requires key" }
              }
              if (normalized.op === "write") {
                const guard = guardGlobalWrite(effectiveScope, context.agent)
                if (guard) {
                  return { ok: false, entries: [] as unknown[], error: guard }
                }
              }
              if (normalized.op === "delete" && !normalized.key) {
                return { ok: false, entries: [] as unknown[], error: "delete requires key" }
              }
              if ((normalized.op === "read" || normalized.op === "write") && !normalized.id && !normalized.key) {
                return { ok: false, entries: [] as unknown[], error: "read/write requires id or key" }
              }

              switch (normalized.op) {
                case "write": {
                  if (normalized.expectedVersion !== undefined) {
                    // Conditional update: rely on MemoryRepo's atomic CAS
                    // (it wraps the version check + update in a single
                    // db.transaction with `WHERE id=? AND version=?, then
                    // bumps version`). Pre-fix, the tool did a non-atomic
                    // `get` then `update` — the version check passed against
                    // a stale read and a concurrent writer could slip in
                    // between, leading to a lost update (or a typed
                    // StaleWriteError that the tool silently swallowed as a
                    // generic ToolFailure). Now we let the repo be the
                    // authority and translate the typed errors to the
                    // structured `ok: false` response shape the API
                    // contract defines.
                    return yield* memoryRepo
                      .update({
                        id: effectiveID,
                        expectedVersion: normalized.expectedVersion,
                        value: effectivePayload,
                        agentID: effectiveAgentID,
                        tags: normalized.tags ? [...normalized.tags] : undefined,
                      })
                      .pipe(
                        // NotFoundError → row didn't exist; fall through to
                        // put. The put uses onConflictDoUpdate so a
                        // concurrent insert by another writer wins
                        // cleanly. We re-read to surface the canonical
                        // version in the response.
                        Effect.catchTag("NotFoundError", () =>
                          memoryRepo
                            .put({
                              id: effectiveID,
                              key: effectiveKey,
                              value: effectivePayload ?? null,
                              tags: normalized.tags ? [...normalized.tags] : [],
                              scope: effectiveScope,
                              sessionID: effectiveSessionID,
                              agentID: effectiveAgentID,
                            })
                            .pipe(
                              Effect.flatMap(() => memoryRepo.get(effectiveID)),
                              Effect.map((created) => ({
                                ok: true as const,
                                entries: [] as unknown[],
                                version: created?.version,
                                updatedAt: created?.updatedAt,
                              })),
                            ),
                        ),
                        // After catchTag handled NotFoundError, the only
                        // remaining typed failure is StaleWriteError.
                        // matchEffect splits success/failure into a single
                        // response shape so the API contract is uniform.
                        Effect.matchEffect({
                          onFailure: (err) =>
                            Effect.succeed({
                              ok: false as const,
                              entries: [] as unknown[],
                              error: "stale_write",
                              staleWrite: {
                                expectedVersion: err.expectedVersion,
                                currentVersion: err.currentVersion,
                              },
                            }),
                          onSuccess: (updated) =>
                            Effect.succeed({
                              ok: true as const,
                              entries: [] as unknown[],
                              version: updated.version,
                              updatedAt: updated.updatedAt,
                            }),
                        }),
                      )
                  }

                  // Regular put
                  yield* memoryRepo.put({
                    id: effectiveID,
                    key: effectiveKey,
                    value: effectivePayload ?? null,
                    tags: normalized.tags ? [...normalized.tags] : [],
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
                  const exact = yield* memoryRepo.get(effectiveID)
                  // Exact-id lookup misses → fall back to the newest
                  // session-scoped row for this key across ANY session so
                  // orphaned child-session rows from before the scope
                  // inheritance fix remain retrievable. Only when the caller
                  // read by key (an explicit id was already covered by get).
                  const entry =
                    exact ?? (!normalized.id && effectiveKey ? yield* memoryRepo.getLatestSessionScoped(effectiveKey) : undefined)
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
            }).pipe(Effect.mapError(() => new ToolFailure({ message: `shared_memory failed for ${input.op ?? "unknown"}` })))
          },
        }),
      })
      .pipe(Effect.orDie)
  }),
)
