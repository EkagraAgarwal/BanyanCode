import { Effect } from "effect"
import { PluginV2 } from "../../plugin"

const NIM_DEFAULT_BASE = "https://integrate.api.nvidia.com/v1"
const NIM_PROVIDER_PREFIX = "nvidia/"

const callNimEmbeddings = async (
  baseURL: string,
  apiKey: string,
  modelId: string,
  inputs: string[],
): Promise<number[][]> => {
  const res = await fetch(`${baseURL.replace(/\/+$/, "")}/embeddings`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: modelId,
      input: inputs,
      encoding_format: "float",
      input_type: process.env.NVIDIA_INPUT_TYPE ?? "query",
      truncate: process.env.NVIDIA_TRUNCATE ?? "NONE",
    }),
  })
  if (!res.ok) {
    const txt = await res.text()
    throw new Error(`NIM ${res.status}: ${txt.slice(0, 300)}`)
  }
  const json = (await res.json()) as { data: Array<{ embedding: number[] }> }
  return json.data.map((d) => d.embedding)
}

export const NvidiaEmbedPlugin = PluginV2.define({
  id: PluginV2.ID.make("nvidia-embed"),
  effect: Effect.gen(function* () {
    return {
      "aisdk.embed": Effect.fn(function* (evt) {
        if (evt.embeddings.length > 0) return
        if (!evt.model.startsWith(NIM_PROVIDER_PREFIX)) return

        const apiKey = process.env.NVIDIA_API_KEY
        if (!apiKey) {
          yield* Effect.logWarning("[nvidia-embed] NVIDIA_API_KEY is not set; skipping")
          return
        }

        const modelId = evt.model.slice(NIM_PROVIDER_PREFIX.length)
        if (!modelId) return

        const baseURL = process.env.NVIDIA_API_BASE ?? NIM_DEFAULT_BASE
        const vectors = yield* Effect.promise(() => callNimEmbeddings(baseURL, apiKey, modelId, evt.input))
        evt.embeddings = vectors
      }),
    }
  }),
})