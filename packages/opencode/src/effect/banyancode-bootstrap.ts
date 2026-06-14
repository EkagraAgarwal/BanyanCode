import { Effect } from "effect"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Banyan } from "@opencode-ai/core/banyancode"
import { Config } from "@/config/config"

export const applyEmbeddingModel = Effect.gen(function* () {
  const flags = yield* RuntimeFlags.Service
  if (!flags.banyancodeEnable) return
  const modelName = flags.banyancodeEmbeddingModel
  if (!modelName) {
    const globalConfig = yield* Config.Service.use((svc) => svc.getGlobal())
    if (globalConfig.banyancode_embedding_model) {
      const provider = yield* Banyan.EmbeddingProviderService
      yield* provider.setModel(globalConfig.banyancode_embedding_model)
    }
  } else {
    const provider = yield* Banyan.EmbeddingProviderService
    yield* provider.setModel(modelName)
  }
})


