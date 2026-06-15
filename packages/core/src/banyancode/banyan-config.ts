export * as BanyanConfigService from "./banyan-config"

import { Context, Effect, Layer } from "effect"
import { BanyanConfig } from "../v1/config/banyan-config"

export class Service extends Context.Service<Service, Interface>()("@banyancode/BanyanConfig") {}

export interface Interface {
  readonly get: () => Effect.Effect<BanyanConfig.Info, never, never>
  readonly getGlobal: () => Effect.Effect<BanyanConfig.Info, never, never>
  readonly update: (patch: Partial<BanyanConfig.Info>) => Effect.Effect<BanyanConfig.Info, never, never>
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const get = (): Effect.Effect<BanyanConfig.Info, never, never> => Effect.succeed({} as BanyanConfig.Info)
    const getGlobal = (): Effect.Effect<BanyanConfig.Info, never, never> => Effect.succeed({} as BanyanConfig.Info)
    const update = (_: Partial<BanyanConfig.Info>): Effect.Effect<BanyanConfig.Info, never, never> => Effect.succeed({} as BanyanConfig.Info)
    return Service.of({ get, getGlobal, update })
  }),
)

export const defaultLayer = layer
