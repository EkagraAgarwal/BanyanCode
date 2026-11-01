export * as TokenUsage from "./tokens.js"

import { Schema } from "effect"

// Token attribution port. v1 kept an in-memory ring fed by the LLM publisher
// (`token-attribution.ts`). v2 exposes usage through the public
// `session.usage.updated` session event, so the plugin subscribes and keeps a
// bounded ring here.

export const TokenUsageEvent = Schema.Struct({
  sessionID: Schema.String,
  providerID: Schema.optional(Schema.String),
  modelID: Schema.optional(Schema.String),
  agent: Schema.optional(Schema.String),
  costUsd: Schema.Finite,
  inputTokens: Schema.Finite,
  outputTokens: Schema.Finite,
  reasoningTokens: Schema.Finite,
  cacheReadInputTokens: Schema.Finite,
  cacheWriteInputTokens: Schema.Finite,
  totalTokens: Schema.Finite,
  recordedAt: Schema.Finite,
}).annotate({ identifier: "Banyan.TokenUsageEvent" })

export type TokenUsageEvent = typeof TokenUsageEvent.Type

export interface TokenUsageResult {
  readonly events: readonly TokenUsageEvent[]
}

export interface Options {
  readonly enabled?: boolean
  readonly maxEvents?: number
  readonly retentionMs?: number
}

export interface Interface {
  readonly record: (input: {
    readonly sessionID: string
    readonly providerID?: string
    readonly modelID?: string
    readonly agent?: string
    readonly costUsd: number
    readonly tokens: {
      readonly input: number
      readonly output: number
      readonly reasoning: number
      readonly cache: { readonly read: number; readonly write: number }
    }
    readonly recordedAt?: number
  }) => void
  readonly recent: (input?: { readonly sessionID?: string; readonly since?: number }) => readonly TokenUsageEvent[]
  readonly count: () => number
}

const DEFAULT_MAX_EVENTS = 100_000
const DEFAULT_RETENTION_DAYS = 30

export const make = (options: Options = {}): Interface => {
  const enabled = options.enabled ?? true
  const maxEvents = Math.max(1, Math.floor(options.maxEvents ?? DEFAULT_MAX_EVENTS))
  const retentionMs = Math.max(0, options.retentionMs ?? DEFAULT_RETENTION_DAYS * 24 * 60 * 60 * 1000)
  let events: readonly TokenUsageEvent[] = []

  const record: Interface["record"] = (input) => {
    if (!enabled) return
    const recordedAt = input.recordedAt ?? Date.now()
    const event: TokenUsageEvent = {
      sessionID: input.sessionID,
      ...(input.providerID === undefined ? {} : { providerID: input.providerID }),
      ...(input.modelID === undefined ? {} : { modelID: input.modelID }),
      ...(input.agent === undefined ? {} : { agent: input.agent }),
      costUsd: input.costUsd,
      inputTokens: input.tokens.input,
      outputTokens: input.tokens.output,
      reasoningTokens: input.tokens.reasoning,
      cacheReadInputTokens: input.tokens.cache.read,
      cacheWriteInputTokens: input.tokens.cache.write,
      totalTokens:
        input.tokens.input +
        input.tokens.output +
        input.tokens.reasoning +
        input.tokens.cache.read +
        input.tokens.cache.write,
      recordedAt,
    }
    const cutoff = recordedAt - retentionMs
    events = [...events.filter((item) => item.recordedAt >= cutoff), event].slice(-maxEvents)
  }

  return {
    record,
    recent: (input) =>
      events.filter((event) => {
        if (input?.sessionID !== undefined && event.sessionID !== input.sessionID) return false
        if (input?.since !== undefined && event.recordedAt < input.since) return false
        return true
      }),
    count: () => events.length,
  }
}

export const retentionMsFromDays = (days: number | undefined): number | undefined => {
  if (days === undefined) return undefined
  return Math.max(0, days) * 24 * 60 * 60 * 1000
}
