import { afterEach, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { Agent } from "../../src/agent/agent"
import { Auth } from "../../src/auth"
import { Config } from "../../src/config/config"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import { Provider } from "../../src/provider/provider"
import { Skill } from "../../src/skill"
import { LocationServiceMap } from "@opencode-ai/core/location-layer"
import { RuntimeFlags } from "../../src/effect/runtime-flags"

const agentLayer = (flags: Partial<RuntimeFlags.Info> = {}) =>
  Agent.layer.pipe(
    Layer.provide(Plugin.defaultLayer),
    Layer.provide(Provider.defaultLayer),
    Layer.provide(Auth.defaultLayer),
    Layer.provide(Config.defaultLayer),
    Layer.provide(Skill.defaultLayer),
    Layer.provide(LocationServiceMap.layer),
    Layer.provide(RuntimeFlags.layer(flags)),
  )

const it = testEffect(agentLayer())

function load<A>(fn: (svc: Agent.Interface) => Effect.Effect<A>) {
  return Agent.Service.use(fn)
}

afterEach(async () => {
  await disposeAllInstances()
})

it.instance("coder agent resolves from registry", () =>
  Effect.gen(function* () {
    const coder = yield* load((svc) => svc.get("coder"))
    expect(coder).toBeDefined()
    expect(coder?.name).toBe("coder")
    expect(coder?.mode).toBe("subagent")
    expect(coder?.native).toBe(true)
  }),
  undefined,
  { timeout: 10_000 },
)

it.instance("scout agent resolves from registry", () =>
  Effect.gen(function* () {
    const scout = yield* load((svc) => svc.get("scout"))
    expect(scout).toBeDefined()
    expect(scout?.name).toBe("scout")
    expect(scout?.mode).toBe("subagent")
    expect(scout?.native).toBe(true)
  }),
)

it.instance("coder prompt includes codegraph", () =>
  Effect.gen(function* () {
    const coder = yield* load((svc) => svc.get("coder"))
    expect(coder).toBeDefined()
    expect(coder?.prompt).toContain("codegraph")
  }),
)

it.instance("scout prompt exists and is non-empty", () =>
  Effect.gen(function* () {
    const scout = yield* load((svc) => svc.get("scout"))
    expect(scout).toBeDefined()
    expect(scout?.prompt).toBeDefined()
    expect(scout?.prompt!.length).toBeGreaterThan(0)
  }),
)

it.instance("orchestrator allows task to coder", () =>
  Effect.gen(function* () {
    const orchestrator = yield* load((svc) => svc.get("orchestrator"))
    expect(orchestrator).toBeDefined()
    const result = Permission.evaluate("task", "coder", orchestrator!.permission)
    expect(result.action).toBe("allow")
  }),
)

it.instance("orchestrator allows task to scout", () =>
  Effect.gen(function* () {
    const orchestrator = yield* load((svc) => svc.get("orchestrator"))
    expect(orchestrator).toBeDefined()
    const result = Permission.evaluate("task", "scout", orchestrator!.permission)
    expect(result.action).toBe("allow")
  }),
)

it.instance("coder denies task permission (no recursion)", () =>
  Effect.gen(function* () {
    const coder = yield* load((svc) => svc.get("coder"))
    expect(coder).toBeDefined()
    const result = Permission.evaluate("task", "anything", coder!.permission)
    expect(result.action).toBe("deny")
  }),
)

it.instance("scout denies task permission (no recursion)", () =>
  Effect.gen(function* () {
    const scout = yield* load((svc) => svc.get("scout"))
    expect(scout).toBeDefined()
    const result = Permission.evaluate("task", "anything", scout!.permission)
    expect(result.action).toBe("deny")
  }),
)