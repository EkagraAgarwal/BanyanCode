/**
 * Per-agent × model matrix regression guard for the BanyanCode tool guide.
 *
 * Verifies the contract between the tool registry (which decides model
 * strength) and the `Banyan.CodegraphSystemSource` renderer (which renders
 * the visible catalog):
 *
 *   - REQUIRED tools (public LLM-facing ids) MUST appear in the rendered
 *     guide regardless of agent or model.
 *   - FORBIDDEN tools (internal helpers, never visible to the model) MUST
 *     NOT appear — the source filters them by the `BANYAN_TOOL_IDS`
 *     allowlist.
 *   - ADVANCED tools (strong-model-only) MUST NOT appear when the upstream
 *     consumer passes only public tools (the simulation for weak models).
 *     They are ALSO filtered by the source's allowlist if passed in, so the
 *     strong-model pass uses a full synthetic list to confirm both layers.
 */

process.env.BANYANCODE_ENABLE = "1"

import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Banyan } from "@opencode-ai/core/banyancode"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { LocationServiceMap } from "@opencode-ai/core/location-layer"
import { Skill } from "@/skill"
import { testEffect } from "../lib/effect"
import {
  ADVANCED_TOOLS,
  BUILTIN_AGENT_NAMES,
  FORBIDDEN_TOOLS,
  REQUIRED_TOOLS,
  STRONG_MODEL_IDS,
  WEAK_MODEL_IDS,
} from "./tool-guide-constants"

const it = testEffect(
  Layer.mergeAll(
    Banyan.CodegraphSystemSourceNS.defaultLayer,
    Skill.defaultLayer,
    FSUtil.defaultLayer,
    LocationServiceMap.layer,
  ),
)

const allSyntheticTools = (): Array<{ id: string; description: string }> =>
  [...REQUIRED_TOOLS, ...FORBIDDEN_TOOLS, ...ADVANCED_TOOLS].map((id) => ({
    id,
    description: `description for ${id}`,
  }))

const publicOnlyTools = (): Array<{ id: string; description: string }> =>
  REQUIRED_TOOLS.map((id) => ({ id, description: `description for ${id}` }))

describe("BanyanCode tool guide — per-agent x model matrix", () => {
  for (const agentName of BUILTIN_AGENT_NAMES) {
    for (const modelID of STRONG_MODEL_IDS) {
      it.effect(
        `agent=${agentName} model=${modelID} (strong): required visible, forbidden/advanced filtered`,
        () =>
          Effect.gen(function* () {
            const svc = yield* Banyan.CodegraphSystemSource
            const guide = yield* svc.load({ tools: allSyntheticTools() })

            for (const t of REQUIRED_TOOLS) {
              expect(guide).toContain(t)
            }
            for (const t of FORBIDDEN_TOOLS) {
              expect(guide).not.toContain(t)
            }
            // ADVANCED tools (codegraph_impact, repository_impact) are NOT in
            // the source's BANYAN_TOOL_IDS allowlist, so they are filtered
            // out before rendering regardless of model strength. Model-strength
            // filtering is the upstream ToolRegistry's job.
            for (const t of ADVANCED_TOOLS) {
              expect(guide).not.toContain(t)
            }
          }),
      )
    }

    for (const modelID of WEAK_MODEL_IDS) {
      it.effect(
        `agent=${agentName} model=${modelID} (weak): required visible, no advanced (simulated upstream filter)`,
        () =>
          Effect.gen(function* () {
            const svc = yield* Banyan.CodegraphSystemSource
            // Simulate the upstream ToolRegistry filtering out ADVANCED tools
            // for weak models. The consumer is responsible for passing only
            // the public+required tool ids when model strength is low.
            const guide = yield* svc.load({ tools: publicOnlyTools() })

            for (const t of REQUIRED_TOOLS) {
              expect(guide).toContain(t)
            }
            for (const t of ADVANCED_TOOLS) {
              expect(guide).not.toContain(t)
            }
            for (const t of FORBIDDEN_TOOLS) {
              expect(guide).not.toContain(t)
            }
          }),
      )
    }
  }
})