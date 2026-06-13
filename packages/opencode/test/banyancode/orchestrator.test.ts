import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import path from "path"
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
        expect(detail.prompt).toBeDefined()
        const prompt = detail.prompt!
        expect(prompt).toContain("shared_memory")
        expect(prompt).toContain("subagent")
        expect(prompt).toContain("fanout")
        expect(prompt).toContain("PREFER 2-3 parallel subagents")
        expect(prompt).toContain("maximum is 5")
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
        expect(detail.prompt).toBeDefined()
        const prompt = detail.prompt!
        expect(prompt).toContain("websearch_free")
        expect(prompt).toContain("READ-ONLY")
      }),
  )
})
