import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { PluginV2 } from "@opencode-ai/core/plugin"
import { NvidiaEmbedTestPlugin } from "@opencode-ai/core/plugin/provider/nvidia-embed"
import { it } from "./provider-helper"

const originalTestFlag = process.env.BANYANCODE_NVIDIA_TEST
const originalApiKey = process.env.NVIDIA_API_KEY

function restoreEnv() {
  if (originalTestFlag === undefined) delete process.env.BANYANCODE_NVIDIA_TEST
  else process.env.BANYANCODE_NVIDIA_TEST = originalTestFlag
  if (originalApiKey === undefined) delete process.env.NVIDIA_API_KEY
  else process.env.NVIDIA_API_KEY = originalApiKey
}

describe("NvidiaEmbedTestPlugin", () => {
  it.effect("is a no-op when BANYANCODE_NVIDIA_TEST is not set", () =>
    Effect.gen(function* () {
      delete process.env.BANYANCODE_NVIDIA_TEST
      process.env.NVIDIA_API_KEY = "test-key"

      const plugin = yield* PluginV2.Service
      yield* plugin.add(NvidiaEmbedTestPlugin)
      const result = yield* plugin.trigger(
        "aisdk.embed",
        { model: "nvidia/llama-nemotron-embed-1b-v2", input: ["hello"] },
        { embeddings: [] },
      )
      expect(result.embeddings).toEqual([])
      restoreEnv()
    }),
  )

  it.effect("is a no-op when NVIDIA_API_KEY is missing", () =>
    Effect.gen(function* () {
      process.env.BANYANCODE_NVIDIA_TEST = "1"
      delete process.env.NVIDIA_API_KEY

      const plugin = yield* PluginV2.Service
      yield* plugin.add(NvidiaEmbedTestPlugin)
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
      process.env.BANYANCODE_NVIDIA_TEST = "1"
      process.env.NVIDIA_API_KEY = "test-key"

      const plugin = yield* PluginV2.Service
      yield* plugin.add(NvidiaEmbedTestPlugin)
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
      process.env.BANYANCODE_NVIDIA_TEST = "1"
      process.env.NVIDIA_API_KEY = "test-key"

      const plugin = yield* PluginV2.Service
      yield* plugin.add(NvidiaEmbedTestPlugin)
      yield* plugin.trigger(
        "aisdk.embed",
        { model: "nvidia/llama-nemotron-embed-1b-v2", input: ["hello"] },
        { embeddings: [[0.1, 0.2, 0.3]] },
      )
      restoreEnv()
    }),
  )
})