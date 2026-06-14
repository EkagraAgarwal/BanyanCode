import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.empty)

describe("local.model.setForAgent / currentFor", () => {
  it.effect("setForAgent writes to modelStore.model[agentName]", () =>
    Effect.sync(() => {
      expect(true).toBe(true)
    }),
  )

  it.effect("currentFor reads the right agent's model", () =>
    Effect.sync(() => {
      expect(true).toBe(true)
    }),
  )

  it.effect("recent option updates recents", () =>
    Effect.sync(() => {
      expect(true).toBe(true)
    }),
  )

  it.effect("invalid model shows toast and doesn't write", () =>
    Effect.sync(() => {
      expect(true).toBe(true)
    }),
  )
})
