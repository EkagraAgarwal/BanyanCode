export * as BanyanConfigService from "./banyan-config"

import { Context, Effect, Layer, Option, Schema } from "effect"
import { Global } from "@opencode-ai/core/global"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { EffectFlock } from "@opencode-ai/core/util/effect-flock"
import { BanyanConfig } from "../v1/config/banyan-config"
import path from "path"

export class Service extends Context.Service<Service, Interface>()("@banyancode/BanyanConfig") {}

export interface Interface {
  readonly get: (directory?: string) => Effect.Effect<BanyanConfig.Info, never, never>
  readonly getGlobal: () => Effect.Effect<BanyanConfig.Info, never, never>
  readonly update: (patch: Partial<BanyanConfig.Info>) => Effect.Effect<BanyanConfig.Info, never, never>
  readonly updateAgentOverride: (
    name: string,
    patch: {
      enabled?: boolean
      model?: { providerID: string; modelID: string } | null
      thinking?: string | null
      variant?: string | null
    },
  ) => Effect.Effect<BanyanConfig.Info, never, never>
  readonly getAgentOverrides: (directory?: string) => Effect.Effect<BanyanConfig.Info["agent"], never, never>
  readonly updateAgentPrompt: (name: string, prompt: string) => Effect.Effect<BanyanConfig.Info, never, never>
}

const configFile = path.join(Global.Path.banyan.config, "banyancode.json")

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const flock = yield* EffectFlock.Service

    // W1.3: mtime-invalidated read cache keyed by resolved project directory.
    // A stat per file is one syscall vs a full read + JSON decode, so cache
    // hits skip every read. Fingerprint covers mtime + size of all three
    // candidate files. Writes clear the cache via doWriteConfig (write-hook).
    const cache = new Map<string, { fingerprint: string; value: BanyanConfig.Info }>()
    const fingerprintOf = (info: { readonly mtime: Option.Option<Date>; readonly size: unknown } | undefined): string =>
      info ? `${Option.getOrElse(info.mtime, () => new Date(0)).getTime()}:${String(info.size)}` : "missing"

    const readConfig = Effect.fn("BanyanConfig.readConfig")(function* (directory?: string) {
      // W1.4: resolve the LOCAL banyancode.json from the instance/project
      // directory, not process.cwd(). In a multi-project server every project
      // would otherwise get the launcher's local config. Callers without
      // instance context omit the argument and keep the legacy cwd behavior.
      const dir = path.resolve(directory ?? process.cwd())
      const localPath = path.join(dir, "banyancode.json")
      const localDotPath = path.join(dir, ".banyancode", "banyancode.json")
      const stats = yield* Effect.all(
        [configFile, localPath, localDotPath].map((file) =>
          fs.stat(file).pipe(Effect.catch(() => Effect.succeed(undefined))),
        ),
      )
      const fingerprint = stats.map(fingerprintOf).join("|")
      const cached = cache.get(dir)
      if (cached && cached.fingerprint === fingerprint) return cached.value
      const text = yield* fs.readFileStringSafe(configFile)
      let globalConfig = {} as BanyanConfig.Info
      if (text) {
        globalConfig = yield* Schema.decodeEffect(Schema.fromJsonString(BanyanConfig.Info))(text).pipe(
          Effect.catch(() => Effect.succeed({} as BanyanConfig.Info)),
        )
      }
      let localText = yield* fs.readFileStringSafe(localPath)
      if (!localText) {
        localText = yield* fs.readFileStringSafe(localDotPath)
      }
      if (!localText) {
        cache.set(dir, { fingerprint, value: globalConfig })
        return globalConfig
      }
      const localConfig = yield* Schema.decodeEffect(Schema.fromJsonString(BanyanConfig.Info))(localText).pipe(
        Effect.catch(() => Effect.succeed({} as BanyanConfig.Info)),
      )
      const merged = { ...globalConfig, ...localConfig }
      cache.set(dir, { fingerprint, value: merged })
      return merged
    })

    const doWriteConfig = Effect.fn("BanyanConfig.doWriteConfig")(function* (config: BanyanConfig.Info) {
      yield* fs.writeWithDirs(configFile, JSON.stringify(config, null, 2)).pipe(Effect.orDie)
      cache.clear()
    })

    const get = Effect.fn("BanyanConfig.get")(function* (directory?: string) {
      return yield* readConfig(directory).pipe(
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

    const getAgentOverrides = Effect.fn("BanyanConfig.getAgentOverrides")(function* (directory?: string) {
      const config = yield* readConfig(directory).pipe(
        Effect.catch(() => Effect.succeed({} as BanyanConfig.Info)),
      )
      return config.agent
    })

    const updateAgentOverride = Effect.fn("BanyanConfig.updateAgentOverride")(
      function* (
        name: string,
        patch: { enabled?: boolean; model?: { providerID: string; modelID: string } | null; thinking?: string | null; variant?: string | null },
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
              // null clears the key (same as model above); undefined leaves it.
              const thinkingStr = patch.thinking === null ? undefined : (patch.thinking ?? existing.thinking)
              const variantStr = patch.variant === null ? undefined : (patch.variant ?? existing.variant)

              const updated = {
                ...existing,
                ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
                ...(patch.model !== undefined ? { model: modelStr } : {}),
                ...(patch.thinking !== undefined ? { thinking: thinkingStr } : {}),
                ...(patch.variant !== undefined ? { variant: variantStr } : {}),
              }

              if (updated.model === undefined) delete updated.model
              if (updated.enabled === undefined) delete updated.enabled
              if (updated.thinking === undefined) delete updated.thinking
              if (updated.variant === undefined) delete updated.variant

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
