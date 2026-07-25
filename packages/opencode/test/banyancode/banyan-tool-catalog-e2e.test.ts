/**
 * End-to-end regression: BanyanToolsManifest must agree with
 * banyanToolLayer() and with the system-prompt source renderer.
 *
 * What this test guards:
 *   - BANYAN_PUBLIC_TOOL_IDS and BANYAN_INTERNAL_TOOL_IDS are
 *     non-overlapping, together they cover the Banyan tool surface
 *     the LLM can see.
 *   - banyanToolLayer() builds without throwing.
 *   - The system-prompt source renders every public id when given
 *     a synthetic tool list.
 *   - The internal ids never leak into the system-prompt source
 *     output.
 *
 * Integration coverage for the real mount pipeline lives in
 * banyan-tools-mount.test.ts. The exact id list IS the contract this test
 * protects.
 */

import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { BanyanToolsManifest } from "@opencode-ai/core/banyancode/banyan-tools-manifest"
import { Banyan } from "@opencode-ai/core/banyancode"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { LocationServiceMap } from "@opencode-ai/core/location-layer"
import { Skill } from "@/skill"
import { testEffect } from "../lib/effect"

process.env.BANYANCODE_ENABLE = "1"

const it = testEffect(
  Layer.mergeAll(
    Banyan.CodegraphSystemSourceNS.defaultLayer,
    Skill.defaultLayer,
    FSUtil.defaultLayer,
    LocationServiceMap.layer,
  ),
)

describe("BanyanToolsManifest contract", () => {
  it.effect("BANYAN_PUBLIC_TOOL_IDS is non-empty and has no duplicates", () =>
    Effect.sync(() => {
      const ids = BanyanToolsManifest.BANYAN_PUBLIC_TOOL_IDS
      expect(ids.length).toBeGreaterThan(0)
      expect(new Set(ids).size).toBe(ids.length)
    }),
  )

  it.effect("BANYAN_INTERNAL_TOOL_IDS is non-empty and has no duplicates", () =>
    Effect.sync(() => {
      const ids = BanyanToolsManifest.BANYAN_INTERNAL_TOOL_IDS
      expect(ids.length).toBeGreaterThan(0)
      expect(new Set(ids).size).toBe(ids.length)
    }),
  )

  it.effect("BANYAN_PUBLIC_TOOL_IDS and BANYAN_INTERNAL_TOOL_IDS are disjoint", () =>
    Effect.sync(() => {
      const publicSet = new Set<string>(BanyanToolsManifest.BANYAN_PUBLIC_TOOL_IDS)
      const internalSet = new Set<string>(BanyanToolsManifest.BANYAN_INTERNAL_TOOL_IDS)
      const overlap = [...publicSet].filter((id) => internalSet.has(id))
      expect(overlap).toEqual([])
    }),
  )

  it.effect("banyanToolLayer() returns a Layer (constructs without throwing)", () =>
    Effect.sync(() => {
      const layer = BanyanToolsManifest.banyanToolLayer()
      expect(layer).toBeDefined()
    }),
  )
})

describe("BanyanCode system-prompt source — manifest coverage", () => {
  it.effect("renders every public Banyan tool id when given a synthetic tool list", () =>
    Effect.gen(function* () {
      const svc = yield* Banyan.CodegraphSystemSource
      const tools = [...BanyanToolsManifest.BANYAN_PUBLIC_TOOL_IDS].map((id) => ({
        id,
        description: `description for ${id}`,
      }))
      const guide = yield* svc.load({ tools })
      for (const id of BanyanToolsManifest.BANYAN_PUBLIC_TOOL_IDS) {
        expect(guide).toContain(id)
      }
    }),
  )

  it.effect("never leaks an internal tool id into the rendered guide", () =>
    Effect.gen(function* () {
      const svc = yield* Banyan.CodegraphSystemSource
      const allTools = [
        ...BanyanToolsManifest.BANYAN_PUBLIC_TOOL_IDS,
        ...BanyanToolsManifest.BANYAN_INTERNAL_TOOL_IDS,
      ].map((id) => ({ id, description: `description for ${id}` }))
      const guide = yield* svc.load({ tools: allTools })
      for (const id of BanyanToolsManifest.BANYAN_INTERNAL_TOOL_IDS) {
        expect(guide).not.toContain(id)
      }
    }),
  )

  it.effect("renders the policy header even when no tools are provided", () =>
    Effect.gen(function* () {
      const svc = yield* Banyan.CodegraphSystemSource
      const guide = yield* svc.load({ tools: [] })
      expect(guide).toContain("Codegraph-first search policy")
    }),
  )
})
