/**
 * Audit finding #2 regression guard.
 *
 * Each built-in agent MUST allow every public BanyanCode tool without
 * requiring user approval. The `explore` agent gets an extra set of
 * explicit checks for the audit findings (`codegraph_remove`, `blast_radius`,
 * `preflight`, `safe_rename`) — even though those ids are already in
 * `REQUIRED_TOOLS` — so any future removal of an audit finding from the
 * required set still leaves a green test that explicitly asserts the audit
 * finding is allowed.
 */

import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { Agent } from "@/agent/agent"
import { Auth } from "@/auth"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Permission } from "@/permission"
import { Plugin } from "@/plugin"
import { Provider } from "@/provider/provider"
import { Skill } from "@/skill"
import { LocationServiceMap } from "@opencode-ai/core/location-layer"
import { BUILTIN_AGENT_NAMES, REQUIRED_TOOLS } from "./tool-guide-constants"

const AUDIT_FINDING_TOOLS = ["codegraph_remove", "blast_radius", "preflight", "safe_rename"] as const

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

const evalAllow = (permission: Agent.Info["permission"], tool: string): void => {
  const result = Permission.evaluate(tool, "*", permission)
  expect(result.action).toBe("allow")
}

afterEach(async () => {
  await disposeAllInstances()
})

describe("explore agent — every BanyanCode tool is allow-listed", () => {
  it.instance(
    "explore allows REQUIRED_TOOLS plus the audit-finding tools",
    () =>
      Effect.gen(function* () {
        const explore = yield* Agent.Service.use((svc) => svc.get("explore"))
        expect(explore).toBeDefined()
        if (!explore) return
        for (const tool of REQUIRED_TOOLS) evalAllow(explore.permission, tool)
        for (const tool of AUDIT_FINDING_TOOLS) evalAllow(explore.permission, tool)
      }),
    { timeout: 15_000 },
  )
})

describe("other built-in agents — every BanyanCode tool is allow-listed", () => {
  for (const agentName of BUILTIN_AGENT_NAMES) {
    if (agentName === "explore") continue
    it.instance(`${agentName} allows every REQUIRED_TOOL`, () =>
      Effect.gen(function* () {
        const agent = yield* Agent.Service.use((svc) => svc.get(agentName))
        expect(agent).toBeDefined()
        if (!agent) return
        for (const tool of REQUIRED_TOOLS) evalAllow(agent.permission, tool)
      }),
    )
  }
})