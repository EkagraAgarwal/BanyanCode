export * as TokenAttribution from "./token-attribution"

import { Context, Effect, Layer, Ref } from "effect"
import type { Usage } from "@opencode-ai/llm"
import type { TraceEvent } from "./trace-collector"

export type TokenAttributionStatus = "success" | "error" | "aborted"

export type TokenAttributionInput = {
  readonly callID: string
  readonly modelID: string
  readonly provider: string
  readonly sessionID: string
  readonly parentSessionID?: string | null
  readonly agentRole: string
  readonly depth?: number
  readonly startedAt: number
  readonly durationMs: number
  readonly status: TokenAttributionStatus
  readonly usage: Usage
  readonly trace?: Pick<TraceEvent, "traceName" | "parentTraceName">
}

export type TokenAttributionEvent = Omit<TokenAttributionInput, "usage" | "trace"> & {
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly reasoningTokens?: number
  readonly cacheReadInputTokens?: number
  readonly cacheWriteInputTokens?: number
  readonly uncachedInputTokens?: number
  readonly totalTokens?: number
  readonly traceName?: string
  readonly parentTraceName?: string | null
}

export type Options = {
  readonly maxEvents?: number
  readonly retentionMs?: number
}

export interface Interface {
  readonly record: (input: TokenAttributionInput) => Effect.Effect<void, never, never>
  readonly recent: (input?: {
    readonly sessionID?: string
    readonly since?: number
  }) => Effect.Effect<readonly TokenAttributionEvent[], never, never>
  readonly count: () => Effect.Effect<number, never, never>
}

export class Service extends Context.Service<Service, Interface>()("@banyancode/TokenAttribution") {}

const normalize = (input: TokenAttributionInput): TokenAttributionEvent => {
  const { usage } = input
  const uncachedInputTokens =
    usage.nonCachedInputTokens ??
    (usage.inputTokens !== undefined && usage.cacheReadInputTokens !== undefined && usage.cacheWriteInputTokens !== undefined
      ? Math.max(0, usage.inputTokens - usage.cacheReadInputTokens - usage.cacheWriteInputTokens)
      : undefined)

  return {
    callID: input.callID,
    modelID: input.modelID,
    provider: input.provider,
    sessionID: input.sessionID,
    parentSessionID: input.parentSessionID,
    agentRole: input.agentRole,
    depth: input.depth,
    startedAt: input.startedAt,
    durationMs: Math.max(0, input.durationMs),
    status: input.status,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    reasoningTokens: usage.reasoningTokens,
    cacheReadInputTokens: usage.cacheReadInputTokens,
    cacheWriteInputTokens: usage.cacheWriteInputTokens,
    uncachedInputTokens,
    totalTokens: usage.totalTokens,
    traceName: input.trace?.traceName,
    parentTraceName: input.trace?.parentTraceName,
  }
}

export const layer = (options: Options = {}) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const maxEvents = Math.max(1, Math.floor(options.maxEvents ?? 256))
      const retentionMs = Math.max(0, options.retentionMs ?? 24 * 60 * 60 * 1000)
      const events = yield* Ref.make<readonly TokenAttributionEvent[]>([])

      const record = (input: TokenAttributionInput) =>
        Ref.update(events, (current) => {
          const event = normalize(input)
          const cutoff = event.startedAt - retentionMs
          return [...current.filter((item) => item.startedAt >= cutoff), event].slice(-maxEvents)
        })

      const recent = (input?: { readonly sessionID?: string; readonly since?: number }) =>
        Ref.get(events).pipe(
          Effect.map((current) =>
            current.filter((event) => {
              if (input?.sessionID !== undefined && event.sessionID !== input.sessionID) return false
              if (input?.since !== undefined && event.startedAt < input.since) return false
              return true
            }),
          ),
        )

      const count = () => Ref.get(events).pipe(Effect.map((current) => current.length))
      return Service.of({ record, recent, count })
    }),
  )

export const defaultLayer = layer()
