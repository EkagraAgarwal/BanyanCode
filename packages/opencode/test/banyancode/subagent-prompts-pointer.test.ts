/**
 * Regression guard: every built-in subagent prompt contains the
 * "BanyanCode tool guide" pointer phrase and is free of the
 * "prefer using Glob and Grep" conflict phrase.
 *
 * Two paths are exercised:
 *
 *   1. Agents with a dedicated `.txt` prompt (`coder`, `explore`, `scout`,
 *      `researcher`, `orchestrator`, `general`) — asserted directly on
 *      `agent.prompt`.
 *   2. Agents without a dedicated prompt (`build`, `plan`) — the effective
 *      system prompt is reconstructed from
 *      `SystemPrompt.provider(model).join("\n")` plus the optional
 *      `SystemPrompt.codegraph()` block, then the pointer is asserted.
 *
 * The build/plan reconstruction only asserts the pointer for models that
 * dispatch to `gpt.txt`, `codex.txt`, or `gemini.txt` (the three providers
 * that carry the pointer phrase). Other providers (anthropic, kimi, trinity,
 * default, beast) carry no tool preference — that contract is enforced by
 * `provider-prompts-no-conflict.test.ts`.
 */

process.env.BANYANCODE_ENABLE = "1"

import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
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

const POINTER_PHRASE = "BanyanCode tool guide"
const FORBIDDEN_PHRASE = "prefer using Glob and Grep"

const AGENTS_WITH_PROMPT = [
  "coder",
  "explore",
  "scout",
  "researcher",
  "orchestrator",
  "general",
] as const

// Models that dispatch to provider prompts carrying the pointer phrase
// (gpt.txt, codex.txt, gemini.txt).
const POINTER_BEARING_MODELS = ["gpt-5", "gpt-5-codex", "gemini-3-pro"] as const

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

const systemPromptLayer = SystemPrompt.defaultLayer.pipe(
  Layer.provide(Skill.defaultLayer),
  Layer.provide(FSUtil.defaultLayer),
  Layer.provide(LocationServiceMap.layer),
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

describe("build/plan effective prompt — pointer present for pointer-bearing providers", () => {
  for (const agentName of ["build", "plan"] as const) {
    for (const apiId of POINTER_BEARING_MODELS) {
      it.instance(`${agentName} provider prompt for ${apiId} contains the pointer`, () =>
        Effect.gen(function* () {
          const agent = yield* Agent.Service.use((svc) => svc.get(agentName))
          expect(agent).toBeDefined()
          if (!agent) return

          // build/plan have no agent.prompt — the effective system prompt
          // is composed by SystemPrompt.provider(model) + injected blocks.
          const providerChunks = systemProvider(fakeModel(apiId))
          expect(providerChunks.length).toBeGreaterThan(0)
          const effective = providerChunks.join("\n")

          expect(effective).toContain(POINTER_PHRASE)
          expect(effective).not.toContain(FORBIDDEN_PHRASE)

          // Sanity-check that SystemPrompt.codegraph() integrates cleanly
          // with the provider prompt — it must not introduce the forbidden
          // phrase either.
          const codegraphBlock = yield* (yield* SystemPrompt.Service).codegraph()
          if (codegraphBlock) {
            expect(codegraphBlock).not.toContain(FORBIDDEN_PHRASE)
          }
        }),
      )
    }
  }
})