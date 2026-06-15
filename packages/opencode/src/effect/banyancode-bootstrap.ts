import { Effect } from "effect"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Banyan } from "@opencode-ai/core/banyancode"

export const applyEmbeddingModel = Effect.gen(function* () {
  const flags = yield* RuntimeFlags.Service
  if (!flags.banyancodeEnable) return
  const modelName = flags.banyancodeEmbeddingModel
  if (!modelName) {
    const banyanConfig = yield* Banyan.BanyanConfigService.use((svc) => svc.get())
    if (banyanConfig.banyancode_embedding_model) {
      const provider = yield* Banyan.EmbeddingProviderService
      yield* provider.setModel(banyanConfig.banyancode_embedding_model)
    }
  } else {
    const provider = yield* Banyan.EmbeddingProviderService
    yield* provider.setModel(modelName)
  }
})


