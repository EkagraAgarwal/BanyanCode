import { Context, Effect, Layer } from "effect"
import { CodegraphRepo } from "../codegraph-repo"
import { Service, makeService, type Interface } from "./search"

export { Service, type Interface } from "./search"

const makeSearchService = Effect.gen(function* () {
  const repo = yield* CodegraphRepo.Service
  return makeService(repo)
})

export const layer = Layer.effect(Service, makeSearchService)

export const defaultLayer = Layer.effect(Service, makeSearchService).pipe(
  Layer.provide(CodegraphRepo.defaultLayer),
)
