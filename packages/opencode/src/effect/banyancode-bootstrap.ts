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
      const providerOpt = yield* Effect.serviceOption(Banyan.EmbeddingProviderService)
      if (providerOpt._tag === "Some") {
        yield* providerOpt.value.setModel(banyanConfig.banyancode_embedding_model)
      }
    }
  } else {
    const providerOpt = yield* Effect.serviceOption(Banyan.EmbeddingProviderService)
    if (providerOpt._tag === "Some") {
      yield* providerOpt.value.setModel(modelName)
    }
  }
})
