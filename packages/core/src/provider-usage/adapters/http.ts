export * as ProviderUsageHttp from "./http.js"

import { Effect } from "effect"
import { ProviderUsageError } from "../error.js"
import type { FetchImpl } from "./types.js"

/**
 * One authenticated GET against a pinned usage endpoint.
 *
 * Status mapping is shared by every adapter so a token can never reach a
 * message: `401`/`403` become `unauthenticated` static text, `429` becomes
 * `rate_limited`, any other non-OK becomes `upstream` with only the numeric
 * status, and transport/parse failures become `network`/`upstream` with a
 * static label. The underlying error is deliberately not attached.
 */
export interface RequestInput {
  readonly providerID: string
  readonly fetch: FetchImpl
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
  readonly label: string
  readonly unauthorized: string
  readonly rateLimited: string
  readonly unreadable: string
}

export const requestJson = (input: RequestInput): Effect.Effect<unknown, ProviderUsageError> =>
  Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: () => input.fetch(input.url, { method: "GET", headers: { ...input.headers } }),
      catch: () =>
        new ProviderUsageError({
          providerID: input.providerID,
          reason: "network",
          message: `${input.label} request failed`,
        }),
    })
    if (response.status === 401 || response.status === 403)
      return yield* new ProviderUsageError({
        providerID: input.providerID,
        reason: "unauthenticated",
        message: input.unauthorized,
      })
    if (response.status === 429)
      return yield* new ProviderUsageError({
        providerID: input.providerID,
        reason: "rate_limited",
        message: input.rateLimited,
      })
    if (!response.ok)
      return yield* new ProviderUsageError({
        providerID: input.providerID,
        reason: "upstream",
        message: `${input.label} returned status ${response.status}`,
      })
    return yield* Effect.tryPromise({
      try: () => response.json() as Promise<unknown>,
      catch: () =>
        new ProviderUsageError({
          providerID: input.providerID,
          reason: "upstream",
          message: input.unreadable,
        }),
    })
  })

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

export const toFiniteNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined

/** Numeric, or an ISO/date string parsed to epoch milliseconds. */
export const toResetsAt = (value: unknown): number | undefined => {
  const numeric = toFiniteNumber(value)
  if (numeric !== undefined) return numeric
  if (typeof value === "string" && value.length > 0) {
    const parsed = Date.parse(value)
    return Number.isNaN(parsed) ? undefined : parsed
  }
  return undefined
}

/**
 * Run a pure normalizer without letting a malformed payload escape as a
 * defect. A typed adapter error passes through; anything else becomes a
 * static `upstream` message (the thrown text is deliberately dropped).
 */
export const fromThrow = <A>(
  providerID: string,
  run: () => A,
): Effect.Effect<A, ProviderUsageError> =>
  Effect.try({
    try: run,
    catch: (cause) =>
      cause instanceof ProviderUsageError
        ? cause
        : new ProviderUsageError({
            providerID,
            reason: "upstream",
            message: "Provider usage normalization failed",
          }),
  })
