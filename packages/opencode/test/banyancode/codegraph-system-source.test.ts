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
import { MAX_GUIDE_CHARS, REQUIRED_TOOLS } from "./tool-guide-constants"

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

  it.effect("load() with a graph state renders the Graph state line and no tool guide", () =>
    Effect.gen(function* () {
      const svc = yield* Banyan.CodegraphSystemSource
      const text = yield* svc.load({ tools: [], graph: { state: "ready", symbols: 1204 } })
      expect(text).toContain("Codegraph-first search policy")
      expect(text).toContain("Graph state: ready (1,204 symbols)")
      expect(text).not.toContain("BanyanCode tool guide")
    }),
  )

  it.effect("load() without a graph state renders no Graph state line", () =>
    Effect.gen(function* () {
      const svc = yield* Banyan.CodegraphSystemSource
      const text = yield* svc.load({})
      expect(text).toContain("Codegraph-first search policy")
      // The static policy mentions "Graph state is ready" (no colon); the
      // Phase A readiness line is the only "Graph state:" (colon) render.
      expect(text).not.toContain("Graph state:")
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

describe("BanyanCode tool guide — size budget (B1/B2)", () => {
  const it = testEffect(
    Layer.mergeAll(
      Banyan.CodegraphSystemSourceNS.defaultLayer,
      Skill.defaultLayer,
      FSUtil.defaultLayer,
      LocationServiceMap.layer,
    ),
  )

  // Realistic full-template descriptions (the "Use when / Examples / Returns /
  // Avoid when" boilerplate every Tool.make ships) for every REQUIRED tool —
  // the worst case the renderer sees in production.
  const realisticTools = (): Array<{ id: string; description: string }> =>
    REQUIRED_TOOLS.map((id) => ({
      id,
      description:
        `Use when: the agent needs to perform the ${id} operation against the current workspace. ` +
        `This is a longer-than-needed sentence that pads the description toward the pre-compaction length. ` +
        `Examples - "Do the ${id} thing", "Find where ${id} applies". ` +
        `Returns { mode, hits, details }. Avoid when the answer is already in context. ` +
        `After this, often: repository_query. Before this: nothing.`,
    }))

  it.effect("renders the full tool set under MAX_GUIDE_CHARS with one-line entries", () =>
    Effect.gen(function* () {
      const svc = yield* Banyan.CodegraphSystemSource
      const text = yield* svc.load({ tools: realisticTools() })

      const guideHeader = "## BanyanCode tool guide"
      const headerIndex = text.indexOf(guideHeader)
      expect(headerIndex).toBeGreaterThan(-1)
      const guide = text.slice(headerIndex + guideHeader.length)
      expect(guide.length).toBeLessThanOrEqual(MAX_GUIDE_CHARS)

      // Every required tool id is still present.
      for (const id of REQUIRED_TOOLS) expect(guide).toContain(id)
      // No entry exceeds the one-line limit: each line is the id + ≤140 chars.
      for (const line of guide.split("\n")) {
        if (!line.startsWith("- **")) continue
        const dash = line.indexOf("—")
        const hint = dash === -1 ? "" : line.slice(dash + 1).trim()
        expect(hint.length).toBeLessThanOrEqual(141)
      }
    }),
  )
})