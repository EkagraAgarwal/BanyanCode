import { DateTime, Effect, Scope, Stream } from "effect"
import { Catalog } from "../catalog"
import { EventV2 } from "../event"
import { ModelV2 } from "../model"
import { ModelRequest } from "../model-request"
import { ModelsDev } from "../models-dev"
import { PluginV2 } from "../plugin"
import { ProviderV2 } from "../provider"

function released(date: string) {
  const time = Date.parse(date)
  return DateTime.makeUnsafe(Number.isFinite(time) ? time : 0)
}

function cost(input: ModelsDev.Model["cost"]) {
  const base = {
    input: input?.input ?? 0,
    output: input?.output ?? 0,
    cache: {
      read: input?.cache_read ?? 0,
      write: input?.cache_write ?? 0,
    },
  }
  if (!input?.context_over_200k) return [base]
  return [
    base,
    {
      tier: {
        type: "context" as const,
        size: 200_000,
      },
      input: input.context_over_200k.input,
      output: input.context_over_200k.output,
      cache: {
        read: input.context_over_200k.cache_read ?? 0,
        write: input.context_over_200k.cache_write ?? 0,
      },
    },
  ]
}

// DRIFT NOTICE: This logic is duplicated and customized from packages/opencode/src/provider/transform.ts
// If you modify reasoning variants mapping here, please update the other file as well.
function reasoningVariants(model: ModelsDev.Model, packageName?: string) {
  const options = model.reasoning_options
  if (!options || options.length === 0) return []

  const effort = options.find((option) => option.type === "effort")
  const budget = options.find((option) => option.type === "budget_tokens")
  const toggle = options.some((option) => option.type === "toggle")

  const base: Record<string, Record<string, any>> = {}

  if (effort) {
    for (const value of effort.values) {
      const id = value === null ? "none" : typeof value === "string" ? value : undefined
      if (id === undefined) continue

      if (packageName === "@openrouter/ai-sdk-provider") {
        base[id] = { reasoning: { effort: value } }
      } else if (packageName === "@ai-sdk/google" || packageName === "@ai-sdk/google-vertex") {
        base[id] = { thinkingConfig: { includeThoughts: true, thinkingLevel: value } }
      } else if (packageName === "@ai-sdk/anthropic" || packageName === "@ai-sdk/google-vertex/anthropic") {
        if (value === "low" || value === "medium") {
          base[id] = { thinking: { type: "disabled" } }
        } else {
          const limit = model.limit.output - 1
          const b = Math.min(Math.max(1024, Math.floor(limit * 0.8)), 32000)
          base[id] = { thinking: { type: "enabled", budgetTokens: b } }
        }
      } else if (packageName === "@ai-sdk/amazon-bedrock") {
        const isAnthropic = model.id.startsWith("anthropic.claude-3-7") || model.id.startsWith("us.anthropic.claude-3-7")
        if (isAnthropic) {
          if (value === "low" || value === "medium") {
            base[id] = {
              reasoningConfig: {
                type: "disabled",
              },
            }
          } else {
            const limit = model.limit.output - 1
            const b = Math.min(Math.max(1024, Math.floor(limit * 0.8)), 32000)
            base[id] = {
              reasoningConfig: {
                type: "enabled",
                budget: b,
              },
            }
          }
        } else {
          base[id] = id === "none" ? { reasoningEffort: "low" } : { reasoningEffort: value }
        }
      } else {
        base[id] = id === "none" ? { reasoningEffort: "low" } : { reasoningEffort: value }
      }
    }
  } else if (toggle) {
    if (packageName === "@ai-sdk/alibaba") {
      base["none"] = { enableThinking: false }
      base["high"] = { enableThinking: true }
    } else if (packageName === "@ai-sdk/cohere") {
      base["none"] = { thinking: { type: "disabled" } }
      base["high"] = { thinking: { type: "enabled" } }
    } else if (packageName === "@ai-sdk/anthropic" || packageName === "@ai-sdk/google-vertex/anthropic") {
      const limit = model.limit.output - 1
      const b = Math.min(Math.max(1024, Math.floor(limit * 0.8)), 32000)
      base["none"] = { thinking: { type: "disabled" } }
      base["thinking"] = { thinking: { type: "enabled", budgetTokens: b } }
    } else if (
      packageName === "@ai-sdk/openai-compatible" ||
      packageName === "@ai-sdk/xai" ||
      packageName === "@ai-sdk/mistral" ||
      packageName === "@ai-sdk/groq" ||
      packageName === "@ai-sdk/cerebras" ||
      packageName === "@ai-sdk/deepinfra" ||
      packageName === "@ai-sdk/togetherai" ||
      packageName === "venice-ai-sdk-provider" ||
      packageName === "ai-gateway-provider"
    ) {
      base["none"] = { thinking: false }
      base["thinking"] = { thinking: true }
    }
  } else if (budget) {
    const min = budget.min ?? 0
    const max = budget.max
    const limit = model.limit.output - 1
    const high = Math.min(max === undefined ? Math.max(min, 16000) : Math.min(Math.max(min, 16000), max), limit)
    const maximum = max === undefined ? undefined : Math.min(max, limit)

    const mapBudget = (b: number) => {
      if (packageName === "@openrouter/ai-sdk-provider") {
        return { reasoning: { budget_tokens: b } }
      }
      return { thinking: { type: "enabled", budgetTokens: b } }
    }
    if (high > 0) base["high"] = mapBudget(high)
    if (maximum !== undefined && maximum !== high && maximum > 0) base["max"] = mapBudget(maximum)
  }

  return Object.entries(base).map(([id, item]) => {
    const request = ModelRequest.normalizeAiSdkOptions(packageName, item)
    return {
      id: ModelV2.VariantID.make(id),
      headers: {},
      ...request,
    }
  })
}

function variants(model: ModelsDev.Model, packageName?: string) {
  const experimental = Object.entries(model.experimental?.modes ?? {}).map(([id, item]) => {
    const request = ModelRequest.normalizeAiSdkOptions(packageName, item.provider?.body ?? {})
    return {
      id: ModelV2.VariantID.make(id),
      headers: { ...(item.provider?.headers ?? {}) },
      ...request,
    }
  })

  const reasoning = reasoningVariants(model, packageName)

  // Merge reasoning variants and experimental modes.
  // In case of conflict, experimental modes (explicit configuration) override reasoning variants.
  const merged = [...reasoning]
  for (const exp of experimental) {
    const idx = merged.findIndex((r) => r.id === exp.id)
    if (idx !== -1) {
      merged[idx] = exp
    } else {
      merged.push(exp)
    }
  }

  return merged
}

export const ModelsDevPlugin = PluginV2.define({
  id: PluginV2.ID.make("models-dev"),
  effect: Effect.gen(function* () {
    const catalog = yield* Catalog.Service
    const modelsDev = yield* ModelsDev.Service
    const events = yield* EventV2.Service
    const scope = yield* Scope.Scope
    const transform = yield* catalog.transform()
    const refresh = Effect.fn("ModelsDevPlugin.refresh")(function* () {
      const data = yield* modelsDev.get()
      yield* transform((catalog) => {
        for (const item of Object.values(data)) {
          const providerID = ProviderV2.ID.make(item.id)
          catalog.provider.update(providerID, (provider) => {
            provider.name = item.name
            provider.env = [...item.env]
            provider.api = item.npm
              ? {
                  type: "aisdk",
                  package: item.npm,
                  url: item.api,
                }
              : {
                  type: "native",
                  url: item.api,
                  settings: {},
                }
          })

          for (const model of Object.values(item.models)) {
            const modelID = ModelV2.ID.make(model.id)
            catalog.model.update(providerID, modelID, (draft) => {
              draft.name = model.name
              draft.family = model.family ? ModelV2.Family.make(model.family) : undefined
              draft.api = model.provider?.npm
                ? {
                    id: draft.api.id,
                    type: "aisdk",
                    package: model.provider?.npm,
                    url: model.provider.api,
                  }
                : {
                    id: draft.api.id,
                    type: "native",
                    url: model.provider?.api,
                    settings: {},
                  }
              draft.capabilities = {
                tools: model.tool_call,
                input: [...(model.modalities?.input ?? [])],
                output: [...(model.modalities?.output ?? [])],
              }
              draft.variants = variants(model, model.provider?.npm ?? item.npm)
              draft.time.released = released(model.release_date)
              draft.cost = cost(model.cost)
              draft.status = model.status ?? "active"
              draft.enabled = true
              draft.limit = {
                context: model.limit.context,
                input: model.limit.input,
                output: model.limit.output,
              }
            })
          }
        }
      })
    })
    yield* refresh()
    yield* events.subscribe(ModelsDev.Event.Refreshed).pipe(
      Stream.runForEach(() => refresh()),
      Effect.forkScoped({ startImmediately: true }),
    )
  }),
})
