import { Context, Effect, Layer } from "effect"
import { empty, load, summarize, type LoadInput, type Loaded, type Summary } from "./loader.js"

export class Service extends Context.Service<Service, Interface>()("@banyancode/Config") {}

export interface Interface {
  /**
   * Reads and validates `banyancode.json[c]` from the global and project
   * scopes. Cheap enough to read fresh on every call; the plugin has no
   * watcher yet, so there is nothing stale to reload.
   */
  readonly get: () => Effect.Effect<Loaded>
  readonly summary: () => Effect.Effect<Summary>
}

export const make = (input: LoadInput): Interface => ({
  get: () =>
    Effect.promise(() => load(input)).pipe(
      Effect.catchCause(() => Effect.succeed(empty())),
    ),
  summary: () =>
    Effect.promise(() => load(input)).pipe(
      Effect.map(summarize),
      Effect.catchCause(() => Effect.succeed(summarize(empty()))),
    ),
})

export const layer = (input: LoadInput) => Layer.succeed(Service, Service.of(make(input)))
