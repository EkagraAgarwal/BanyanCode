import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { SystemPrompt } from "@/session/system"
import { Skill } from "@/skill"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Flag } from "@opencode-ai/core/flag/flag"
import { LocationServiceMap } from "@opencode-ai/core/location-layer"
import { testEffect } from "../lib/effect"

const it = testEffect(
  Layer.mergeAll(
    SystemPrompt.defaultLayer,
    Skill.defaultLayer,
    FSUtil.defaultLayer,
    LocationServiceMap.layer,
  ),
)

describe("PR C: SystemPrompt.codegraph auto-tools policy", () => {
  it.effect("returns undefined when BanyanCode is disabled", () =>
    Effect.gen(function* () {
      const svc = yield* SystemPrompt.Service
      const original = process.env.BANYANCODE_ENABLE
      process.env.BANYANCODE_ENABLE = "0"
      try {
        const block = yield* svc.codegraph()
        expect(block).toBeUndefined()
      } finally {
        if (original === undefined) delete process.env.BANYANCODE_ENABLE
        else process.env.BANYANCODE_ENABLE = original
      }
    }),
  )

  it.effect("returns the codegraph block when BanyanCode is enabled", () =>
    Effect.gen(function* () {
      const svc = yield* SystemPrompt.Service
      const original = process.env.BANYANCODE_ENABLE
      delete process.env.BANYANCODE_ENABLE
      try {
        const block = yield* svc.codegraph()
        expect(block).toBeDefined()
        expect(block).toContain("codegraph")
        expect(block).toContain("code_find")
        expect(block).toContain("repository_query")
      } finally {
        if (original === undefined) delete process.env.BANYANCODE_ENABLE
        else process.env.BANYANCODE_ENABLE = original
      }
    }),
  )
})