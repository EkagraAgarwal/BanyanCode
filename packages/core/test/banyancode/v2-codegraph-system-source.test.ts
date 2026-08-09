/**
 * V2 wiring tests for `CodegraphSystemSource.register` and
 * `CodegraphSystemSource.Service.load`.
 *
 * These tests exercise the source module against the real
 * `SystemContextRegistry.layer` (no mocks). The registry's
 * `register()` requires `Scope` in R, so the relevant tests provision a
 * scope with `Scope.make()` and route the call through `Scope.provide`.
 */

process.env.BANYANCODE_ENABLE = "1"

import { describe, expect } from "bun:test"
import { Effect, Layer, Scope } from "effect"
import { AgentV2 } from "@opencode-ai/core/agent"
import * as CodegraphSystemSource from "@opencode-ai/core/banyancode/codegraph-system-source"
import { LocationServiceMap } from "@opencode-ai/core/location-layer"
import { SystemContext } from "@opencode-ai/core/system-context"
import { SystemContextRegistry } from "@opencode-ai/core/system-context/registry"
import { testEffect } from "../lib/effect"

const it = testEffect(
  Layer.mergeAll(
    SystemContextRegistry.layer,
    CodegraphSystemSource.defaultLayer,
    AgentV2.locationLayer,
    LocationServiceMap.layer,
  ),
)

describe("CodegraphSystemSource.register (V2 wiring)", () => {
  it.effect(
    "register() adds the policy entry to the registry; load() emits the policy header",
    () =>
      Effect.gen(function* () {
        const registry = yield* SystemContextRegistry.Service
        // Drive register inside a Scope so the acquireRelease entry
        // finalizer can attach. The source's register() returns an Effect
        // that requires Scope in R; Scope.provide routes the explicit
        // scope to it.
        const scope = yield* Scope.make()
        yield* CodegraphSystemSource.register(registry).pipe(Scope.provide(scope))

        const context = yield* registry.load()
        const initialized = yield* SystemContext.initialize(context)
        expect(initialized.baseline).toContain("Codegraph-first search policy")
        expect(initialized.baseline).toContain("ALWAYS")
        expect(initialized.baseline).toContain("codegraph_build")
        expect(initialized.baseline).toContain("last resort")
        expect(initialized.baseline.length).toBeGreaterThan(0)
        // The snapshot must carry the namespaced key the source uses.
        expect(initialized.snapshot["banyancode/codegraph-policy"]).toBeDefined()
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
          // register() short-circuits via `banyancodeEnabled()`; it must
          // not acquire a finalizer or insert anything.
          const scope = yield* Scope.make()
          yield* CodegraphSystemSource.register(registry).pipe(Scope.provide(scope))

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

describe("CodegraphSystemSource.Service.load (V2 rendering)", () => {
  it.effect("load({ tools: [...] }) emits the catalog section and the tool description", () =>
    Effect.gen(function* () {
      const svc = yield* CodegraphSystemSource.Service
      const text = yield* svc.load({
        tools: [
          { id: "code_find", description: "Look up a symbol or file in the code graph" },
        ],
      })
      expect(text).toContain("BanyanCode tool guide")
      expect(text).toContain("Look up a symbol or file in the code graph")
      expect(text).toContain("`code_find`")
    }),
  )

  it.effect("load() is stable across repeated calls with the same input", () =>
    Effect.gen(function* () {
      const svc = yield* CodegraphSystemSource.Service
      const tools = [{ id: "code_find", description: "find a symbol" }]
      const first = yield* svc.load({ tools })
      const second = yield* svc.load({ tools })
      expect(first).toBe(second)
    }),
  )

  it.effect(
    "rendered guide lists the graph/repo tool ids, drops the Hot tool catalog, and POLICY_TEXT no longer ships the background-subagent section",
    () =>
      Effect.gen(function* () {
        const svc = yield* CodegraphSystemSource.Service
        const text = yield* svc.load({
          tools: [
            {
              id: "code_find",
              description:
                "Top-level symbol locator across the codebase graph. Routes to the right tool based on the intent you pass.",
            },
            {
              id: "repository_query",
              description:
                "Semantic repository search. Top-level entry point for high-level questions about a codebase.",
            },
            { id: "banyan_repo_map", description: "Token-budgeted outline of the workspace. Use this before reading files." },
            { id: "banyan_tool_search", description: "Search the adapted tool catalog." },
            {
              id: "blast_radius",
              description:
                "Use when: a lightweight, count-only blast-radius read of a symbol — direct + transitive dependents, files touched, tests referencing the target by name/import OR living in the caller file set, and a single-word risk verdict.",
            },
          ],
        })
        // Guide ids render in bold; the full ids are also asserted.
        expect(text).toContain("**code_find**")
        expect(text).toContain("**repository_query**")
        expect(text).toContain("**banyan_repo_map**")
        expect(text).toContain("**banyan_tool_search**")
        // The duplicate "Hot tool catalog" section was deleted.
        expect(text).not.toContain("Hot tool catalog")
        // Only the first sentence of each description is rendered.
        expect(text).toContain("Top-level symbol locator across the codebase graph.")
        expect(text).not.toContain("Routes to the right tool based on the intent you pass.")
        // Long first sentences are truncated with an ellipsis.
        expect(text).toContain("…")
        // The background-subagent section moved to the orchestration block.
        expect(text).not.toContain("Background subagents (ALWAYS)")
        expect(CodegraphSystemSource.POLICY_TEXT).not.toContain("Background subagents (ALWAYS)")
      }),
  )

  it.effect("load() output matches the graph-first / repository-first policy header", () =>
    Effect.gen(function* () {
      const svc = yield* CodegraphSystemSource.Service
      const text = yield* svc.load({ tools: [{ id: "code_find", description: "find a symbol" }] })
      expect(text).toMatch(/graph.{0,3}first|repository.{0,3}first/i)
    }),
  )
})