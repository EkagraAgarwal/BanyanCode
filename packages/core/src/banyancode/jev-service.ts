export * as JevService from "./jev-service"

import { Context, Effect, Layer, Option } from "effect"
import { Jev } from "./jev"
import { Service as BanyanConfigService } from "./banyan-config"

// Consumer-level Effect adapter over the promise-based Jev client. Provide at
// the consumer node; never mount globally. Falls back to {} config without
// BanyanConfigService in scope. All methods are infallible: branch on `ok`.

export interface Interface {
  readonly ask: (input: Jev.AskInput) => Effect.Effect<Jev.AskResult, never, never>
  readonly decide: (input: Jev.DecideInput) => Effect.Effect<Jev.DecideResult, never, never>
  readonly feature: (name: string) => Effect.Effect<boolean, never, never>
  readonly usage: (sessionID: string) => Effect.Effect<Jev.UsageSnapshot, never, never>
}

export class Service extends Context.Service<Service, Interface>()("@banyancode/JevService") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const option = yield* Effect.serviceOption(BanyanConfigService)
    const serviceConfig = Option.isSome(option) ? yield* option.value.get() : ({} as Jev.Config)

    return Service.of({
      ask: (input) => Effect.promise(() => Jev.ask({ ...input, config: input.config ?? serviceConfig })),
      decide: (input) => Effect.promise(() => Jev.decide({ ...input, config: input.config ?? serviceConfig })),
      feature: (name) => Effect.sync(() => Jev.feature(serviceConfig, process.env, name)),
      usage: (sessionID) => Effect.sync(() => Jev.usage(sessionID)),
    })
  }),
)
