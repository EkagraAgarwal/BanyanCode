export * as MaxSubagents from "./max-subagents"

import { Context, Effect, Layer, Schema } from "effect"
import { BanyanConfigService } from "./banyan-config"
import { DEFAULT_MAX_SUBAGENTS, MAX_SUBAGENTS_LIMIT } from "../v1/config/banyan-config"

export interface Interface {
  readonly current: () => Effect.Effect<number, never>
  readonly validate: (value: number) => Effect.Effect<number, MaxSubagentsError>
  readonly withDefault: (value: number | undefined) => Effect.Effect<number, MaxSubagentsError>
}

export class Service extends Context.Service<Service, Interface>()("@banyancode/MaxSubagents") {}

export class MaxSubagentsError extends Schema.TaggedErrorClass<MaxSubagentsError>()("Banyan/MaxSubagentsError", {
  message: Schema.String,
  value: Schema.Number,
}) {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* BanyanConfigService.Service

    const current = Effect.fn("MaxSubagents.current")(function* () {
      const cfg = yield* config.get()
      return cfg.banyancode_max_subagents ?? DEFAULT_MAX_SUBAGENTS
    })

    const validate = Effect.fn("MaxSubagents.validate")(function* (value: number) {
      if (!Number.isInteger(value) || value < 1 || value > MAX_SUBAGENTS_LIMIT) {
        return yield* new MaxSubagentsError({
          message: `Max subagents must be between 1 and ${MAX_SUBAGENTS_LIMIT}`,
          value,
        })
      }
      return value
    })

    const withDefault = Effect.fn("MaxSubagents.withDefault")(function* (value: number | undefined) {
      if (value === undefined) return yield* current()
      return yield* validate(value)
    })

    return Service.of({ current, validate, withDefault })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(BanyanConfigService.defaultLayer))
