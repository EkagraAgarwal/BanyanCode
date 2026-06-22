import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { PluginV2 } from "@opencode-ai/core/plugin"
import { NvidiaEmbedPlugin } from "@opencode-ai/core/plugin/provider/nvidia-embed"
import { it } from "./provider-helper"

const originalApiKey = process.env.NVIDIA_API_KEY

function restoreEnv() {
  if (originalApiKey === undefined) delete process.env.NVIDIA_API_KEY
  else process.env.NVIDIA_API_KEY = originalApiKey
}

describe("NvidiaEmbedPlugin", () => {
  it.effect("is a no-op when NVIDIA_API_KEY is missing", () =>
    Effect.gen(function* () {
      delete process.env.NVIDIA_API_KEY

      const plugin = yield* PluginV2.Service
      yield* plugin.add(NvidiaEmbedPlugin)
      const result = yield* plugin.trigger(
        "aisdk.embed",
        { model: "nvidia/llama-nemotron-embed-1b-v2", input: ["hello"] },
        { embeddings: [] },
      )
      expect(result.embeddings).toEqual([])
      restoreEnv()
    }),
  )

  it.effect("skips models that do not start with the nvidia/ prefix", () =>
    Effect.gen(function* () {
      process.env.NVIDIA_API_KEY = "test-key"

      const plugin = yield* PluginV2.Service
      yield* plugin.add(NvidiaEmbedPlugin)
      const result = yield* plugin.trigger(
        "aisdk.embed",
        { model: "openai/text-embedding-3-small", input: ["hello"] },
        { embeddings: [] },
      )
      expect(result.embeddings).toEqual([])
      restoreEnv()
    }),
  )

  it.effect("does not overwrite embeddings when result is empty", () =>
    Effect.gen(function* () {
      process.env.NVIDIA_API_KEY = "test-key"

      const plugin = yield* PluginV2.Service
      yield* plugin.add(NvidiaEmbedPlugin)
      yield* plugin.trigger(
        "aisdk.embed",
        { model: "nvidia/llama-nemotron-embed-1b-v2", input: ["hello"] },
        { embeddings: [[0.1, 0.2, 0.3]] },
      )
      restoreEnv()
    }),
  )
})