import { run as runTui, type TuiInput } from "@opencode-ai/tui"
import { Global } from "@opencode-ai/core/global"
import * as Observability from "@opencode-ai/core/observability"
import { Effect, Layer } from "effect"

export function run(input: TuiInput) {
  return runTui(input).pipe(
    Effect.provide(Layer.merge(Global.defaultLayer, Observability.layer)),
  )
}