// WS6 prewarm (prompt-caching plan): fire `prompt_cache_options.prewarm`
// before the first real request for a stable system prefix so OpenAI
// GPT-5.6+/GPT-6 warms the prompt cache ahead of the first turn. This file
// owns the gate + process-local idempotency; the wire fire is still
// TODO(network) — the OpenAI Responses schema already carries `prewarm`
// (packages/llm/src/protocols/openai-responses.ts) but no request path
// emits it yet.

export const maybePrewarm = async (opts: {
  providerID: string
  modelID: string
  promptCacheMode: string
  enabled: boolean
  stablePrefix: string
}): Promise<void> => {
  if (!opts.enabled) return
  if (opts.providerID !== "openai") return
  if (opts.promptCacheMode === "off") return
  if (!PREWARM_MODEL_RE.test(opts.modelID)) return
  const key = `${opts.modelID}:${hashPrefix(opts.stablePrefix)}`
  const now = Date.now()
  const seenAt = marks.get(key)
  // Seen within 30 min → skip (idempotent across prepare() calls).
  if (seenAt !== undefined && now - seenAt < PREWARM_TTL_MS) return
  // Mark BEFORE any await so concurrent prepare() calls cannot double-fire.
  marks.set(key, now)
  fired++
  // TODO(network): emit prompt_cache_options.prewarm.
}

// Anchored like transform.ts supportsPromptCacheOptions: gpt-5.6+ minor and
// the gpt-6 family; "gpt-60"/"gpt-52" must never match.
const PREWARM_MODEL_RE = /(?:^|\/)gpt-5\.6(?:[.-]|$)|(?:^|\/)gpt-6(?:[.-]|$)/

// Process-lifetime marks keyed by modelID + hash of the first 200 chars of
// the stable prefix (same footprint class as SessionTools sticky snapshots).
const PREWARM_TTL_MS = 30 * 60_000
const marks = new Map<string, number>()

// Test observable: how many calls passed the gate and marked. Gate tests in
// test/session/prewarm.test.ts read this instead of stubbing fetch.
let fired = 0

export const prewarmFiredCount = () => fired
export const resetPrewarm = () => {
  marks.clear()
  fired = 0
}

// FNV-1a over the first 200 chars — cheap, deterministic, no crypto import.
const hashPrefix = (stablePrefix: string) => {
  const head = stablePrefix.slice(0, 200)
  let hash = 2166136261
  for (let i = 0; i < head.length; i++) {
    hash ^= head.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

export * as SessionPrewarm from "./prewarm"
