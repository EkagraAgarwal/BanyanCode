import { Schema } from "effect"
import type { LLMRequest, ReasoningEffort, TextVerbosity as TextVerbosityValue } from "../../schema"
import { ReasoningEfforts, TextVerbosity } from "../../schema"

export const OpenAIReasoningEfforts = ReasoningEfforts.filter(
  (effort): effort is Exclude<ReasoningEffort, "max"> => effort !== "max",
)
export type OpenAIReasoningEffort = (typeof OpenAIReasoningEfforts)[number]

// Mirrors OpenAI's `ResponseIncludable` union from the official SDK. Keep this
// in lockstep with `openai-node/src/resources/responses/responses.ts`.
export const OpenAIResponseIncludables = [
  "file_search_call.results",
  "web_search_call.results",
  "web_search_call.action.sources",
  "message.input_image.image_url",
  "computer_call_output.output.image_url",
  "code_interpreter_call.outputs",
  "reasoning.encrypted_content",
  "message.output_text.logprobs",
] as const
export type OpenAIResponseIncludable = (typeof OpenAIResponseIncludables)[number]
export const OpenAIServiceTiers = ["auto", "default", "flex", "priority"] as const
export type OpenAIServiceTier = (typeof OpenAIServiceTiers)[number]

const REASONING_EFFORTS = new Set<string>(ReasoningEfforts)
const OPENAI_REASONING_EFFORTS = new Set<string>(OpenAIReasoningEfforts)
const TEXT_VERBOSITY = new Set<string>(["low", "medium", "high"])
const INCLUDABLES = new Set<string>(OpenAIResponseIncludables)
const SERVICE_TIERS = new Set<string>(OpenAIServiceTiers)

export const OpenAIReasoningEffort = Schema.Literals(OpenAIReasoningEfforts)
export const OpenAITextVerbosity = TextVerbosity
export const OpenAIResponseIncludable = Schema.Literals(OpenAIResponseIncludables)
export const OpenAIServiceTier = Schema.Literals(OpenAIServiceTiers)

const isAnyReasoningEffort = (effort: unknown): effort is ReasoningEffort =>
  typeof effort === "string" && REASONING_EFFORTS.has(effort)

export const isReasoningEffort = (effort: unknown): effort is OpenAIReasoningEffort =>
  typeof effort === "string" && OPENAI_REASONING_EFFORTS.has(effort)

const isTextVerbosity = (value: unknown): value is TextVerbosityValue =>
  typeof value === "string" && TEXT_VERBOSITY.has(value)

const options = (request: LLMRequest) => request.providerOptions?.openai

export const store = (request: LLMRequest): boolean | undefined => {
  const value = options(request)?.store
  return typeof value === "boolean" ? value : undefined
}

export const reasoningEffort = (request: LLMRequest): ReasoningEffort | undefined => {
  const value = options(request)?.reasoningEffort
  return isAnyReasoningEffort(value) ? value : undefined
}

export const reasoningSummary = (request: LLMRequest): "auto" | undefined =>
  options(request)?.reasoningSummary === "auto" ? "auto" : undefined

// Resolve the OpenAI Responses `include` field. Filters out unknown
// includable values defensively so a typo in upstream config drops the
// invalid entry instead of poisoning the wire body. An empty array (either
// passed directly or produced by filtering) is treated as "no include" and
// returns undefined so the request body omits the field entirely.
export const include = (request: LLMRequest): ReadonlyArray<OpenAIResponseIncludable> | undefined => {
  const value = options(request)?.include
  if (!Array.isArray(value)) return undefined
  const filtered = value.filter((entry): entry is OpenAIResponseIncludable => INCLUDABLES.has(entry))
  return filtered.length > 0 ? filtered : undefined
}

// `prompt_cache_key` is an OpenAI Responses field that only OpenAI, OpenRouter,
// and Mistral document. Compatible endpoints (meta, deepseek, togetherai, ...)
// may not implement it, and an undocumented key can destabilize prompt-cache
// routing and cause full cache misses. A caller-supplied key in providerOptions
// is an explicit opt-in for any provider; without one the key is only emitted
// for documented providers (see `promptCacheKeyPolicy`).
export const promptCacheKeyProviders = ["openai", "openrouter", "mistral"] as const
export type PromptCacheKeyProvider = (typeof promptCacheKeyProviders)[number]
const PROMPT_CACHE_KEY_PROVIDERS = new Set<string>(promptCacheKeyProviders)

export const supportsPromptCacheKey = (provider: string) => PROMPT_CACHE_KEY_PROVIDERS.has(provider)

// Resolve the session prompt-cache-key policy. `"auto"` (the default) sends the
// session id only to providers that document `prompt_cache_key` support; `"off"`
// never sends it; any other string is sent verbatim for every provider.
export const promptCacheKeyPolicy = (policy: string, provider: string, sessionID: string): string | undefined => {
  if (policy === "off") return undefined
  const sessionKey = /^ses_[0-9a-f]{64}$/.test(sessionID) ? sessionID.slice(4) : sessionID
  if (policy !== "auto") return policy
  return PROMPT_CACHE_KEY_PROVIDERS.has(provider) ? sessionKey : undefined
}

export const promptCacheKey = (request: LLMRequest) => {
  const value = options(request)?.promptCacheKey
  return typeof value === "string" ? value : undefined
}

// `prompt_cache_options` is documented for GPT-5.6+ and GPT-6 only; older
// models 400 on it. Anchored like the AI-SDK-side gate (transform.ts) so
// "gpt-60" never matches; gpt5 minor >= 6 means 5.6+.
const GPT5_PROMPT_CACHE_VERSION_RE = /(?:^|\/)gpt-5[.-](\d+)(?:[.-]|$)/
const GPT6_FAMILY_RE = /(?:^|\/)gpt-6(?:[.-]|$)/

export const supportsPromptCacheOptions = (modelID: string) => {
  const id = modelID.toLowerCase()
  if (GPT6_FAMILY_RE.test(id)) return true
  const match = GPT5_PROMPT_CACHE_VERSION_RE.exec(id)
  return match !== null && Number(match[1]) >= 6
}

// Read `prompt_cache_options` from providerOptions.openai, keeping only
// known-valid fields (defensive: a typo drops the entry instead of poisoning
// the wire body, same rationale as `include`). An invalid `mode` (e.g. the
// config value "off", which must omit the field entirely) invalidates the
// whole object. Returns undefined when nothing valid remains.
export const promptCacheOptions = (request: LLMRequest) => {
  const value = options(request)?.prompt_cache_options
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const mode: "implicit" | "explicit" | undefined =
    record.mode === "implicit" ? "implicit" : record.mode === "explicit" ? "explicit" : undefined
  if (record.mode !== undefined && mode === undefined) return undefined
  const ttl = record.ttl === "30m" ? ("30m" as const) : undefined
  const prewarm = typeof record.prewarm === "boolean" ? record.prewarm : undefined
  const comparison =
    typeof record.comparison_response_id === "string" && record.comparison_response_id.length > 0
      ? record.comparison_response_id
      : undefined
  const result = {
    ...(mode !== undefined ? { mode } : {}),
    ...(ttl !== undefined ? { ttl } : {}),
    ...(prewarm !== undefined ? { prewarm } : {}),
    ...(comparison !== undefined ? { comparison_response_id: comparison } : {}),
  }
  return Object.keys(result).length > 0 ? result : undefined
}

// WS5 sticky tools: forward `tool_choice` from providerOptions.openai
// ("none" | `{ type: "allowed_tools", mode, tools }`) — the shape
// ProviderTransform.options emits when callability narrows. Only used when
// the request has no explicit `toolChoice` (that one wins, e.g.
// generateObject's named tool). Shape-validated so a typo drops the field
// instead of poisoning the wire body.
export const toolChoice = (request: LLMRequest) => {
  const value = options(request)?.tool_choice
  if (value === "auto" || value === "none" || value === "required") return value
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (record.type !== "allowed_tools") return undefined
  // Explicit annotations: the literal ternary widens to `string` under tsgo
  // when the branches compare against `unknown`, which breaks assignability
  // to the closed OpenAIResponsesToolChoice schema.
  const mode: "auto" | "required" | undefined =
    record.mode === "auto" ? "auto" : record.mode === "required" ? "required" : undefined
  if (mode === undefined || !Array.isArray(record.tools)) return undefined
  const tools: { type: "function"; name: string }[] = record.tools.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return []
    const tool = entry as Record<string, unknown>
    return tool.type === "function" && typeof tool.name === "string" && tool.name.length > 0
      ? [{ type: "function" as const, name: tool.name }]
      : []
  })
  if (tools.length === 0) return undefined
  return { type: "allowed_tools" as const, mode, tools }
}

export const textVerbosity = (request: LLMRequest) => {
  const value = options(request)?.textVerbosity
  return isTextVerbosity(value) ? value : undefined
}

export const serviceTier = (request: LLMRequest) => {
  const value = options(request)?.serviceTier
  return typeof value === "string" && SERVICE_TIERS.has(value) ? (value as OpenAIServiceTier) : undefined
}

export const instructions = (request: LLMRequest) => {
  const value = options(request)?.instructions
  return typeof value === "string" ? value : undefined
}

export * as OpenAIOptions from "./openai-options"
