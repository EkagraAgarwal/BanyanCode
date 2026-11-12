import { describe, expect, test } from "bun:test"
import { planBody, promptCacheKeyPolicy, supportsPromptCacheOptions } from "../../src/cache/policy.js"
import type { Info } from "../../src/config/schema.js"

const config = (values: Info = {}): Info => values

describe("prompt cache policy", () => {
  test("key policy auto only targets documented providers", () => {
    expect(promptCacheKeyPolicy("auto", "openai", "ses_abc")).toBe("ses_abc")
    expect(promptCacheKeyPolicy("auto", "openrouter", "ses_abc")).toBe("ses_abc")
    expect(promptCacheKeyPolicy("auto", "mistral", "ses_abc")).toBe("ses_abc")
    expect(promptCacheKeyPolicy("auto", "anthropic", "ses_abc")).toBeUndefined()
    expect(promptCacheKeyPolicy("off", "openai", "ses_abc")).toBeUndefined()
    expect(promptCacheKeyPolicy("custom-key", "openai", "ses_abc")).toBe("custom-key")
  })

  test("model gate covers GPT-5.6+ and GPT-6 only", () => {
    expect(supportsPromptCacheOptions("gpt-5.6")).toBe(true)
    expect(supportsPromptCacheOptions("openai/gpt-5.6-codex")).toBe(true)
    expect(supportsPromptCacheOptions("gpt-6")).toBe(true)
    expect(supportsPromptCacheOptions("gpt-5.5")).toBe(false)
    expect(supportsPromptCacheOptions("gpt-60")).toBe(false)
    expect(supportsPromptCacheOptions("gpt-52")).toBe(false)
  })

  test("default openai body gains a stable key and implicit options", () => {
    const plan = planBody({
      config: config(),
      providerID: "openai",
      modelID: "gpt-5.6",
      chatgpt: false,
      sessionID: "ses_abc",
      body: { model: "gpt-5.6", input: "hi" },
    })
    expect(plan.changed).toBe(true)
    expect(plan.body).toEqual({
      model: "gpt-5.6",
      input: "hi",
      prompt_cache_key: "ses_abc",
      prompt_cache_options: { mode: "implicit" },
    })
  })

  test("auto keeps the core SessionAffinity key when present", () => {
    const plan = planBody({
      config: config(),
      providerID: "openai",
      modelID: "gpt-5.6",
      chatgpt: false,
      sessionID: "ses_child",
      body: { prompt_cache_key: "root-affinity" },
    })
    expect(plan.body.prompt_cache_key).toBe("root-affinity")
  })

  test("mode off and key off remove both fields", () => {
    const plan = planBody({
      config: config({ banyancode_prompt_cache_key: "off", banyancode_prompt_cache_mode: "off" }),
      providerID: "openai",
      modelID: "gpt-5.6",
      chatgpt: false,
      sessionID: "ses_abc",
      body: { prompt_cache_key: "old", prompt_cache_options: { mode: "implicit" } },
    })
    expect(plan.changed).toBe(true)
    expect(plan.body).toEqual({})
  })

  test("diagnostics adds the previous response id", () => {
    const plan = planBody({
      config: config({ banyancode_prompt_cache_diagnostics: true }),
      providerID: "openai",
      modelID: "gpt-5.6",
      chatgpt: false,
      sessionID: "ses_abc",
      body: {},
      comparisonResponseID: "resp_1",
    })
    expect(plan.body.prompt_cache_options).toEqual({ mode: "implicit", comparison_response_id: "resp_1" })
  })

  test("non-openai providers and older models stay byte-identical", () => {
    const anthropic = planBody({
      config: config(),
      providerID: "anthropic",
      modelID: "claude-sonnet-4",
      chatgpt: false,
      sessionID: "ses_abc",
      body: { model: "claude-sonnet-4" },
    })
    expect(anthropic.changed).toBe(false)

    const oldOpenAI = planBody({
      config: config(),
      providerID: "openai",
      modelID: "gpt-5.5",
      chatgpt: false,
      sessionID: "ses_abc",
      body: { model: "gpt-5.5" },
    })
    expect(oldOpenAI.changed).toBe(true)
    expect(oldOpenAI.body.prompt_cache_options).toBeUndefined()
    expect(oldOpenAI.body.prompt_cache_key).toBe("ses_abc")
  })
})

describe("banyancode_tool_search_defer (v1 port)", () => {
  const tools = [
    { type: "function", name: "shell", parameters: {} },
    { type: "function", name: "repository_query", parameters: {} },
    { type: "function", name: "preflight", parameters: {} },
  ]

  test("default off leaves the tool record byte-identical", () => {
    const plan = planBody({
      config: config(),
      providerID: "openai",
      modelID: "gpt-5.6",
      chatgpt: false,
      sessionID: "ses_abc",
      body: { tools },
    })
    expect(plan.body.tools).toEqual(tools)
    expect(plan.toolSearchDeferred).toEqual([])
  })

  test("eager tools stay inline; the rest defer and a tool_search entry is added", () => {
    const plan = planBody({
      config: config({ banyancode_tool_search_defer: true }),
      providerID: "openai",
      modelID: "gpt-5.6",
      chatgpt: false,
      sessionID: "ses_abc",
      body: { tools },
    })
    const wire = plan.body.tools as { type: string; name?: string; defer_loading?: boolean }[]
    expect(wire.find((tool) => tool.name === "shell")!.defer_loading).toBeUndefined()
    expect(wire.find((tool) => tool.name === "repository_query")!.defer_loading).toBe(true)
    expect(wire.at(-1)).toEqual({ type: "tool_search" })
    expect(plan.toolSearchDeferred).toEqual(["repository_query", "preflight"])
  })

  test("provider and model gates stay closed off-openai and pre-5.4", () => {
    const anthropic = planBody({
      config: config({ banyancode_tool_search_defer: true }),
      providerID: "anthropic",
      modelID: "gpt-5.6",
      chatgpt: false,
      sessionID: "ses_abc",
      body: { tools },
    })
    expect(anthropic.body.tools).toEqual(tools)

    const older = planBody({
      config: config({ banyancode_tool_search_defer: true }),
      providerID: "openai",
      modelID: "gpt-5.3",
      chatgpt: false,
      sessionID: "ses_abc",
      body: { tools },
    })
    expect(older.body.tools).toEqual(tools)
  })

  test("a real tool_search entry is not duplicated", () => {
    const plan = planBody({
      config: config({ banyancode_tool_search_defer: true }),
      providerID: "openai",
      modelID: "gpt-6",
      chatgpt: false,
      sessionID: "ses_abc",
      body: { tools: [...tools, { type: "tool_search" }] },
    })
    const wire = plan.body.tools as { type: string }[]
    expect(wire.filter((tool) => tool.type === "tool_search")).toHaveLength(1)
  })
})
