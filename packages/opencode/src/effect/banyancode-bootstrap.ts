import { Effect } from "effect"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Banyan } from "@opencode-ai/core/banyancode"

export const applyEmbeddingModel = Effect.gen(function* () {
  const flags = yield* RuntimeFlags.Service
  if (!flags.banyancodeEnable) return

  const providerOpt = yield* Effect.serviceOption(Banyan.EmbeddingProviderService)
  if (providerOpt._tag === "None") return

  const modelName = flags.banyancodeEmbeddingModel
  if (modelName) {
    yield* providerOpt.value.setModel(modelName)
    return
  }

  const banyanConfig = yield* Banyan.BanyanConfigService.use((svc) => svc.get())
  if (banyanConfig.banyancode_embedding_model) {
    yield* providerOpt.value.setModel(banyanConfig.banyancode_embedding_model)
  }
})
