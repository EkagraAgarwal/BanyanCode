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
//
// A body overlay added to `session.model.request` would not replace this: the
// transport merges `http.body` into the protocol body (`route/transport/http.ts`),
// so it can add or replace fields but cannot delete one the protocol already
// emitted (the `off` policy). v2's typed provider options only carry known
// fields too — `prompt_cache_options` is `{ ttl }` in both OpenAI protocols.

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
  readonly chatgpt: boolean
  readonly body: Record<string, unknown>
  readonly comparisonResponseID?: string
}

export interface BodyPlan {
  readonly body: Record<string, unknown>
  readonly changed: boolean
  readonly keyApplied: boolean
  readonly optionsApplied: boolean
  readonly toolSearchDeferred: ReadonlyArray<string>
}

// ── tool_search / defer_loading ────────────────────────────────────────────
// Port of v1 `packages/opencode/src/session/tools.ts` +
// `session/llm/request.ts` gate. Eager tools stay inline; every other
// function tool gets `defer_loading: true` and a hosted `{ type:
// "tool_search" }` entry, so its schema loads at end-of-context instead of
// being billed as input on every turn. OpenAI Responses + gpt-5.4+/gpt-6 only,
// default OFF — unset/false leaves the body byte-for-byte untouched.
export const TOOL_SEARCH_EAGER_NAMES: ReadonlySet<string> = new Set([
  "shell",
  "read",
  "edit",
  "write",
  "patch",
  "multiedit",
  "apply_patch",
  "ls",
  "grep",
  "glob",
  "subagent",
  "task",
  "todowrite",
  "question",
  "webfetch",
  "websearch",
  "skill",
])

const GPT5_TOOL_SEARCH_RE = /(?:^|\/)gpt-5[.-](\d+)(?:[.-]|$)/
const GPT6_TOOL_SEARCH_RE = /(?:^|\/)gpt-6(?:[.-]|$)/

export const supportsToolSearchDefer = (modelID: string): boolean => {
  const id = modelID.toLowerCase()
  if (GPT6_TOOL_SEARCH_RE.test(id)) return true
  const match = GPT5_TOOL_SEARCH_RE.exec(id)
  return match !== null && Number(match[1]) >= 4
}

export const toolSearchDeferApplies = (input: {
  readonly config: Info
  readonly providerID: string
  readonly modelID: string
}): boolean =>
  input.config.banyancode_tool_search_defer === true &&
  input.providerID === "openai" &&
  supportsToolSearchDefer(input.modelID)

/** Returns the wire tool record plus the deferred names; untouched when nothing applies. */
export const applyToolSearchDefer = (
  tools: ReadonlyArray<unknown>,
): { readonly tools: ReadonlyArray<unknown>; readonly deferred: ReadonlyArray<string> } => {
  const deferred: string[] = []
  const next = tools.map((tool) => {
    if (!isRecord(tool) || tool.type !== "function" || typeof tool.name !== "string") return tool
    if (TOOL_SEARCH_EAGER_NAMES.has(tool.name)) return tool
    deferred.push(tool.name)
    return { ...tool, defer_loading: true }
  })
  const hasSearch = tools.some((tool) => isRecord(tool) && tool.type === "tool_search")
  return { tools: hasSearch ? next : [...next, { type: "tool_search" }], deferred }
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
  // ChatGPT sign-in uses a different API contract, even for the same model ID.
  // Keep its cache routing key, but let the backend manage cache lifetimes and mode.
  if (input.providerID === "openai" && input.chatgpt) {
    remove("prompt_cache_options")
    remove("prompt_cache_retention")
  }
  if (input.providerID === "openai" && !input.chatgpt && supportsPromptCacheOptions(input.modelID)) {
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

  let toolSearchDeferred: ReadonlyArray<string> = []
  if (toolSearchDeferApplies(input)) {
    const tools = Array.isArray(body.tools) ? body.tools : undefined
    if (tools !== undefined && tools.length > 0) {
      const plan = applyToolSearchDefer(tools)
      set("tools", plan.tools)
      toolSearchDeferred = plan.deferred
    }
  }

  return { body, changed, keyApplied, optionsApplied, toolSearchDeferred }
}
