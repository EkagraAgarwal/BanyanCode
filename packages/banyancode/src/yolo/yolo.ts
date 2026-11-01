export * as Yolo from "./yolo.js"

import type { Context } from "@opencode/plugin/effect/plugin"
import { Effect, type Scope } from "effect"
import type { BanyanConfig } from "../config/index.js"
import type { Info } from "../config/schema.js"

// Port of v1 `Permission.ask`'s yolo short-circuit
// (`packages/opencode/src/permission/index.ts:83-87`): when yolo is enabled,
// every permission request is allowed before any rule evaluation. v1 offered no
// exceptions, including configured deny rules and "dangerous" asks.
//
// v2's permission service now delivers configured denies to this hook instead
// of returning before it (packages/core/src/permission.ts), so overriding
// `effect` here restores the v1 short-circuit. Organization policy is not
// weakened: ConfigPolicyPlugin registers after the built-ins and re-applies its
// deny, so a matching policy statement still wins.

export interface YoloDeps {
  readonly config: BanyanConfig.Interface
}

export const envYoloEnabled = (env: NodeJS.ProcessEnv = process.env): boolean =>
  /^(?:1|true|yes|on)$/i.test(env.BANYANCODE_YOLO_MODE ?? "")

export const yoloEnabled = (config: Info, env: NodeJS.ProcessEnv = process.env): boolean =>
  config.banyancode_yolo_mode === true || envYoloEnabled(env)

export const register = (ctx: Context, deps: YoloDeps): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function* () {
    yield* ctx.permission.hook("evaluate", (event) =>
      Effect.gen(function* () {
        const loaded = yield* deps.config.get()
        if (!yoloEnabled(loaded.config)) return
        event.effect = "allow"
        delete event.message
      }).pipe(Effect.catchCause(() => Effect.void)),
    )
  })
