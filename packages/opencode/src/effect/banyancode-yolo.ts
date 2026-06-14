import { Context, Effect, Layer, Ref } from "effect"

export interface YoloModeInterface {
  readonly get: () => Effect.Effect<boolean>
  readonly set: (value: boolean) => Effect.Effect<void>
}

export class YoloModeService extends Context.Service<YoloModeService, YoloModeInterface>()("@opencode/YoloMode") {}

const configLayer = Layer.succeed(
  class extends Context.Service<YoloModeService>()("@opencode/YoloMode") {},
  YoloModeService.of({ get: () => Effect.succeed(false), set: () => Effect.void }),
)

export const defaultLayer = Layer.effect(
  YoloModeService,
  Effect.gen(function* () {
    const yoloModeRef = yield* Ref.make(false)

    const get = Effect.fn("YoloMode.get")(function* () {
      return yield* Ref.get(yoloModeRef)
    })

    const set = Effect.fn("YoloMode.set")(function* (value: boolean) {
      yield* Ref.set(yoloModeRef, value)
    })

    return YoloModeService.of({ get, set })
  }),
)

export * as YoloMode from "./banyancode-yolo"
