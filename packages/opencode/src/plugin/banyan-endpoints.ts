import type { Hooks, PluginInput } from "@opencode-ai/plugin"

const banyancodeEnabled = () => process.env.BANYANCODE_ENABLE !== "0"

interface OpenAICompatibleEndpoint {
  name: string
  base_url: string
  api_key?: string
  models?: string[]
}

/**
 * PR 5: BanyanEndpointsPlugin wires `banyancode_openai_compatible_endpoints`
 * (defined in `BanyanConfig.Info`) into the runtime provider catalog.
 *
 * The schema-only field is otherwise never read by opencode. This plugin
 * reads BanyanConfig at startup and emits each endpoint as an AI SDK
 * OpenAI-compatible provider so it shows up alongside built-ins.
 */
export async function BanyanEndpointsPlugin(_input: PluginInput): Promise<Hooks> {
  if (!banyancodeEnabled()) return {}

  const { Banyan } = await import("@opencode-ai/core/banyancode")
  const { Effect, Layer, ManagedRuntime } = await import("effect")

  let endpoints: OpenAICompatibleEndpoint[] = []

  try {
    const rt = ManagedRuntime.make(Banyan.banyanConfigServiceDefaultLayer as never)
    const cfg = await rt.runPromise(
      Effect.gen(function* () {
        const svc = yield* Banyan.BanyanConfigService
        return yield* svc.get()
      }),
    )
    await rt.dispose()
    endpoints = (cfg.banyancode_openai_compatible_endpoints ?? []) as OpenAICompatibleEndpoint[]
  } catch (err) {
    console.warn("[banyan-endpoints] failed to read BanyanConfig:", err)
  }

  if (endpoints.length === 0) return {}

  const providerEntries: Array<[string, Record<string, unknown>]> = endpoints.map((endpoint) => {
    const provider: Record<string, unknown> = {
      name: endpoint.name,
      npm: "@ai-sdk/openai-compatible",
      api: endpoint.base_url,
    }
    if (endpoint.api_key) {
      provider.options = { apiKey: endpoint.api_key }
    }
    if (endpoint.models && endpoint.models.length > 0) {
      provider.models = Object.fromEntries(
        endpoint.models.map((modelID) => [modelID, { name: modelID }]),
      )
    }
    return [endpoint.name, provider]
  })

  return {
    config: async (input: { provider?: Record<string, unknown> }) => {
      const existing = (input.provider ?? {}) as Record<string, unknown>
      const merged: Record<string, unknown> = { ...existing }
      for (const [name, provider] of providerEntries) {
        if (merged[name]) continue
        merged[name] = provider
      }
      input.provider = merged
    },
  }
}