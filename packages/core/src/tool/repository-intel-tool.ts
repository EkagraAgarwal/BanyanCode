export * as RepositoryIntelTool from "./repository-intel-tool"

import { Effect, Layer } from "effect"
import { defaultLayer as repositoryIntelligenceLayer } from "../banyancode/repository-intelligence"

const banyancodeEnabled = () => process.env.BANYANCODE_ENABLE !== "0"

export const locationLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    if (!banyancodeEnabled()) return
  }),
).pipe(Layer.provide(repositoryIntelligenceLayer))