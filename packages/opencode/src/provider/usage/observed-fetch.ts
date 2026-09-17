/**
 * Observed fetch wrapper (provider-usage sidebar, Phase 3).
 *
 * Wraps any provider `fetch` implementation so response headers from actual
 * configured provider model HTTP calls are recorded in the process-local
 * observer store. The wrapper:
 * - delegates to the inner fetch (custom auth-plugin wrappers included),
 * - never reads, clones, or consumes the body,
 * - never changes request semantics or response identity,
 * - propagates rejections untouched,
 * - swallows observer failures so usage can never break a model call.
 */

import { observeRateLimitResponse } from "./observer"

export type FetchLike = (input: any, init?: any) => Promise<Response>

export interface WrapObservedFetchOptions {
  readonly providerID: string
  readonly accountKey?: string
  readonly now?: () => number
}

/** Wrap `inner` with header observation. Returns the original response object. */
export const wrapObservedFetch = (inner: FetchLike, opts: WrapObservedFetchOptions): FetchLike => {
  const now = opts.now
  return async (input: any, init?: any): Promise<Response> => {
    const response = await inner(input, init)
    try {
      observeRateLimitResponse(opts.providerID, response.headers as unknown as Headers, {
        ...(opts.accountKey !== undefined ? { accountKey: opts.accountKey } : {}),
        ...(now ? { now: now() } : {}),
      })
    } catch {
      // Observer is best-effort; model calls must never fail because of it.
    }
    return response
  }
}
