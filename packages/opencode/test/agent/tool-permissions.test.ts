/**
 * Phase 1 tool-permissions regression tests.
 *
 * Per user directive: "for now, all agents get all tools."
 * Every BanyanCode agent must permit every banyancode tool without
 * requiring user approval.
 *
 * Agents tested: build, plan, general, orchestrator, researcher, coder,
 * scout, explore.
 * Tools verified (must all be `allow` in every agent):
 *   - codegraph tools: codegraph_build, codegraph_query, codegraph_search,
 *     codegraph_callers, codegraph_dependents, codegraph_impact,
 *     codegraph_find_async, codegraph_find_recursive, codegraph_find_http_routes,
 *     codegraph_find_overrides, codegraph_find_implementations
 *   - repository tools: repository_query, repository_explain, repository_trace,
 *     repository_impact, repository_tests, repository_symbols,
 *     repository_relationships, repository_ownership
 *   - other: websearch_free, code_find, edit_plan
 */

import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { Agent } from "../../src/agent/agent"
import { Auth } from "../../src/auth"
import { Config } from "../../src/config/config"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { Permission } from "../../src/permission"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Plugin } from "../../src/plugin"
import { Provider } from "../../src/provider/provider"
import { Skill } from "../../src/skill"
import { LocationServiceMap } from "@opencode-ai/core/location-layer"

const agentLayer = () =>
  Agent.layer.pipe(
    Layer.provide(Plugin.defaultLayer),
    Layer.provide(Provider.defaultLayer),
    Layer.provide(Auth.defaultLayer),
    Layer.provide(Config.defaultLayer),
    Layer.provide(Skill.defaultLayer),
    Layer.provide(LocationServiceMap.layer),
    Layer.provide(RuntimeFlags.layer()),
  )

const it = testEffect(agentLayer())

const CODEGRAPH_TOOLS = [
  "codegraph_build",
  "codegraph_query",
  "codegraph_search",
  "codegraph_callers",
  "codegraph_dependents",
  "codegraph_impact",
  "codegraph_find_async",
  "codegraph_find_recursive",
  "codegraph_find_http_routes",
  "codegraph_find_overrides",
  "codegraph_find_implementations",
] as const

const REPOSITORY_TOOLS = [
  "repository_query",
  "repository_explain",
  "repository_trace",
  "repository_impact",
  "repository_tests",
  "repository_symbols",
  "repository_relationships",
  "repository_ownership",
] as const

const OTHER_TOOLS = ["websearch_free", "code_find", "edit_plan"] as const

const ALL_BANYANCODE_TOOLS = [...CODEGRAPH_TOOLS, ...REPOSITORY_TOOLS, ...OTHER_TOOLS]

function evalPerm(ruleset: PermissionV1.Ruleset, tool: string): PermissionV1.Action {
  return Permission.evaluate(tool, "*", ruleset).action
}

afterEach(async () => {
  await disposeAllInstances()
})

describe("tool permissions — all agents get all banyancode tools", () => {
  for (const agentName of ["build", "plan", "general", "orchestrator", "researcher", "coder", "scout", "explore"] as const) {
    it.instance(`${agentName} agent allows every banyancode tool`, () =>
      Effect.gen(function* () {
        const agent = yield* Agent.Service.use((svc) => svc.get(agentName))
        expect(agent).toBeDefined()
        if (!agent) return
        for (const tool of ALL_BANYANCODE_TOOLS) {
          expect(evalPerm(agent.permission, tool)).toBe("allow")
        }
      }),
    )
  }
})