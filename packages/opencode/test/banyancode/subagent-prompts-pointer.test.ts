/**
 * Regression guard: every built-in subagent prompt contains the
 * "BanyanCode tool guide" pointer phrase and is free of the
 * "prefer using Glob and Grep" conflict phrase.
 *
 * Two paths are exercised:
 *
 *   1. Agents with a dedicated `.txt` prompt (`coder`, `explore`, `scout`,
 *      `researcher`, `orchestrator`) — asserted directly on `agent.prompt`.
 *   2. Agents without a dedicated prompt (`build`, `plan`) — the effective
 *      system prompt is reconstructed from
 *      `SystemPrompt.provider(model).join("\n")` plus the always-on
 *      `SystemPrompt.codegraph()` block (policy + tool guide), then the
 *      pointer is asserted.
 *
 * The pointer phrase lives in the BanyanCode tool guide rendered by the
 * codegraph block, which is appended to every agent's system prompt when
 * BanyanCode is enabled — so build/plan carry it regardless of provider.
 */

process.env.BANYANCODE_ENABLE = "1"

import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Banyan } from "@opencode-ai/core/banyancode"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { Agent } from "@/agent/agent"
import { Auth } from "@/auth"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Plugin } from "@/plugin"
import { Provider } from "@/provider/provider"
import { Skill } from "@/skill"
import { SystemPrompt, provider as systemProvider } from "@/session/system"
import { LocationServiceMap } from "@opencode-ai/core/location-layer"
import { tool, jsonSchema } from "ai"

const POINTER_PHRASE = "BanyanCode tool guide"
const FORBIDDEN_PHRASE = "prefer using Glob and Grep"

const AGENTS_WITH_PROMPT = [
  "coder",
  "explore",
  "scout",
  "researcher",
  "orchestrator",
] as const

// The tool-guide pointer is rendered from any materialized tool id — the
// exact id does not matter for the pointer assertion.
const FAKE_TOOL = tool({ description: "locate symbols", inputSchema: jsonSchema({ type: "object" }) })

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

const systemPromptLayer = Layer.mergeAll(
  // `Layer.provide` does not export the provided service into the built
  // context (provideMerge does), so mount the codegraph source explicitly —
  // production composes it via AppLayer/createRoutes.
  Banyan.CodegraphSystemSourceNS.defaultLayer,
  SystemPrompt.defaultLayer.pipe(
    Layer.provide(Skill.defaultLayer),
    Layer.provide(FSUtil.defaultLayer),
    Layer.provide(LocationServiceMap.layer),
  ),
)

const it = testEffect(Layer.mergeAll(agentLayer(), systemPromptLayer))

const fakeModel = (apiId: string) =>
  ({ api: { id: apiId, url: "", npm: "" } } as Provider.Model)

afterEach(async () => {
  await disposeAllInstances()
})

describe("subagent prompts — pointer phrase present, conflict phrase absent", () => {
  for (const agentName of AGENTS_WITH_PROMPT) {
    it.instance(`${agentName} prompt contains "${POINTER_PHRASE}" and not "${FORBIDDEN_PHRASE}"`, () =>
      Effect.gen(function* () {
        const agent = yield* Agent.Service.use((svc) => svc.get(agentName))
        expect(agent).toBeDefined()
        if (!agent) return
        expect(agent.prompt).toBeDefined()
        expect(agent.prompt).toContain(POINTER_PHRASE)
        expect(agent.prompt).not.toContain(FORBIDDEN_PHRASE)
      }),
    )
  }
})

describe("build/plan effective prompt — pointer present via the always-on codegraph block", () => {
  for (const agentName of ["build", "plan"] as const) {
    it.instance(`${agentName} effective prompt contains the pointer`, () =>
      Effect.gen(function* () {
        const agent = yield* Agent.Service.use((svc) => svc.get(agentName))
        expect(agent).toBeDefined()
        if (!agent) return
        expect(agent.prompt).toBeUndefined()

        // build/plan have no agent.prompt — the effective system prompt is
        // the provider prompt plus the always-on BanyanCode policy/guide block.
        const providerChunks = systemProvider(fakeModel("gpt-5"))
        expect(providerChunks.length).toBeGreaterThan(0)
        const codegraphBlock = yield* (yield* SystemPrompt.Service).codegraph({ code_find: FAKE_TOOL })
        expect(codegraphBlock).toBeDefined()
        const effective = [...providerChunks, codegraphBlock ?? ""].join("\n")

        expect(effective).toContain(POINTER_PHRASE)
        expect(effective).not.toContain(FORBIDDEN_PHRASE)
      }),
    )
  }
})