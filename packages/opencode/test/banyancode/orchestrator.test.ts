import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import path from "path"
import { Banyan } from "@opencode-ai/core/banyancode"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { Agent } from "../../src/agent/agent"
import { Auth } from "../../src/auth"
import { Config } from "../../src/config/config"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { Global } from "@opencode-ai/core/global"
import { Plugin } from "../../src/plugin"
import { Provider } from "../../src/provider/provider"
import { Skill } from "../../src/skill"
import { SystemPrompt } from "../../src/session/system"
import { FSUtil } from "@opencode-ai/core/fs-util"
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
    Layer.provide(RuntimeFlags.layer({})),
  )

const it = testEffect(agentLayer())

const policyLayer = Layer.mergeAll(
  Banyan.CodegraphSystemSourceNS.defaultLayer,
  SystemPrompt.defaultLayer,
  Skill.defaultLayer,
  FSUtil.defaultLayer,
  LocationServiceMap.layer,
)

const itPolicy = testEffect(policyLayer)

afterEach(async () => {
  await disposeAllInstances()
})

describe("orchestrator agent", () => {
  it.instance(
    "orchestrator agent is registered with correct properties",
    () =>
      Effect.gen(function* () {
        const _ = yield* TestInstance
        const agents = yield* Agent.Service
        const list = yield* agents.list()
        const orchestrator = list.find((a) => a.name === "orchestrator")
        expect(orchestrator).toBeDefined()
        expect(orchestrator?.name).toBe("orchestrator")
        expect(orchestrator?.mode).toBe("primary")
        expect(orchestrator?.native).toBe(true)
        const detail = yield* agents.get("orchestrator")
        expect(detail).toBeDefined()
        if (!detail) return
        expect(detail.prompt).toBeDefined()
        const prompt = detail.prompt!
        expect(prompt).toContain("shared_memory")
        expect(prompt).toContain("subagent")
        expect(prompt).toContain("fanout")
        expect(prompt).toContain("MUST fan out 2-3 parallel subagents")
        expect(prompt).toContain("maximum is 5")
        // The orchestrator prompt now DELEGATES to the system context for
        // the codegraph policy rather than inlining it. The full tool list
        // (codegraph_build, code_find, ...) lives in the SystemPrompt
        // block, asserted below in the policy-contains-tools suite.
        expect(prompt).toContain("Codegraph-first search policy")
        expect(prompt).toContain("system context")
        // The background-subagent preference is embodied in the
        // orchestration rules rather than inlined policy.
        expect(prompt).toContain("background:true")
      }),
    { timeout: 30_000 },
  )
})

describe("orchestrator agent — system-context policy still carries the tool list", () => {
  itPolicy.effect("Codegraph-first policy block names every required tool", () =>
    Effect.gen(function* () {
      const block = yield* SystemPrompt.Service.use((svc) => svc.codegraph())
      expect(block).toBeDefined()
      expect(block).toContain("codegraph_build")
      expect(block).toContain("code_find")
      expect(block).toContain("repository_query")
      expect(block).toContain("blast_radius")
      expect(block).toContain("preflight")
      expect(block).toContain("edit_plan")
      // The background-subagent section moved out of the policy block into
      // the orchestration block (src/session/prompt/banyan.txt).
      expect(block).not.toContain("Background subagents")
    }),
  )
})

describe("researcher agent", () => {
  it.instance(
    "researcher agent is registered with correct properties",
    () =>
      Effect.gen(function* () {
        const _ = yield* TestInstance
        const agents = yield* Agent.Service
        const list = yield* agents.list()
        const researcher = list.find((a) => a.name === "researcher")
        expect(researcher).toBeDefined()
        expect(researcher?.name).toBe("researcher")
        expect(researcher?.mode).toBe("subagent")
        expect(researcher?.native).toBe(true)
        const detail = yield* agents.get("researcher")
        expect(detail).toBeDefined()
        if (!detail) return
        expect(detail.prompt).toBeDefined()
        const prompt = detail.prompt!
        expect(prompt).toContain("websearch_free")
        expect(prompt).toContain("READ-ONLY")
        // Phase 3 — parallel scout fan-out is rendered with maxSubagents.
        expect(prompt).toContain("parallel scout subagents")
        expect(prompt).toMatch(/max \d+ concurrent/)
      }),
    { timeout: 30_000 },
  )
})
