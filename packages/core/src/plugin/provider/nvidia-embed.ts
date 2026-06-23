import { Cause, Effect } from "effect"
import { PluginV2 } from "../../plugin"

const NIM_DEFAULT_BASE = "https://integrate.api.nvidia.com/v1"
// NIM expects the full model identifier in the request body, including the
// "nvidia/" namespace prefix that the catalog uses. Do NOT strip it.
const NIM_PROVIDER_PREFIX = "nvidia/"

const callNimEmbeddings = async (
  baseURL: string,
  apiKey: string,
  // The full model identifier as NIM knows it, e.g. "nvidia/llama-nemotron-embed-1b-v2".
  modelIdentifier: string,
  inputs: string[],
): Promise<number[][]> => {
  let res: Response
  try {
    res = await fetch(`${baseURL.replace(/\/+$/, "")}/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
body: JSON.stringify({
      model: modelIdentifier,
      input: inputs,
      encoding_format: "float",
      input_type: process.env.NVIDIA_INPUT_TYPE ?? "query",
      truncate: process.env.NVIDIA_TRUNCATE ?? "NONE",
    }),
    })
  } catch (e) {
    const message = e instanceof Error ? `${e.name}: ${e.message}` : String(e)
    throw new Error(`NIM request failed: ${message}`)
  }
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
          evt.error = "No API key configured for nvidia (expected env var: NVIDIA_API_KEY). Please check settings or env vars."
          return
        }

        const baseURL = process.env.NVIDIA_API_BASE ?? NIM_DEFAULT_BASE
        const result = yield* Effect.tryPromise({
          try: () => callNimEmbeddings(baseURL, apiKey, evt.model, evt.input),
          catch: (e) => {
            const message = e instanceof Error ? `${e.name}: ${e.message}` : String(e)
            return `NVIDIA embeddings failed: ${message}`
          },
        }).pipe(Effect.exit)

        if (result._tag === "Failure") {
          const cause = result.cause as unknown
          evt.error = typeof cause === "string" ? cause : JSON.stringify(cause)
          return
        }

        evt.embeddings = result.value
      }),
    }
  }),
})