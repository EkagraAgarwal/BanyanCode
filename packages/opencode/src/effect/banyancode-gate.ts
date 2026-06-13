export * as BanyanGate from "./banyancode-gate"

import { Effect } from "effect"
import { RuntimeFlags } from "@/effect/runtime-flags"

export const enabled = Effect.gen(function* () {
  const flags = yield* RuntimeFlags.Service
  return flags.banyancodeEnable
})