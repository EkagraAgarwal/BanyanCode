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
  readonly getAgentOverrides: () => Effect.Effect<BanyanConfig.Info["banyancode_agent_overrides"], never, never>
}

const configFile = path.join(Global.Path.banyan.config, "banyancode.json")

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const flock = yield* EffectFlock.Service

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

    const getAgentOverrides = Effect.fn("BanyanConfig.getAgentOverrides")(function* () {
      const config = yield* readConfig().pipe(
        Effect.catch(() => Effect.succeed({} as BanyanConfig.Info)),
      )
      return config.banyancode_agent_overrides ?? []
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
              const overrides = current.banyancode_agent_overrides ?? []
              const idx = overrides.findIndex((o) => o.name === name)

              if (patch.model === null) {
                // Clear model from existing override, preserving enabled
                if (idx >= 0) {
                  const existing = overrides[idx]
                  const updated = {
                    ...existing,
                    model: undefined,
                    enabled: patch.enabled !== undefined ? patch.enabled : existing.enabled,
                  }
                  const newOverrides = [...overrides]
                  newOverrides[idx] = updated
                  const merged: BanyanConfig.Info = Object.assign({}, current, {
                    banyancode_agent_overrides: newOverrides,
                  })
                  yield* doWriteConfig(merged)
                  return merged
                }
                // Entry doesn't exist, nothing to clear
                return current
              }

              if (patch.enabled === undefined && patch.model === undefined) {
                return current
              }

              if (idx >= 0) {
                const existing = overrides[idx]
                const updated: (typeof overrides)[number] = {
                  ...existing,
                  ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
                  ...(patch.model !== undefined ? { model: patch.model } : {}),
                }
                const newOverrides = [...overrides]
                newOverrides[idx] = updated
                const merged: BanyanConfig.Info = Object.assign({}, current, {
                  banyancode_agent_overrides: newOverrides,
                })
                yield* doWriteConfig(merged)
                return merged
              }

              // Append new entry
              const newEntry: (typeof overrides)[number] = {
                name,
                ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
                ...(patch.model !== undefined ? { model: patch.model } : {}),
              }
              const merged: BanyanConfig.Info = Object.assign({}, current, {
                banyancode_agent_overrides: [...overrides, newEntry],
              })
              yield* doWriteConfig(merged)
              return merged
            }),
            `banyan-config:${configFile}`,
          )
          .pipe(Effect.orDie)
      },
    )

    return Service.of({ get, getGlobal, update, getAgentOverrides, updateAgentOverride })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(FSUtil.defaultLayer), Layer.provide(EffectFlock.defaultLayer))
