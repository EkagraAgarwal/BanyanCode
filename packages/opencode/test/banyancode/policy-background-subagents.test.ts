/**
 * Regression tests for the unified codegraph-first / parallel-subagent-mesh
 * policy shipped to every built-in agent and the SystemPrompt layer.
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

describe("POLICY_TEXT — parallel subagent mesh", () => {
  itPolicy.effect("ships the 'Parallel subagent mesh (ALWAYS)' section", () =>
    Effect.gen(function* () {
      const block = yield* SystemPrompt.Service.use((svc) => svc.codegraph())
      expect(block).toBeDefined()
      expect(block).toContain("Parallel subagent mesh (ALWAYS)")
      expect(block).toContain("background: true")
      expect(block).toContain("Sync")
      expect(block).toContain("acceptable ONLY for a trivial")
      expect(block).toContain("shared_memory")
      expect(block).toContain("500 lines")
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
      expect(exported).toContain("Parallel subagent mesh (ALWAYS)")
    }),
  )
})

describe("primary agents (build/plan) — no dedicated prompt, policy comes from system context", () => {
  for (const agentName of ["build", "plan"] as const) {
    it.instance(`${agentName} has no dedicated prompt — relies on the system policy block`, () =>
      Effect.gen(function* () {
        const _ = yield* TestInstance
        const agent = yield* Agent.Service.use((svc) => svc.get(agentName))
        expect(agent).toBeDefined()
        if (!agent) return
        // Reverted to upstream: primary agents use the provider system prompt
        // plus the always-on BanyanCode policy/guide block.
        expect(agent.prompt).toBeUndefined()
      }),
    )
  }
})

describe("subagent prompts — point to system context, no inline policy duplication", () => {
  for (const agentName of ["coder", "explore", "scout", "researcher", "orchestrator", "reviewer"] as const) {
    it.instance(`${agentName} prompt references the tool guide pointer in system context`, () =>
      Effect.gen(function* () {
        const _ = yield* TestInstance
        const agent = yield* Agent.Service.use((svc) => svc.get(agentName))
        expect(agent).toBeDefined()
        if (!agent) return
        const prompt = agent.prompt ?? ""
        expect(prompt).toContain("BanyanCode tool guide")
        expect(prompt).toContain("system context")
        // The full inline policy body is not duplicated in subagent prompts.
        expect(prompt).not.toContain("last resorts")
      }),
    )
  }

  it.instance("reviewer keeps its codegraph inspection guidance", () =>
    Effect.gen(function* () {
      const _ = yield* TestInstance
      const reviewer = yield* Agent.Service.use((svc) => svc.get("reviewer"))
      expect(reviewer).toBeDefined()
      if (!reviewer) return
      const prompt = reviewer.prompt ?? ""
      expect(prompt).toContain("Never `cat` a whole file")
      expect(prompt).toContain("code_find")
    }),
  )
})

describe("plan agent — can delegate to explore, researcher, and scout subagents", () => {
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

  it.instance("plan agent allows `task: explore`", () =>
    Effect.gen(function* () {
      const _ = yield* TestInstance
      const plan = yield* Agent.Service.use((svc) => svc.get("plan"))
      expect(plan).toBeDefined()
      if (!plan) return
      const result = Permission.evaluate("task", "explore", plan.permission)
      expect(result.action).toBe("allow")
    }),
  )

  it.instance("plan agent allows `task: researcher`", () =>
    Effect.gen(function* () {
      const _ = yield* TestInstance
      const plan = yield* Agent.Service.use((svc) => svc.get("plan"))
      expect(plan).toBeDefined()
      if (!plan) return
      const result = Permission.evaluate("task", "researcher", plan.permission)
      expect(result.action).toBe("allow")
    }),
  )

  it.instance("plan agent still denies every other subagent type", () =>
    Effect.gen(function* () {
      const _ = yield* TestInstance
      const plan = yield* Agent.Service.use((svc) => svc.get("plan"))
      expect(plan).toBeDefined()
      if (!plan) return
      for (const subagentType of ["coder", "reviewer", "orchestrator"]) {
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
      expect(prompt).toContain("spawn parallel `scout` subagents")
      expect(prompt).toContain("background: true")
      // {{maxSubagents}} must be rendered — no literal placeholder survives.
      expect(prompt).not.toContain("{{maxSubagents}}")
      expect(prompt).toMatch(/cap \d+/)
    }),
  )

  it.instance("researcher prompt references parallel scout fan-out + resolved maxSubagents", () =>
    Effect.gen(function* () {
      const _ = yield* TestInstance
      const researcher = yield* Agent.Service.use((svc) => svc.get("researcher"))
      expect(researcher).toBeDefined()
      if (!researcher) return
      const prompt = researcher.prompt ?? ""
      expect(prompt).toContain("spawn parallel `scout` subagents")
      expect(prompt).toContain("background: true")
      expect(prompt).not.toContain("{{maxSubagents}}")
      expect(prompt).toMatch(/cap \d+/)
    }),
  )

  it.instance("scout prompt has no literal {{maxSubagents}} placeholder", () =>
    Effect.gen(function* () {
      const _ = yield* TestInstance
      const scout = yield* Agent.Service.use((svc) => svc.get("scout"))
      expect(scout).toBeDefined()
      if (!scout) return
      const prompt = scout.prompt ?? ""
      expect(prompt).not.toContain("{{maxSubagents}}")
      expect(prompt).toContain("3 tool calls")
      expect(prompt).toContain("BanyanCode tool guide")
    }),
  )
})

describe("orchestrator — rendered with {{maxSubagents}}, carries the /goal section", () => {
  it.instance("orchestrator prompt has resolved maxSubagents", () =>
    Effect.gen(function* () {
      const _ = yield* TestInstance
      const orchestrator = yield* Agent.Service.use((svc) => svc.get("orchestrator"))
      expect(orchestrator).toBeDefined()
      if (!orchestrator) return
      const prompt = orchestrator.prompt ?? ""
      expect(prompt).toMatch(/cap \d+/)
      expect(prompt).not.toContain("{{maxSubagents}}")
    }),
  )

  it.instance("orchestrator prompt gates the heavy loop behind /goal", () =>
    Effect.gen(function* () {
      const _ = yield* TestInstance
      const orchestrator = yield* Agent.Service.use((svc) => svc.get("orchestrator"))
      expect(orchestrator).toBeDefined()
      if (!orchestrator) return
      const prompt = orchestrator.prompt ?? ""
      expect(prompt).toContain("When /goal is active")
      expect(prompt).toContain("VERDICT: pass")
      expect(prompt).toContain("banyancode_max_goal_iterations")
      expect(prompt).toContain("mesh_control")
    }),
  )
})
