export * as JevLedger from "./jev-ledger"

// Bounded per-session Jev usage ledger. Each physical attempt counts once;
// reported usage and reserved estimates are tracked separately and never
// inflate the request count.
//
// `cost` is reported actual cost (usage.cost from the provider).
// `estimatedCost` is conservative estimated spend retained (not pending):
// tokens-only success derives from known price + actual input tokens,
// no-usage 2xx or ambiguous timeout/network/cancel retains the
// pre-request estimate. It is never double-counted with `cost`.
// `reservedCost` (exposed as `pendingCost`) is in-flight pending only and
// is always released exactly once per attempt; it never accumulates across
// retries. Budget = cost + estimatedCost + reservedCost.

export interface UsageSnapshot {
  readonly sessionID: string
  readonly requests: number
  readonly cachedHits: number
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cost: number
  readonly estimatedCost: number
  readonly pendingCost: number
  readonly features: Readonly<Record<string, number>>
  readonly scopes: Readonly<Record<string, number>>
}

export const MAX_SESSIONS = 500
export const MAX_FEATURES_PER_SESSION = 50
export const MAX_SCOPES_PER_SESSION = 100

interface MutableEntry {
  requests: number
  cachedHits: number
  inputTokens: number
  outputTokens: number
  cost: number
  estimatedCost: number
  reservedCost: number
  features: Map<string, number>
  scopes: Map<string, number>
}

const sessions = new Map<string, MutableEntry>()

const entryFor = (sessionID: string): MutableEntry => {
  let entry = sessions.get(sessionID)
  if (!entry) {
    entry = {
      requests: 0,
      cachedHits: 0,
      inputTokens: 0,
      outputTokens: 0,
      cost: 0,
      estimatedCost: 0,
      reservedCost: 0,
      features: new Map(),
      scopes: new Map(),
    }
    sessions.set(sessionID, entry)
    while (sessions.size > MAX_SESSIONS) {
      const oldest = sessions.keys().next()
      if (oldest.done) break
      sessions.delete(oldest.value)
    }
  }
  return entry
}

const bumpCapped = (map: Map<string, number>, cap: number, key: string): void => {
  const current = map.get(key)
  if (current !== undefined) {
    map.set(key, current + 1)
    return
  }
  if (map.size >= cap) {
    const oldest = map.keys().next()
    if (!oldest.done) map.delete(oldest.value)
  }
  map.set(key, 1)
}

export const reserveCall = (sessionID: string, opts?: { feature?: string; scope?: string }): void => {
  const entry = entryFor(sessionID || "default")
  if (opts?.scope) bumpCapped(entry.scopes, MAX_SCOPES_PER_SESSION, opts.scope)
  if (opts?.feature) bumpCapped(entry.features, MAX_FEATURES_PER_SESSION, opts.feature)
}

export const recordAttempt = (sessionID: string): void => {
  entryFor(sessionID || "default").requests += 1
}

export const recordUsage = (
  sessionID: string,
  opts?: { inputTokens?: number; outputTokens?: number; cost?: number; reservedCost?: number; estimatedCost?: number },
): void => {
  const entry = entryFor(sessionID || "default")
  if (opts?.inputTokens !== undefined && Number.isFinite(opts.inputTokens) && opts.inputTokens > 0)
    entry.inputTokens += opts.inputTokens
  if (opts?.outputTokens !== undefined && Number.isFinite(opts.outputTokens) && opts.outputTokens > 0)
    entry.outputTokens += opts.outputTokens
  // Reported cost is actual; never double-count with an estimate.
  if (opts?.cost !== undefined && Number.isFinite(opts.cost) && opts.cost >= 0) {
    entry.cost += opts.cost
    entry.reservedCost = Math.max(0, entry.reservedCost - (opts.reservedCost ?? 0))
    return
  }
  // Tokens-only success: caller passes a derived estimate (known price +
  // actual input tokens). Retained as spent, pending released.
  if (opts?.estimatedCost !== undefined && Number.isFinite(opts.estimatedCost) && opts.estimatedCost >= 0) {
    if (opts.estimatedCost > 0) entry.estimatedCost += opts.estimatedCost
    entry.reservedCost = Math.max(0, entry.reservedCost - (opts.reservedCost ?? opts.estimatedCost))
  }
}

/** Release one in-flight reservation. Floor at zero so double-release is harmless. */
export const releaseCost = (sessionID: string, amount: number): void => {
  if (!Number.isFinite(amount) || amount <= 0) return
  const entry = entryFor(sessionID || "default")
  entry.reservedCost = Math.max(0, entry.reservedCost - amount)
}

/** Convert pending into retained conservative spend (NOT pending). Floor pending at zero. */
export const recordEstimatedSpend = (sessionID: string, amount: number, opts?: { reservedCost?: number }): void => {
  if (!Number.isFinite(amount) || amount < 0) return
  const entry = entryFor(sessionID || "default")
  if (amount > 0) entry.estimatedCost += amount
  entry.reservedCost = Math.max(0, entry.reservedCost - (opts?.reservedCost ?? amount))
}

/** Atomic estimated-cost reservation. False when the cap would be exceeded.
 * Budget = actual cost + estimated spend + pending; reserves add pending only. */
export const reserveCost = (sessionID: string, amount: number, cap: number | undefined): boolean => {
  if (!Number.isFinite(amount) || amount < 0) return false
  const entry = entryFor(sessionID || "default")
  if (cap !== undefined && entry.cost + entry.estimatedCost + entry.reservedCost + amount > cap) return false
  entry.reservedCost += amount
  return true
}

export const recordCacheHit = (sessionID: string, opts?: { feature?: string }): void => {
  const entry = entryFor(sessionID || "default")
  entry.cachedHits += 1
  if (opts?.feature) bumpCapped(entry.features, MAX_FEATURES_PER_SESSION, opts.feature)
}

export const scopeCount = (sessionID: string, scope: string): number =>
  sessions.get(sessionID || "default")?.scopes.get(scope) ?? 0

export const sessionCost = (sessionID: string): number => sessions.get(sessionID || "default")?.cost ?? 0

export const sessionSpend = (sessionID: string): number => {
  const entry = sessions.get(sessionID || "default")
  return entry ? entry.cost + entry.estimatedCost + entry.reservedCost : 0
}

export const snapshot = (sessionID: string): UsageSnapshot => {
  const id = sessionID || "default"
  const entry = sessions.get(id)
  if (!entry)
    return {
      sessionID: id,
      requests: 0,
      cachedHits: 0,
      inputTokens: 0,
      outputTokens: 0,
      cost: 0,
      estimatedCost: 0,
      pendingCost: 0,
      features: {},
      scopes: {},
    }
  return {
    sessionID: id,
    requests: entry.requests,
    cachedHits: entry.cachedHits,
    inputTokens: entry.inputTokens,
    outputTokens: entry.outputTokens,
    cost: entry.cost,
    estimatedCost: entry.estimatedCost,
    pendingCost: entry.reservedCost,
    features: Object.fromEntries(entry.features),
    scopes: Object.fromEntries(entry.scopes),
  }
}

export const resetForTests = (): void => {
  sessions.clear()
}

export const sessionCountForTests = (): number => sessions.size
