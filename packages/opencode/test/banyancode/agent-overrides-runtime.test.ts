import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { Agent } from "../../src/agent/agent"
import { Auth } from "../../src/auth"
import { Config } from "../../src/config/config"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { Plugin } from "../../src/plugin"
import { Provider } from "../../src/provider/provider"
import { Skill } from "../../src/skill"
import { LocationServiceMap } from "@opencode-ai/core/location-layer"
import { Banyan } from "@opencode-ai/core/banyancode"
import type { BanyanConfigInfo } from "@opencode-ai/core/banyancode"

process.env.BANYANCODE_ENABLE = "1"

type BanyanOverrides = NonNullable<BanyanConfigInfo["banyancode_agent_overrides"]>

const baseLayer = Layer.mergeAll(
  Plugin.defaultLayer,
  Provider.defaultLayer,
  Auth.defaultLayer,
  Config.defaultLayer,
  Skill.defaultLayer,
  LocationServiceMap.layer,
  RuntimeFlags.layer({}),
)

const makeBanyanLayer = (overrides: BanyanOverrides) =>
  Layer.succeed(
    Banyan.BanyanConfigService,
    Banyan.BanyanConfigService.of({
      get: () => Effect.succeed({} as BanyanConfigInfo),
      getGlobal: () => Effect.succeed({} as BanyanConfigInfo),
      update: () => Effect.succeed({} as BanyanConfigInfo),
      updateAgentOverride: () => Effect.succeed({} as BanyanConfigInfo),
      getAgentOverrides: () => Effect.succeed(overrides),
      updateAgentPrompt: () => Effect.succeed({} as BanyanConfigInfo),
    }),
  )

const makeAgentLayer = (overrides: BanyanOverrides = []) =>
  Agent.layer.pipe(
    Layer.provide(baseLayer),
    Layer.provide(makeBanyanLayer(overrides)),
  )

afterEach(async () => {
  await disposeAllInstances()
})

const TEST_OPTS = { timeout: 30_000 } as const

describe("agent overrides runtime", () => {
  describe("no overrides", () => {
    const it = testEffect(makeAgentLayer([]))
    it.instance(
      "list() returns all built-in agents",
      () =>
        Effect.gen(function* () {
          const _ = yield* TestInstance
          const agents = yield* Agent.Service
          const list = yield* agents.list()
          const names = list.map((a) => a.name)
          expect(names).toContain("coder")
          expect(names).toContain("explore")
          expect(names).toContain("build")
        }),
      TEST_OPTS,
    )

    it.instance(
      "get(coder) returns the default config",
      () =>
        Effect.gen(function* () {
          const _ = yield* TestInstance
          const agents = yield* Agent.Service
          const coder = yield* agents.get("coder")
          expect(coder).toBeDefined()
          expect(coder?.name).toBe("coder")
          expect(coder?.mode).toBe("subagent")
        }),
      TEST_OPTS,
    )
  })

  describe("disable coder", () => {
    const it = testEffect(
      makeAgentLayer([{ name: "coder", enabled: false }]),
    )
    it.instance(
      "list() excludes disabled subagent",
      () =>
        Effect.gen(function* () {
          const _ = yield* TestInstance
          const agents = yield* Agent.Service
          const list = yield* agents.list()
          const names = list.map((a) => a.name)
          expect(names).not.toContain("coder")
          expect(names).toContain("build")
        }),
      TEST_OPTS,
    )

    it.instance(
      "get(coder) returns undefined for disabled subagent",
      () =>
        Effect.gen(function* () {
          const _ = yield* TestInstance
          const agents = yield* Agent.Service
          const coder = yield* agents.get("coder")
          expect(coder).toBeUndefined()
        }),
      TEST_OPTS,
    )
  })

  describe("orchestrator not disableable", () => {
    const it = testEffect(
      makeAgentLayer([{ name: "build", enabled: false }]),
    )
    it.instance(
      "list() still includes build despite override",
      () =>
        Effect.gen(function* () {
          const _ = yield* TestInstance
          const agents = yield* Agent.Service
          const list = yield* agents.list()
          const names = list.map((a) => a.name)
          expect(names).toContain("build")
        }),
      TEST_OPTS,
    )
  })

  describe("model override", () => {
    const it = testEffect(
      makeAgentLayer([{ name: "coder", model: { providerID: "p", modelID: "m" } }]),
    )
    it.instance(
      "get(coder) returns agent with model override",
      () =>
        Effect.gen(function* () {
          const _ = yield* TestInstance
          const agents = yield* Agent.Service
          const coder = yield* agents.get("coder")
          expect(coder).toBeDefined()
          expect(coder?.model).toBeDefined()
          expect(coder?.model?.providerID as string | undefined).toBe("p")
          expect(coder?.model?.modelID as string | undefined).toBe("m")
        }),
      TEST_OPTS,
    )
  })

  describe("re-enable after disable", () => {
    const it = testEffect(
      makeAgentLayer([{ name: "coder", enabled: true }]),
    )
    it.instance(
      "list() includes coder after re-enable",
      () =>
        Effect.gen(function* () {
          const _ = yield* TestInstance
          const agents = yield* Agent.Service
          const list = yield* agents.list()
          const names = list.map((a) => a.name)
          expect(names).toContain("coder")
        }),
      TEST_OPTS,
    )
  })
})
