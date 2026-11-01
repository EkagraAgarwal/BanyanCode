export * as CachePrewarm from "./prewarm.js"

// Ported verbatim from v1 `packages/opencode/src/session/prewarm.ts` (WS6).
// v1 never fired the wire request (`TODO(network)`), so v2 keeps the same
// gate + 30-minute process-local idempotency with no network side effect.

export interface PrewarmInput {
  readonly providerID: string
  readonly modelID: string
  readonly promptCacheMode: string
  readonly enabled: boolean
  readonly stablePrefix: string
}

const PREWARM_MODEL_RE = /(?:^|\/)gpt-5\.6(?:[.-]|$)|(?:^|\/)gpt-6(?:[.-]|$)/
const PREWARM_TTL_MS = 30 * 60_000
const marks = new Map<string, number>()
let fired = 0

const hashPrefix = (stablePrefix: string): string => {
  const head = stablePrefix.slice(0, 200)
  let hash = 2166136261
  for (let i = 0; i < head.length; i++) {
    hash ^= head.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

export const maybePrewarm = (input: PrewarmInput): boolean => {
  if (!input.enabled) return false
  if (input.providerID !== "openai") return false
  if (input.promptCacheMode === "off") return false
  if (!PREWARM_MODEL_RE.test(input.modelID)) return false
  const key = `${input.modelID}:${hashPrefix(input.stablePrefix)}`
  const now = Date.now()
  const seenAt = marks.get(key)
  if (seenAt !== undefined && now - seenAt < PREWARM_TTL_MS) return false
  marks.set(key, now)
  fired++
  return true
}

export const prewarmFiredCount = (): number => fired

export const resetPrewarm = (): void => {
  marks.clear()
  fired = 0
}
