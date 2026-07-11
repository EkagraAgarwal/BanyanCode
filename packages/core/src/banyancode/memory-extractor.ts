/**
 * BanyanCode Memory Extractor (Phase 2).
 *
 * Pre-emit gate for candidate memory observations. Runs BEFORE the candidate
 * hits `MemoryService.emitCandidate`. Determines:
 *
 * 1. The decision (keep / merge / summarize / discard) from
 *    `memory-significance.decide`.
 * 2. The canonicalized key from `memory-significance.suggestKey` — merge
 *    candidates with the same suggested key into the existing entry.
 * 3. A trimmed / condensed body for "summarize" decisions.
 * 4. The confidence / importance floor based on intrinsic signals so
 *    callers don't write `low` for what is clearly a `high`.
 *
 * This stage is deterministic and offline. There's no LLM involvement —
 * the model is too easy to leak junk through. Future phases can swap in a
 * pluggable extractor (e.g. asking an LLM to classify), but the shape of
 * `ExtractResult` stays stable.
 */

import { Context, Effect, Layer } from "effect"
import type { MemoryPayloadV1 } from "./memory-payload"
import { Database } from "../database/database"
import { MemoryEntriesTable } from "./memory.sql"
import { and, eq, ne, sql } from "drizzle-orm"
import {
  decide,
  normalizeForDedupe,
  type KeepDecision,
  suggestKey,
  totalScore,
} from "./memory-significance"

export interface ExtractInput {
  payload: MemoryPayloadV1
  scope: "global" | "session"
  sessionID?: string
  /** Maximum body length when decision is "summarize". */
  maxSummaryBody?: number
}

export type ExtractAction =
  | { type: "keep"; payload: MemoryPayloadV1; suggestedKey: string; score: number }
  | {
      type: "merge"
      payload: MemoryPayloadV1
      suggestedKey: string
      existingID: string
      existingKey: string
      score: number
    }
  | { type: "summarize"; payload: MemoryPayloadV1; suggestedKey: string; score: number; condensedBody: string }
  | { type: "discard"; reason: string; score: number }

export interface ExtractResult {
  decision: KeepDecision
  action: ExtractAction
  score: number
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/Banyan/MemoryExtractor") {}

export interface Interface {
  readonly extract: (input: ExtractInput) => Effect.Effect<ExtractResult, never, never>
}

const banyancodeEnabled = () => process.env.BANYANCODE_ENABLE !== "0"

const condenseBody = (body: string, max: number): string => {
  const trimmed = body.trim().replace(/\s+/g, " ")
  if (trimmed.length <= max) return trimmed
  const cut = trimmed.slice(0, max)
  const lastSpace = cut.lastIndexOf(" ")
  if (lastSpace < max * 0.7) {
    return cut + "..."
  }
  return cut.slice(0, lastSpace) + "..."
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    if (!banyancodeEnabled()) {
      return Service.of({
        extract: (input) =>
          Effect.succeed({
            decision: "discard" as const,
            action: { type: "discard", reason: "banyancode disabled", score: 0 },
            score: 0,
          }),
      })
    }

    const { db } = yield* Database.Service

    const findMergeTarget = Effect.fn("MemoryExtractor.findMergeTarget")(
      function* (scope: "global" | "session", sessionID: string | undefined, key: string) {
        const conflictCondition = and(
          eq(MemoryEntriesTable.scope, scope),
          ne(MemoryEntriesTable.status, "rejected"),
          sql`lower(${MemoryEntriesTable.key}) = lower(${key})`,
        )
        const sessionCondition = scope === "session" && sessionID ? eq(MemoryEntriesTable.session_id, sessionID) : undefined
        const row = yield* db
          .select({ id: MemoryEntriesTable.id, key: MemoryEntriesTable.key })
          .from(MemoryEntriesTable)
          .where(sessionCondition ? and(conflictCondition, sessionCondition) : conflictCondition)
          .orderBy(sql`${MemoryEntriesTable.updated_at} DESC`)
          .limit(1)
          .get()
          .pipe(Effect.orDie)
        return row ?? null
      },
    )

    const extract: Interface["extract"] = (input) =>
      Effect.gen(function* () {
        const existingPayloads = yield* db
          .select({ value: MemoryEntriesTable.value })
          .from(MemoryEntriesTable)
          .where(
            and(
              eq(MemoryEntriesTable.scope, input.scope),
              input.scope === "session" && input.sessionID
                ? eq(MemoryEntriesTable.session_id, input.sessionID)
                : sql`1=1`,
              ne(MemoryEntriesTable.status, "rejected"),
            ),
          )
          .all()
          .pipe(Effect.orDie)
          .pipe(
            Effect.map((rows) =>
              rows.flatMap((r) => {
                const parsed = (() => {
                  const v = r.value as unknown
                  if (v && typeof v === "object" && "_v" in v && "data" in (v as Record<string, unknown>)) {
                    return ((v as Record<string, unknown>).data as MemoryPayloadV1) ?? null
                  }
                  return null
                })()
                return parsed ? [parsed] : []
              }),
            ),
          )

        const score = totalScore({ payload: input.payload, existing: existingPayloads })
        const decision = decide({ payload: input.payload, existing: existingPayloads })
        const suggestedKey = suggestKey({
          ...input.payload,
          title: normalizeForDedupe(input.payload.title),
        })

        if (decision === "discard") {
          return {
            decision,
            action: {
              type: "discard" as const,
              reason: `score=${score.toFixed(2)} below MERGE_THRESHOLD`,
              score,
            },
            score,
          }
        }

        if (decision === "merge") {
          const target = yield* findMergeTarget(input.scope, input.sessionID, suggestedKey)
          if (target) {
            return {
              decision,
              action: {
                type: "merge" as const,
                payload: input.payload,
                suggestedKey,
                existingID: target.id,
                existingKey: target.key,
                score,
              },
              score,
            }
          }
        }

        if (decision === "summarize") {
          const condensedBody = condenseBody(input.payload.body, input.maxSummaryBody ?? 240)
          return {
            decision,
            action: {
              type: "summarize" as const,
              payload: { ...input.payload, body: condensedBody },
              suggestedKey,
              score,
              condensedBody,
            },
            score,
          }
        }

        return {
          decision,
          action: { type: "keep" as const, payload: input.payload, suggestedKey, score },
          score,
        }
      })

    return Service.of({ extract })
  }),
)

export const defaultLayer: Layer.Layer<Service, never, never> = layer.pipe(
  Layer.provide(Database.defaultLayer),
)
