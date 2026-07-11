import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Banyan } from "@opencode-ai/core/banyancode"
import { NotFoundError as MemoryNotFoundError, StaleWriteError } from "@opencode-ai/core/banyancode/types"
import type { MemoryEntry } from "@opencode-ai/core/banyancode/types"
import {
  encodeMemoryValue,
  looksLikeMemoryPayload,
  unwrapMemoryValue,
} from "@opencode-ai/core/banyancode/memory-payload"
import { randomUUID } from "node:crypto"
import { RootHttpApi } from "../api"
import {
  MemoryCandidatesInput,
  MemoryForgetInput,
  MemoryGetInput,
  MemoryListInput,
  MemoryPromoteInput,
  MemoryRecallInput,
  MemoryRejectInput,
  MemorySearchInput,
  MemoryStoreInput,
  MemorySummaryInput,
} from "../groups/memory"
import { InvalidRequestError } from "../errors"

export const memoryHandlers = HttpApiBuilder.group(RootHttpApi, "memory", (handlers) =>
  Effect.gen(function* () {
    const repo = yield* Banyan.MemoryRepo
    const memoryService = yield* Banyan.MemoryService
    const projection = yield* Banyan.MemoryProjection

    const toWire = (entry: MemoryEntry) => ({
      id: entry.id,
      key: entry.key,
      value: entry.value,
      context: entry.context,
      tags: [...entry.tags],
      scope: entry.scope,
      sessionID: entry.sessionID,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      expiresAt: entry.expiresAt,
      agentID: entry.agentID,
      version: entry.version,
      namespace: entry.namespace,
      kind: entry.kind,
      title: entry.title,
      body: entry.body,
      status: entry.status,
    })

    const listHandler = Effect.fn("Memory.list")(function* (ctx: {
      payload: typeof MemoryListInput.Type
    }) {
      const scope = (ctx.payload.scope ?? "global") as "global" | "session"
      const list = yield* repo.list(scope, ctx.payload.sessionID ?? undefined)
      const filtered = list.filter((e) => {
        if (ctx.payload.prefix && !e.key.startsWith(ctx.payload.prefix)) return false
        if (ctx.payload.kind && e.kind !== ctx.payload.kind) return false
        if (ctx.payload.status && e.status !== ctx.payload.status) return false
        return true
      })
      const limit = ctx.payload.limit ?? 200
      return filtered.slice(0, limit).map(toWire)
    })

    const getHandler = Effect.fn("Memory.get")(function* (ctx: { payload: typeof MemoryGetInput.Type }) {
      const entry = yield* repo.get(ctx.payload.id)
      if (!entry) {
        return yield* Effect.fail(
          new InvalidRequestError({ message: `memory entry ${ctx.payload.id} not found` }),
        )
      }
      return toWire(entry)
    })

    const recallHandler = Effect.fn("Memory.recall")(function* (ctx: {
      payload: typeof MemoryRecallInput.Type
    }) {
      const scope = (ctx.payload.scope ?? "global") as "global" | "session"
      const matches = yield* repo.search(scope, ctx.payload.sessionID ?? undefined, ctx.payload.key)
      return matches.map(toWire)
    })

    const searchHandler = Effect.fn("Memory.search")(function* (ctx: {
      payload: typeof MemorySearchInput.Type
    }) {
      const result = yield* repo.searchRanked({
        query: ctx.payload.query,
        limit: ctx.payload.limit ?? 25,
        scope: ctx.payload.scope as "global" | "session" | undefined,
        sessionID: ctx.payload.sessionID ?? undefined,
        kind: ctx.payload.kind,
        status: ctx.payload.status,
      })
      return {
        entries: result.entries.map(toWire),
        totalHits: result.totalHits,
        degraded: false,
      }
    })

    const storeHandler = Effect.fn("Memory.store")(function* (ctx: {
      payload: typeof MemoryStoreInput.Type
    }) {
      const id = ctx.payload.id ?? randomUUID()
      const scope = ctx.payload.scope as "global" | "session"
      const tags = ctx.payload.tags ? [...ctx.payload.tags] : []
      const sessionID = ctx.payload.sessionID ?? undefined
      const expiresAt = ctx.payload.expiresAt ?? undefined
      const agentID = ctx.payload.agentID ?? undefined

      const value: unknown = (() => {
        if (ctx.payload.envelope) return ctx.payload.envelope
        if (looksLikeMemoryPayload(ctx.payload.value)) return ctx.payload.value
        return encodeMemoryValue(unwrapMemoryValue(ctx.payload.value, ctx.payload.key))
      })()

      yield* repo.put({
        id,
        key: ctx.payload.key,
        value,
        context: ctx.payload.context ?? undefined,
        tags,
        scope,
        sessionID,
        expiresAt,
        agentID,
      })

      const entry = yield* repo.get(id)
      return { id, version: entry?.version ?? 1 }
    })

    const forgetHandler = Effect.fn("Memory.forget")(function* (ctx: {
      payload: typeof MemoryForgetInput.Type
    }) {
      if (ctx.payload.id) {
        yield* repo.forget(ctx.payload.id)
        return { removed: 1 }
      }
      if (ctx.payload.key && ctx.payload.scope) {
        const removed = yield* repo.forgetByKey({
          key: ctx.payload.key,
          scope: ctx.payload.scope as "global" | "session",
          sessionID: ctx.payload.sessionID ?? undefined,
        })
        return { removed }
      }
      return { removed: 0 }
    })

    const candidatesHandler = Effect.fn("Memory.candidates")(function* (ctx: {
      payload: typeof MemoryCandidatesInput.Type
    }) {
      const status = ctx.payload.status as "pending" | "active" | "superseded" | "rejected" | "expired" | undefined
      const scope = ctx.payload.scope as "global" | "session" | undefined
      const entries = yield* memoryService.listCandidates({
        status,
        scope,
        limit: ctx.payload.limit ?? 200,
      })
      return { entries: entries.map(toWire), count: entries.length }
    })

    const promoteHandler = Effect.fn("Memory.promote")(function* (ctx: {
      payload: typeof MemoryPromoteInput.Type
    }) {
      const result = yield* memoryService.promote({
        id: ctx.payload.id,
        expectedVersion: ctx.payload.expectedVersion,
        key: ctx.payload.key ?? undefined,
        scope: ctx.payload.scope as "global" | "session" | undefined,
        skipSupersede: ctx.payload.skipSupersede ?? false,
      }).pipe(
        Effect.catchTag("NotFoundError", (e: MemoryNotFoundError) =>
          Effect.fail(
            new InvalidRequestError({ message: `memory entry ${e.id} not found` }),
          ),
        ),
        Effect.catchTag("StaleWriteError", (e: StaleWriteError) =>
          Effect.fail(
            new InvalidRequestError({
              message: `stale write: expected v${e.expectedVersion}, current v${e.currentVersion} for id=${e.id}`,
            }),
          ),
        ),
      )
      return {
        id: result.entry.id,
        key: result.entry.key,
        status: "active" as const,
        version: result.entry.version,
        supersededIds: result.supersededIds,
      }
    })

    const rejectHandler = Effect.fn("Memory.reject")(function* (ctx: {
      payload: typeof MemoryRejectInput.Type
    }) {
      const updated = yield* memoryService.reject({
        id: ctx.payload.id,
        expectedVersion: ctx.payload.expectedVersion,
      }).pipe(
        Effect.catchTag("NotFoundError", (e: MemoryNotFoundError) =>
          Effect.fail(
            new InvalidRequestError({ message: `memory entry ${e.id} not found` }),
          ),
        ),
        Effect.catchTag("StaleWriteError", (e: StaleWriteError) =>
          Effect.fail(
            new InvalidRequestError({
              message: `stale write: expected v${e.expectedVersion}, current v${e.currentVersion} for id=${e.id}`,
            }),
          ),
        ),
      )
      return {
        id: updated.id,
        status: "rejected" as const,
        version: updated.version,
      }
    })

    const summaryHandler = Effect.fn("Memory.summary")(function* (ctx: {
      payload: typeof MemorySummaryInput.Type
    }) {
      const scope = ctx.payload.scope as "global" | "session" | undefined
      const sessionID = ctx.payload.sessionID ?? undefined
      const maxItems = ctx.payload.maxItems ?? 25
      const [summary, decisions, warnings] = yield* Effect.all(
        [
          projection.projectSummary({ scope, sessionID }),
          projection.decisionDigest({ scope, sessionID, maxItems }),
          projection.warningDigest({ scope, sessionID, maxItems }),
        ],
        { concurrency: "unbounded" },
      )
      return {
        totalActive: summary.totalActive,
        byKind: summary.byKind.map((s) => ({ kind: String(s.kind), count: s.entries.length })),
        decisionDigest: decisions.items.map((d) => ({ ...d, kind: d.kind ?? "observation" })),
        warningDigest: warnings.items.map((d) => ({ ...d, kind: d.kind ?? "warning" })),
        generatedAt: Math.max(summary.generatedAt, decisions.generatedAt, warnings.generatedAt),
      }
    })

    return handlers
      .handle("list", listHandler)
      .handle("get", getHandler)
      .handle("recall", recallHandler)
      .handle("search", searchHandler)
      .handle("store", storeHandler)
      .handle("forget", forgetHandler)
      .handle("candidates", candidatesHandler)
      .handle("promote", promoteHandler)
      .handle("reject", rejectHandler)
      .handle("summary", summaryHandler)
  }),
)