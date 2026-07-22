/**
 * Direct unit tests for `Banyan.CodegraphSystemSource`.
 *
 * These tests bypass the V1 `SystemPrompt.codegraph()` delegate and drive the
 * source module directly. They cover:
 *   - service.load({ tools }) rendering shape (with / without tools)
 *   - the policy header regex
 *   - call-to-call stability (load() is idempotent)
 *   - the env-disabled path is harmless to invoke
 *   - V1 delegate (SystemPrompt.codegraph) returns undefined when disabled
 */

process.env.BANYANCODE_ENABLE = "1"

import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Banyan } from "@opencode-ai/core/banyancode"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { LocationServiceMap } from "@opencode-ai/core/location-layer"
import { SystemPrompt } from "@/session/system"
import { Skill } from "@/skill"
import { testEffect } from "../lib/effect"

const it = testEffect(
  Layer.mergeAll(
    Banyan.CodegraphSystemSourceNS.defaultLayer,
    SystemPrompt.defaultLayer,
    Skill.defaultLayer,
    FSUtil.defaultLayer,
    LocationServiceMap.layer,
  ),
)

describe("Banyan.CodegraphSystemSource.Service", () => {
  it.effect("load({ tools: [] }) returns POLICY_TEXT without a tool guide", () =>
    Effect.gen(function* () {
      const svc = yield* Banyan.CodegraphSystemSource
      const text = yield* svc.load({ tools: [] })
      expect(text).toContain("Codegraph-first search policy")
      expect(text).not.toContain("BanyanCode tool guide")
    }),
  )

  it.effect("load() with input undefined returns POLICY_TEXT without a tool guide", () =>
    Effect.gen(function* () {
      const svc = yield* Banyan.CodegraphSystemSource
      const text = yield* svc.load()
      expect(text).toContain("Codegraph-first search policy")
      expect(text).not.toContain("BanyanCode tool guide")
    }),
  )

  it.effect(
    "load({ tools }) with a partial list renders the catalog and filters non-Banyan ids",
    () =>
      Effect.gen(function* () {
        const svc = yield* Banyan.CodegraphSystemSource
        const text = yield* svc.load({
          tools: [
            { id: "code_find", description: "Look up a symbol or file in the code graph" },
            { id: "codegraph_query", description: "internal — should be filtered out" },
            { id: "websearch", description: "not a banyan id — should be filtered out" },
          ],
        })
        expect(text).toContain("BanyanCode tool guide")
        expect(text).toContain("Look up a symbol or file in the code graph")
        expect(text).toContain("`code_find`")
        // forbidden / non-banyan ids must not appear in the rendered catalog
        expect(text).not.toContain("internal — should be filtered out")
        expect(text).not.toContain("not a banyan id — should be filtered out")
      }),
  )

  it.effect("load() is stable across repeated calls", () =>
    Effect.gen(function* () {
      const svc = yield* Banyan.CodegraphSystemSource
      const first = yield* svc.load({ tools: [{ id: "code_find", description: "find a symbol" }] })
      const second = yield* svc.load({ tools: [{ id: "code_find", description: "find a symbol" }] })
      expect(first).toBe(second)
    }),
  )

  it.effect("load() output matches the graph-first / repository-first policy header", () =>
    Effect.gen(function* () {
      const svc = yield* Banyan.CodegraphSystemSource
      const text = yield* svc.load({ tools: [{ id: "code_find", description: "find a symbol" }] })
      expect(text).toMatch(/graph.{0,3}first|repository.{0,3}first/i)
      // Pin the strengthened policy: must always-bootstrap and always-prioritize
      expect(text).toContain("ALWAYS")
      expect(text).toContain("codegraph_build")
      expect(text).toContain("last resort")
    }),
  )

  it.effect("load() is harmless when BANYANCODE_ENABLE=0 (load itself does not gate)", () =>
    Effect.gen(function* () {
      const original = process.env.BANYANCODE_ENABLE
      process.env.BANYANCODE_ENABLE = "0"
      try {
        const svc = yield* Banyan.CodegraphSystemSource
        expect(typeof svc.load).toBe("function")
        // load() does not gate on the env var; only the registry-side
        // register() does. POLICY_TEXT remains accessible.
        const text = yield* svc.load()
        expect(text).toContain("Codegraph-first search policy")
      } finally {
        if (original === undefined) delete process.env.BANYANCODE_ENABLE
        else process.env.BANYANCODE_ENABLE = original
      }
    }),
  )

  it.effect("V1 SystemPrompt.codegraph returns undefined when BanyanCode is disabled", () =>
    Effect.gen(function* () {
      const original = process.env.BANYANCODE_ENABLE
      process.env.BANYANCODE_ENABLE = "0"
      try {
        const systemPrompt = yield* SystemPrompt.Service
        const block = yield* systemPrompt.codegraph()
        expect(block).toBeUndefined()
      } finally {
        if (original === undefined) delete process.env.BANYANCODE_ENABLE
        else process.env.BANYANCODE_ENABLE = original
      }
    }),
  )
})