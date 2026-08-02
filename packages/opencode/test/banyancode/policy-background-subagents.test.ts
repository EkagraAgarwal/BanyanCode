/**
 * Regression tests for the unified codegraph-first / background-subagent /
 * parallel-scout-fan-out policy shipped to every built-in agent and the
 * SystemPrompt layer.
 *
 * Complements:
 *   - `codegraph-system-source.test.ts`            (POLICY_TEXT shape, V1 delegate)
 *   - `codegraph-system-source-per-agent.test.ts` (tool guide matrix per agent)
 *   - `orchestrator.test.ts`                      (orchestrator + researcher prompt)
 *   - `explore-permissions-regression.test.ts`    (per-agent REQUIRED_TOOLS allowlist)
 */

import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Banyan } from "@opencode-ai/core/banyancode"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { Agent } from "../../src/agent/agent"
import { Auth } from "../../src/auth"
import { Config } from "../../src/config/config"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import { Provider } from "../../src/provider/provider"
import { Skill } from "../../src/skill"
import { SystemPrompt } from "../../src/session/system"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { LocationServiceMap } from "@opencode-ai/core/location-layer"

process.env.BANYANCODE_ENABLE = "1"

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

const policyLayer = Layer.mergeAll(
  Banyan.CodegraphSystemSourceNS.defaultLayer,
  SystemPrompt.defaultLayer,
  Skill.defaultLayer,
  FSUtil.defaultLayer,
  LocationServiceMap.layer,
)

const it = testEffect(agentLayer())
const itPolicy = testEffect(policyLayer)

afterEach(async () => {
  await disposeAllInstances()
})

describe("POLICY_TEXT — background-subagent preference", () => {
  itPolicy.effect("ships the new 'Background subagents (ALWAYS)' section", () =>
    Effect.gen(function* () {
      const block = yield* SystemPrompt.Service.use((svc) => svc.codegraph())
      expect(block).toBeDefined()
      expect(block).toContain("Background subagents (ALWAYS)")
      expect(block).toContain("background: true")
      expect(block).toContain("Sync")
      expect(block).toContain("acceptable ONLY for a trivial")
    }),
  )

  itPolicy.effect("preserves the original 'Codegraph-first search policy (ALWAYS)' section", () =>
    Effect.gen(function* () {
      const block = yield* SystemPrompt.Service.use((svc) => svc.codegraph())
      expect(block).toContain("Codegraph-first search policy (ALWAYS)")
      expect(block).toContain("ALWAYS use BanyanCode graph + repository tools")
      expect(block).toContain("codegraph_build")
      expect(block).toContain("code_find")
      expect(block).toContain("repository_query")
      expect(block).toContain("blast_radius")
      expect(block).toContain("preflight")
      expect(block).toContain("edit_plan")
      expect(block).toContain("last resort")
    }),
  )

  itPolicy.effect("Banyan.CodegraphSystemSourceNS.POLICY_TEXT is the same text", () =>
    Effect.gen(function* () {
      const fromSvc = yield* Banyan.CodegraphSystemSourceNS.Service.use((svc) => svc.load({ tools: [] }))
      const exported = Banyan.CodegraphSystemSourceNS.POLICY_TEXT
      expect(fromSvc).toBe(exported)
      expect(exported).toContain("Background subagents (ALWAYS)")
    }),
  )
})

describe("prose agents — stripped the inline policy block, point to system context", () => {
  for (const agentName of ["build", "coder", "plan"] as const) {
    it.instance(`${agentName} prompt no longer contains the full inline policy body`, () =>
      Effect.gen(function* () {
        const _ = yield* TestInstance
        const agent = yield* Agent.Service.use((svc) => svc.get(agentName))
        expect(agent).toBeDefined()
        if (!agent) return
        const prompt = agent.prompt ?? ""
        // Pointer is preserved.
        expect(prompt).toContain("Codegraph-first search policy (ALWAYS)")
        expect(prompt).toContain("system context")
        // Body is gone — the prose list of bootstrap rules was duplicated
        // with the SystemPrompt block and is now centralised.
        expect(prompt).not.toContain("last resorts")
      }),
    )
  }

  it.instance("orchestrator prompt references the system context but keeps orchestration rules", () =>
    Effect.gen(function* () {
      const _ = yield* TestInstance
      const orchestrator = yield* Agent.Service.use((svc) => svc.get("orchestrator"))
      expect(orchestrator).toBeDefined()
      if (!orchestrator) return
      const prompt = orchestrator.prompt ?? ""
      expect(prompt).toContain("Codegraph-first search policy (ALWAYS)")
      expect(prompt).toContain("system context")
      expect(prompt).toContain("PREFER 2-3 parallel subagents")
      expect(prompt).toContain("maximum is 5")
      // Orchestrator-specific orchestration prose is preserved.
      expect(prompt).toContain("## Orchestration rules")
      expect(prompt).toContain("background:true")
    }),
  )
})

describe("terse subagents — keep inline policy for defense-in-depth", () => {
  for (const agentName of ["explore", "researcher", "scout"] as const) {
    it.instance(`${agentName} prompt still carries the inline Codegraph-first search policy body`, () =>
      Effect.gen(function* () {
        const _ = yield* TestInstance
        const agent = yield* Agent.Service.use((svc) => svc.get(agentName))
        expect(agent).toBeDefined()
        if (!agent) return
        const prompt = agent.prompt ?? ""
        expect(prompt).toContain("Codegraph-first search policy (ALWAYS)")
        expect(prompt).toContain("ALWAYS use BanyanCode graph + repository tools")
        expect(prompt).toContain("codegraph_build")
        expect(prompt).toContain("code_find")
        expect(prompt).toContain("repository_query")
        expect(prompt).toContain("last resort")
      }),
    )
  }
})

describe("reviewer — receives a Codegraph-first policy block", () => {
  it.instance("reviewer prompt mentions the codegraph-first policy", () =>
    Effect.gen(function* () {
      const _ = yield* TestInstance
      const reviewer = yield* Agent.Service.use((svc) => svc.get("reviewer"))
      expect(reviewer).toBeDefined()
      if (!reviewer) return
      const prompt = reviewer.prompt ?? ""
      expect(prompt).toContain("Codegraph-first search policy (ALWAYS)")
      expect(prompt).toContain("system context")
      // Reviewer-specific guidance — they READ code via the graph.
      expect(prompt).toContain("reach for `code_find`")
      expect(prompt).toContain("Never `cat` a whole file")
    }),
  )
})

describe("plan agent — gains the ability to spawn background scouts", () => {
  it.instance("plan agent allows `task: scout`", () =>
    Effect.gen(function* () {
      const _ = yield* TestInstance
      const plan = yield* Agent.Service.use((svc) => svc.get("plan"))
      expect(plan).toBeDefined()
      if (!plan) return
      const result = Permission.evaluate("task", "scout", plan.permission)
      expect(result.action).toBe("allow")
    }),
  )

  it.instance("plan agent still denies every other subagent type", () =>
    Effect.gen(function* () {
      const _ = yield* TestInstance
      const plan = yield* Agent.Service.use((svc) => svc.get("plan"))
      expect(plan).toBeDefined()
      if (!plan) return
      for (const subagentType of ["coder", "explore", "researcher", "reviewer", "orchestrator"]) {
        const result = Permission.evaluate("task", subagentType, plan.permission)
        expect(result.action).toBe("deny")
      }
    }),
  )
})

describe("explore and researcher — parallel scout fan-out rendered with maxSubagents", () => {
  it.instance("explore prompt references parallel scout fan-out + resolved maxSubagents", () =>
    Effect.gen(function* () {
      const _ = yield* TestInstance
      const explore = yield* Agent.Service.use((svc) => svc.get("explore"))
      expect(explore).toBeDefined()
      if (!explore) return
      const prompt = explore.prompt ?? ""
      expect(prompt).toContain("You MUST spawn parallel scout subagents")
      expect(prompt).toContain("background: true")
      // {{maxSubagents}} must be rendered — no literal placeholder survives.
      expect(prompt).not.toContain("{{maxSubagents}}")
      expect(prompt).toMatch(/max \d+ concurrent/)
    }),
  )

  it.instance("researcher prompt references parallel scout fan-out + resolved maxSubagents", () =>
    Effect.gen(function* () {
      const _ = yield* TestInstance
      const researcher = yield* Agent.Service.use((svc) => svc.get("researcher"))
      expect(researcher).toBeDefined()
      if (!researcher) return
      const prompt = researcher.prompt ?? ""
      expect(prompt).toContain("You MUST spawn parallel scout subagents")
      expect(prompt).toContain("background: true")
      expect(prompt).not.toContain("{{maxSubagents}}")
      expect(prompt).toMatch(/max \d+ concurrent/)
    }),
  )

  it.instance("scout prompt no longer contains the literal {{maxSubagents}} placeholder", () =>
    Effect.gen(function* () {
      const _ = yield* TestInstance
      const scout = yield* Agent.Service.use((svc) => svc.get("scout"))
      expect(scout).toBeDefined()
      if (!scout) return
      const prompt = scout.prompt ?? ""
      expect(prompt).not.toContain("{{maxSubagents}}")
      // The forward-looking mention of the cap survives rendering.
      expect(prompt).toContain("managing the")
      expect(prompt).toMatch(/\d+-cap/)
    }),
  )
})

describe("orchestrator — also rendered with {{maxSubagents}}", () => {
  it.instance("orchestrator prompt has resolved maxSubagents", () =>
    Effect.gen(function* () {
      const _ = yield* TestInstance
      const orchestrator = yield* Agent.Service.use((svc) => svc.get("orchestrator"))
      expect(orchestrator).toBeDefined()
      if (!orchestrator) return
      const prompt = orchestrator.prompt ?? ""
      expect(prompt).toContain("maximum is 5")
      expect(prompt).not.toContain("{{maxSubagents}}")
    }),
  )
})
