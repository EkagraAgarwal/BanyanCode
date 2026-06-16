export * as BanyanConfigService from "./banyan-config"

import { Context, Effect, Layer, Schema } from "effect"
import { Global } from "@opencode-ai/core/global"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { BanyanConfig } from "../v1/config/banyan-config"
import path from "path"

export class Service extends Context.Service<Service, Interface>()("@banyancode/BanyanConfig") {}

export interface Interface {
  readonly get: () => Effect.Effect<BanyanConfig.Info, never, never>
  readonly getGlobal: () => Effect.Effect<BanyanConfig.Info, never, never>
  readonly update: (patch: Partial<BanyanConfig.Info>) => Effect.Effect<BanyanConfig.Info, never, never>
}

const configFile = path.join(Global.Path.banyan.config, "banyancode.json")

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service

    const readConfig = Effect.fn("BanyanConfig.readConfig")(function* () {
      const text = yield* fs.readFileStringSafe(configFile)
      if (!text) return {} as BanyanConfig.Info
      return yield* Schema.decodeEffect(Schema.fromJsonString(BanyanConfig.Info))(text).pipe(
        Effect.catch(() => Effect.succeed({} as BanyanConfig.Info)),
      )
    })

    const doWriteConfig = Effect.fn("BanyanConfig.doWriteConfig")(function* (config: BanyanConfig.Info) {
      yield* fs.writeWithDirs(configFile, JSON.stringify(config, null, 2)).pipe(Effect.orDie)
    })

    const get = Effect.fn("BanyanConfig.get")(function* () {
      return yield* readConfig().pipe(
        Effect.catch(() => Effect.succeed({} as BanyanConfig.Info)),
      )
    })

    const getGlobal = Effect.fn("BanyanConfig.getGlobal")(function* () {
      return yield* readConfig().pipe(
        Effect.catch(() => Effect.succeed({} as BanyanConfig.Info)),
      )
    })

    const update = Effect.fn("BanyanConfig.update")(function* (patch: Partial<BanyanConfig.Info>) {
      const current = yield* readConfig().pipe(
        Effect.catch(() => Effect.succeed({} as BanyanConfig.Info)),
      )
      const merged: BanyanConfig.Info = Object.assign({}, current, patch)
      yield* doWriteConfig(merged)
      return merged
    })

    return Service.of({ get, getGlobal, update })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(FSUtil.defaultLayer))
