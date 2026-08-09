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
            "Read, write, list, or delete entries in shared memory — the key-value store shared across subagents and the lead agent. Use to exchange findings between agents instead of re-searching: write results under a namespaced key (e.g. 'research:topic:name') and let peers read that key rather than duplicating the work. Writes are session-scoped and inherited to the root (lead) session, so a subagent's write is immediately visible to the lead and to peers. Retries are idempotent: re-writing the same key with the same value updates the entry instead of duplicating it.",
          input: Input,
           contract: { visibility: "public" },
          output: Output,
          toModelOutput: ({ output }) => [{ type: "text", text: JSON.stringify(output) }],
          execute: (input, context) => {
            return Effect.gen(function* () {
              const effectiveAgentID = input.agentID ?? context.agent
              const effectiveScope = input.scope ?? "session"
              // Subagent writes land on the ROOT parent session (walked via
              // the `session.parent_id` chain) so the parent can read/list
              // them under its own session id. Explicit input.sessionID wins.
              const effectiveSessionID =
                input.sessionID ?? (yield* memoryRepo.resolveRootSessionID(context.sessionID))
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
              if (input.op === "write") {
                const guard = guardGlobalWrite(effectiveScope, context.agent)
                if (guard) {
                  return { ok: false, entries: [] as unknown[], error: guard }
                }
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
                        expectedVersion: input.expectedVersion,
                        value: input.value,
                        agentID: effectiveAgentID,
                        tags: input.tags ? [...input.tags] : undefined,
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
                              value: input.value ?? null,
                              tags: input.tags ? [...input.tags] : [],
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
                  const exact = yield* memoryRepo.get(effectiveID)
                  // Exact-id lookup misses → fall back to the newest
                  // session-scoped row for this key across ANY session so
                  // orphaned child-session rows from before the scope
                  // inheritance fix remain retrievable. Only when the caller
                  // read by key (an explicit id was already covered by get).
                  const entry =
                    exact ?? (!input.id && effectiveKey ? yield* memoryRepo.getLatestSessionScoped(effectiveKey) : undefined)
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
