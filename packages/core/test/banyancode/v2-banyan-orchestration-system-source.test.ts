/**
 * V2 wiring tests for `BanyanOrchestrationSystemSource.register` and
 * `BanyanOrchestrationSystemSource.Service.load`.
 *
 * The orchestration source ships the same policy the V1
 * `SystemPrompt.banyan()` block renders (delegation gate, mode fan-out,
 * mesh discipline, context handoff, action-driven mesh communication,
 * serialized heavy verification) as a static SystemContext entry keyed
 * `banyancode/orchestration`.
 */

process.env.BANYANCODE_ENABLE = "1"

import { describe, expect } from "bun:test"
import { Effect, Layer, Scope } from "effect"
import * as Orchestration from "@opencode-ai/core/banyancode/banyan-orchestration-system-source"
import { SystemContext } from "@opencode-ai/core/system-context"
import { SystemContextRegistry } from "@opencode-ai/core/system-context/registry"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(SystemContextRegistry.layer, Orchestration.defaultLayer))

describe("BanyanOrchestrationSystemSource.register (V2 wiring)", () => {
  it.effect(
    "register() adds the orchestration entry; load() emits the delegation gate header",
    () =>
      Effect.gen(function* () {
        const registry = yield* SystemContextRegistry.Service
        const scope = yield* Scope.make()
        yield* Orchestration.register(registry).pipe(Scope.provide(scope))

        const context = yield* registry.load()
        const initialized = yield* SystemContext.initialize(context)
        expect(initialized.baseline).toContain("Delegation gate (ALWAYS)")
        expect(initialized.baseline).toContain("BanyanCode orchestration (ALWAYS)")
        expect(initialized.baseline).toContain("Mode fan-out policy")
        expect(initialized.snapshot["banyancode/orchestration"]).toBeDefined()
      }),
  )

  it.effect(
    "register() is a no-op when BANYANCODE_ENABLE=0 (registry stays empty)",
    () =>
      Effect.gen(function* () {
        const original = process.env.BANYANCODE_ENABLE
        process.env.BANYANCODE_ENABLE = "0"
        try {
          const registry = yield* SystemContextRegistry.Service
          const scope = yield* Scope.make()
          yield* Orchestration.register(registry).pipe(Scope.provide(scope))

          const context = yield* registry.load()
          const initialized = yield* SystemContext.initialize(context)
          expect(initialized.baseline).toBe("")
          expect(Object.keys(initialized.snapshot)).toEqual([])
        } finally {
          if (original === undefined) delete process.env.BANYANCODE_ENABLE
          else process.env.BANYANCODE_ENABLE = original
        }
      }),
  )
})

describe("BanyanOrchestrationSystemSource policy content", () => {
  it.effect("ORCHESTRATION_TEXT carries the new policy sections", () =>
    Effect.gen(function* () {
      const text = Orchestration.ORCHESTRATION_TEXT
      expect(text).toContain("Context handoff (when spawning children)")
      expect(text).toContain("Action-driven mesh communication")
      expect(text).toContain("Serialized heavy verification (RAM budget)")
      expect(text).toContain("typecheck:in-progress")
       expect(text).toContain("Delegation is the default for independent substantial work, not a quota")
       expect(text).toContain("Children do not inherit the lead's conversation or tool results")
       expect(text).toContain("request a reviewer verdict")
      expect(text).toContain("the cap is 5")
      expect(text).toContain("shared_memory")
      expect(text).toContain("inherited to the root session")
      // The repository-intelligence section lives in POLICY_TEXT
      // (banyancode/codegraph-policy), not in the orchestration text —
      // the two sources are registered side-by-side and must not
      // duplicate each other.
      expect(text).not.toContain("Repository intelligence is the canonical interface")
    }),
  )

  it.effect("load() returns the static text", () =>
    Effect.gen(function* () {
      const svc = yield* Orchestration.Service
      const first = yield* svc.load()
      const second = yield* svc.load()
      expect(first).toBe(Orchestration.ORCHESTRATION_TEXT)
      expect(second).toBe(first)
    }),
  )
})
