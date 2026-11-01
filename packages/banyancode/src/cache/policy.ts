export * as CachePolicy from "./policy.js"

import type { Info } from "../config/schema.js"

// Port of the BanyanCode prompt-caching knobs from v1
// `packages/opencode/src/provider/transform.ts` and
// `packages/llm/src/protocols/utils/openai-options.ts`.
//
// v2's `session.model.request` hook exposes only baseURL/headers, so the
// provider-options payload is applied by rewriting the outbound JSON body in
// `session.http.request`. That covers native protocols and AI SDK providers
// uniformly.

export const PROMPT_CACHE_KEY_PROVIDERS: ReadonlySet<string> = new Set(["openai", "openrouter", "mistral"])

export const supportsPromptCacheKey = (provider: string): boolean => PROMPT_CACHE_KEY_PROVIDERS.has(provider)

const GPT5_PROMPT_CACHE_VERSION_RE = /(?:^|\/)gpt-5[.-](\d+)(?:[.-]|$)/
const GPT6_FAMILY_RE = /(?:^|\/)gpt-6(?:[.-]|$)/

export const supportsPromptCacheOptions = (modelID: string): boolean => {
  const id = modelID.toLowerCase()
  if (GPT6_FAMILY_RE.test(id)) return true
  const match = GPT5_PROMPT_CACHE_VERSION_RE.exec(id)
  return match !== null && Number(match[1]) >= 6
}

export const promptCacheKeyPolicy = (policy: string, provider: string, sessionID: string): string | undefined => {
  if (policy === "off") return undefined
  const sessionKey = /^ses_[0-9a-f]{64}$/.test(sessionID) ? sessionID.slice(4) : sessionID
  if (policy !== "auto") return policy
  return supportsPromptCacheKey(provider) ? sessionKey : undefined
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const same = (left: unknown, right: unknown): boolean => {
  if (left === right) return true
  try {
    return JSON.stringify(left) === JSON.stringify(right)
  } catch {
    return false
  }
}

export interface PlanInput {
  readonly config: Info
  readonly providerID: string
  readonly modelID: string
  readonly sessionID: string
  readonly body: Record<string, unknown>
  readonly comparisonResponseID?: string
}

export interface BodyPlan {
  readonly body: Record<string, unknown>
  readonly changed: boolean
  readonly keyApplied: boolean
  readonly optionsApplied: boolean
}

/**
 * Pure rewrite of a provider JSON body. Leaves the body untouched unless a
 * configured cache knob applies, so non-OpenAI providers and unsupported
 * models stay byte-identical.
 */
export const planBody = (input: PlanInput): BodyPlan => {
  let body = input.body
  let changed = false
  let keyApplied = false
  let optionsApplied = false

  const set = (field: string, value: unknown) => {
    if (same(body[field], value)) return
    body = { ...body, [field]: value }
    changed = true
  }
  const remove = (field: string) => {
    if (!(field in body)) return
    const next = { ...body }
    delete next[field]
    body = next
    changed = true
  }

  const keyPolicy = input.config.banyancode_prompt_cache_key ?? "auto"
  const key = promptCacheKeyPolicy(keyPolicy, input.providerID, input.sessionID)
  if (supportsPromptCacheKey(input.providerID)) {
    if (keyPolicy === "off") {
      remove("prompt_cache_key")
    } else if (keyPolicy === "auto") {
      // v2 core already sets the key from SessionAffinity (children share the
      // parent's cache). Only fill it in when the provider body lacks one.
      if (body.prompt_cache_key === undefined) {
        if (!same(body.prompt_cache_key, key)) keyApplied = true
        set("prompt_cache_key", key)
      }
    } else if (key !== undefined) {
      if (!same(body.prompt_cache_key, key)) keyApplied = true
      set("prompt_cache_key", key)
    }
  }

  const mode = input.config.banyancode_prompt_cache_mode ?? "implicit"
  if (input.providerID === "openai" && supportsPromptCacheOptions(input.modelID)) {
    if (mode === "off") {
      remove("prompt_cache_options")
    } else {
      const existing = isRecord(body.prompt_cache_options) ? body.prompt_cache_options : {}
      const comparison =
        input.config.banyancode_prompt_cache_diagnostics === true ? input.comparisonResponseID : undefined
      const desired: Record<string, unknown> = { ...existing, mode }
      if (comparison !== undefined) desired.comparison_response_id = comparison
      else delete desired.comparison_response_id
      if (!same(body.prompt_cache_options, desired)) optionsApplied = true
      set("prompt_cache_options", desired)
    }
  }

  return { body, changed, keyApplied, optionsApplied }
}
