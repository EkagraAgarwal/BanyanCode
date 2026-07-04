import { Context, Effect, Layer } from "effect"
import { CodegraphRepo } from "../codegraph-repo"
import { Service, makeService, type Interface, type SearchMode, type SearchOptions, type SearchResult } from "./search"

export { Service, type Interface } from "./search"

const makeSearchService = Effect.gen(function* () {
  const repo = yield* CodegraphRepo.Service
  return makeService(repo)
})

export const layer = Layer.effect(Service, makeSearchService)

export const defaultLayer = Layer.effect(Service, makeSearchService).pipe(
  Layer.provide(CodegraphRepo.defaultLayer),
)

export const auto = (
  query: string,
  opts?: Omit<SearchOptions, "mode" | "manualMode" | "modes">,
): Effect.Effect<SearchResult[], never, Service> =>
  Effect.gen(function* () {
    const svc = yield* Service
    return yield* svc.search(query, { ...opts, mode: "auto" })
  })

export const manual = (
  query: string,
  manualMode: SearchMode,
  opts?: Omit<SearchOptions, "mode" | "manualMode" | "modes">,
): Effect.Effect<SearchResult[], never, Service> =>
  Effect.gen(function* () {
    const svc = yield* Service
    return yield* svc.search(query, { ...opts, mode: "manual", manualMode })
  })
