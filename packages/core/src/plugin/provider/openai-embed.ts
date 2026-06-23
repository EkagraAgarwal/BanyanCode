import { Effect, Cause } from "effect"
import { PluginV2 } from "../../plugin"

const SUPPORTED_PROVIDERS = new Set([
  "openai",
  "openrouter",
  "groq",
  "togetherai",
  "deepinfra",
  "mistral",
  "cohere",
  "perplexity",
  "github-copilot",
  "vercel",
  "xai",
  "cerebras",
  "azure",
  "amazon-bedrock",
])

// Map provider IDs to their standard env var suffix (uppercase)
// Note: "nvidia" is intentionally NOT here — NVIDIA NIM embedding is handled
// by the dedicated nvidia-embed plugin (see packages/core/src/plugin/provider/
// nvidia-embed.ts) because NIM expects the full namespaced model identifier
// (e.g. "nvidia/llama-nemotron-embed-1b-v2") in the request body, whereas
// the other providers below expect a bare model name.
const PROVIDER_ENV_VAR_MAP: Record<string, { key: string; base?: string }> = {
  openai: { key: "OPENAI_API_KEY", base: "OPENAI_API_BASE" },
  openrouter: { key: "OPENROUTER_API_KEY", base: "OPENROUTER_API_BASE" },
  groq: { key: "GROQ_API_KEY", base: "GROQ_API_BASE" },
  togetherai: { key: "TOGETHERAI_API_KEY", base: "TOGETHERAI_API_BASE" },
  deepinfra: { key: "DEEPINFRA_API_KEY", base: "DEEPINFRA_API_BASE" },
  mistral: { key: "MISTRAL_API_KEY", base: "MISTRAL_API_BASE" },
  cohere: { key: "COHERE_API_KEY", base: "COHERE_API_BASE" },
  perplexity: { key: "PERPLEXITY_API_KEY", base: "PERPLEXITY_API_BASE" },
  "github-copilot": { key: "GITHUB_COPILOT_API_KEY", base: "GITHUB_COPILOT_API_BASE" },
  vercel: { key: "VERCEL_API_KEY", base: "VERCEL_API_BASE" },
  xai: { key: "XAI_API_KEY", base: "XAI_API_BASE" },
  cerebras: { key: "CEREBRAS_API_KEY", base: "CEREBRAS_API_BASE" },
  azure: { key: "AZURE_OPENAI_API_KEY", base: "AZURE_OPENAI_API_BASE" },
  "amazon-bedrock": { key: "AWS_ACCESS_KEY_ID", base: "AWS_BEDROCK_BASE" },
}

const callEmbeddingsAPI = async (
  baseURL: string,
  apiKey: string,
  modelId: string,
  inputs: string[],
  extraHeaders?: Record<string, string>,
): Promise<number[][]> => {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  }
  if (extraHeaders) {
    for (const [k, v] of Object.entries(extraHeaders)) {
      headers[k] = v
    }
  }
  const res = await fetch(`${baseURL.replace(/\/+$/, "")}/embeddings`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: modelId,
      input: inputs,
      encoding_format: "float",
    }),
  })
  if (!res.ok) {
    const txt = await res.text()
    throw new Error(`Embeddings API ${res.status}: ${txt.slice(0, 300)}`)
  }
  const json = (await res.json()) as { data: Array<{ embedding: number[] }> }
  return json.data.map((d) => d.embedding)
}

export const OpenAIEmbedPlugin = PluginV2.define({
  id: PluginV2.ID.make("openai-embed"),
  effect: Effect.gen(function* () {
    return {
      "aisdk.embed": Effect.fn(function* (evt) {
        if (evt.embeddings.length > 0) return

        // Parse providerID/modelID from evt.model
        const slash = evt.model.indexOf("/")
        if (slash < 0) return
        const providerID = evt.model.slice(0, slash)
        if (!SUPPORTED_PROVIDERS.has(providerID)) return

        // Prefer options passed in the event (from opencode layer Provider.Service)
        // Fall back to env vars for backward compat (tests, standalone use)
        let baseURL: string | undefined = evt.options?.baseURL
        let apiKey: string | undefined = evt.options?.apiKey
        const headers: Record<string, string> | undefined = evt.options?.headers

        if (!baseURL || !apiKey) {
          const mapping = PROVIDER_ENV_VAR_MAP[providerID]
          if (mapping) {
            baseURL = baseURL ?? process.env[mapping.base ?? ""]
            apiKey = apiKey ?? process.env[mapping.key]
          }
        }

        if (!baseURL) {
          evt.error = `No base URL configured for provider ${providerID}. Please check settings or env vars.`
          return
        }
        if (!apiKey) {
          const mapping = PROVIDER_ENV_VAR_MAP[providerID]
          const keyName = mapping ? mapping.key : `${providerID.toUpperCase()}_API_KEY`
          evt.error = `No API key configured for provider ${providerID} (expected env var: ${keyName}). Please check settings or env vars.`
          return
        }

        const modelId = evt.model.slice(slash + 1)
        if (!modelId) return

        const result = yield* Effect.tryPromise(() =>
          callEmbeddingsAPI(baseURL!, apiKey!, modelId, evt.input, headers),
        ).pipe(Effect.exit)

        if (result._tag === "Failure") {
          const err = Cause.squash(result.cause)
          evt.error = err instanceof Error ? err.message : String(err)
          return
        }

        evt.embeddings = result.value
      }),
    }
  }),
})
