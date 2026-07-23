export * as BanyanConfigService from "./banyan-config"

import { Context, Effect, Layer, Schema } from "effect"
import { Global } from "@opencode-ai/core/global"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { EffectFlock } from "@opencode-ai/core/util/effect-flock"
import { BanyanConfig } from "../v1/config/banyan-config"
import path from "path"

export class Service extends Context.Service<Service, Interface>()("@banyancode/BanyanConfig") {}

export interface Interface {
  readonly get: () => Effect.Effect<BanyanConfig.Info, never, never>
  readonly getGlobal: () => Effect.Effect<BanyanConfig.Info, never, never>
  readonly update: (patch: Partial<BanyanConfig.Info>) => Effect.Effect<BanyanConfig.Info, never, never>
  readonly updateAgentOverride: (
    name: string,
    patch: { enabled?: boolean; model?: { providerID: string; modelID: string } | null },
  ) => Effect.Effect<BanyanConfig.Info, never, never>
  readonly getAgentOverrides: () => Effect.Effect<BanyanConfig.Info["agent"], never, never>
  readonly updateAgentPrompt: (name: string, prompt: string) => Effect.Effect<BanyanConfig.Info, never, never>
}

const configFile = path.join(Global.Path.banyan.config, "banyancode.json")

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const flock = yield* EffectFlock.Service

    const readConfig = Effect.fn("BanyanConfig.readConfig")(function* () {
      const text = yield* fs.readFileStringSafe(configFile)
      let globalConfig = {} as BanyanConfig.Info
      if (text) {
        globalConfig = yield* Schema.decodeEffect(Schema.fromJsonString(BanyanConfig.Info))(text).pipe(
          Effect.catch(() => Effect.succeed({} as BanyanConfig.Info)),
        )
      }
      const localPath = path.join(process.cwd(), "banyancode.json")
      const localDotPath = path.join(process.cwd(), ".banyancode", "banyancode.json")
      let localText = yield* fs.readFileStringSafe(localPath)
      if (!localText) {
        localText = yield* fs.readFileStringSafe(localDotPath)
      }
      if (!localText) return globalConfig
      const localConfig = yield* Schema.decodeEffect(Schema.fromJsonString(BanyanConfig.Info))(localText).pipe(
        Effect.catch(() => Effect.succeed({} as BanyanConfig.Info)),
      )
      return { ...globalConfig, ...localConfig }
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

    const getAgentOverrides = Effect.fn("BanyanConfig.getAgentOverrides")(function* () {
      const config = yield* readConfig().pipe(
        Effect.catch(() => Effect.succeed({} as BanyanConfig.Info)),
      )
      return config.agent
    })

    const updateAgentOverride = Effect.fn("BanyanConfig.updateAgentOverride")(
      function* (
        name: string,
        patch: { enabled?: boolean; model?: { providerID: string; modelID: string } | null },
      ) {
        return yield* flock
          .withLock(
            Effect.gen(function* () {
              const current = yield* readConfig().pipe(
                Effect.catch(() => Effect.succeed({} as BanyanConfig.Info)),
              )
              const agents = current.agent ?? {}
              const existing = agents[name] ?? {}

              let modelStr: string | undefined = existing.model
              if (patch.model === null) {
                modelStr = undefined
              } else if (patch.model !== undefined) {
                modelStr = `${patch.model.providerID}/${patch.model.modelID}`
              }

              const updated = {
                ...existing,
                ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
                ...(patch.model !== undefined || patch.model === null ? { model: modelStr } : {}),
              }

              if (updated.model === undefined) delete updated.model
              if (updated.enabled === undefined) delete updated.enabled

              const nextAgents = {
                ...agents,
                [name]: updated,
              }

              if (Object.keys(nextAgents[name]).length === 0) {
                delete nextAgents[name]
              }

              const merged: BanyanConfig.Info = {
                ...current,
                agent: nextAgents,
              }
              yield* doWriteConfig(merged)
              return merged
            }),
            `banyan-config:${configFile}`,
          )
          .pipe(Effect.orDie)
      },
    )

    const updateAgentPrompt = Effect.fn("BanyanConfig.updateAgentPrompt")(function* (name: string, prompt: string) {
      return yield* flock
        .withLock(
          Effect.gen(function* () {
            const current = yield* readConfig().pipe(
              Effect.catch(() => Effect.succeed({} as BanyanConfig.Info)),
            )
            const agents = current.agent ?? {}
            const existing = agents[name] ?? {}
            const updated = {
              ...existing,
              prompt,
            }
            const merged: BanyanConfig.Info = {
              ...current,
              agent: {
                ...agents,
                [name]: updated,
              },
            }
            yield* doWriteConfig(merged)
            return merged
          }),
          `banyan-config:${configFile}`,
        )
        .pipe(Effect.orDie)
    })

    return Service.of({ get, getGlobal, update, getAgentOverrides, updateAgentOverride, updateAgentPrompt })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(FSUtil.defaultLayer), Layer.provide(EffectFlock.defaultLayer))
