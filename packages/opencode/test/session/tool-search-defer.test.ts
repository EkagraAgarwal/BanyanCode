import { beforeEach, describe, expect, test } from "bun:test"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { Banyan } from "@opencode-ai/core/banyancode"
import { tool, type Tool } from "ai"
import { Effect, Layer } from "effect"
import z from "zod"
import type { Agent } from "@/agent/agent"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Plugin } from "@/plugin"
import type { Provider } from "@/provider/provider"
import { LLMRequestPrep } from "@/session/llm/request"
import { MessageID, SessionID } from "@/session/schema"
import { SessionTools } from "@/session/tools"

const plugin = {
  trigger: ((_name: unknown, _input: unknown, output: unknown) =>
    Effect.succeed(output)) as Plugin.Interface["trigger"],
  list: () => Effect.succeed([]),
  init: () => Effect.void,
}

const flags = { outputTokenMax: undefined, client: "test" } as RuntimeFlags.Info

const createModel = (apiId: string, providerID = "openai", npm = "@ai-sdk/openai"): Provider.Model => ({
  id: ModelV2.ID.make(`${providerID}/${apiId}`),
  providerID: ProviderV2.ID.make(providerID),
  api: { id: apiId, url: "https://api.openai.com", npm },
  name: apiId,
  capabilities: {
    temperature: true,
    reasoning: true,
    attachment: true,
    toolcall: true,
    input: { text: true, audio: false, image: true, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
    interleaved: false,
  },
  cost: { input: 0.03, output: 0.06, cache: { read: 0.001, write: 0.002 } },
  limit: { context: 128000, output: 4096 },
  status: "active",
  options: {},
  headers: {},
  release_date: "2026-01-01",
})

// Deliberately mixed eager/deferred so the split is observable. Insertion
// order differs from alpha order; the sticky snapshot owns wire ordering.
const mixedTools = {
  repository_query: tool({ description: "Semantic repo search", inputSchema: z.object({}) }),
  bash: tool({ description: "Run a command", inputSchema: z.object({}) }),
  banyan_tool_search: tool({ description: "Discover cold tools", inputSchema: z.object({}) }),
  read: tool({ description: "Read a file", inputSchema: z.object({}) }),
  edit_plan: tool({ description: "Plan edits", inputSchema: z.object({}) }),
  glob: tool({ description: "Glob files", inputSchema: z.object({}) }),
}

// Wire (alpha) order of mixedTools: bash, banyan_tool_search, edit_plan,
// glob, read, repository_query.
const EAGER_WIRE = ["bash", "glob", "read"]
const DEFERRED_WIRE = ["banyan_tool_search", "edit_plan", "repository_query"]
const ALL_WIRE = [...EAGER_WIRE, ...DEFERRED_WIRE].toSorted((a, b) => a.localeCompare(b))

const configLayer = (toolSearchDefer: boolean) =>
  Layer.succeed(
    Banyan.BanyanConfigService,
    Banyan.BanyanConfigService.of({
      get: () => Effect.succeed({ banyancode_tool_search_defer: toolSearchDefer }),
      getGlobal: () => Effect.succeed({ banyancode_tool_search_defer: toolSearchDefer }),
      update: () => Effect.succeed({ banyancode_tool_search_defer: toolSearchDefer }),
      updateAgentOverride: () => Effect.succeed({}),
      getAgentOverrides: () => Effect.succeed({}),
      updateAgentPrompt: () => Effect.succeed({}),
    }),
  )

type PrepareOverrides = {
  sessionID?: string
  model?: Provider.Model
  permission?: PermissionV1.Ruleset
  tools?: Record<string, Tool>
  small?: boolean
}

const prepareWith = (layer: Layer.Layer<never, never, never> | undefined, over: PrepareOverrides = {}) => {
  const sessionID = SessionID.make(over.sessionID ?? "ses-toolsearch")
  const model = over.model ?? createModel("gpt-5.4")
  const effect = LLMRequestPrep.prepare({
    user: {
      id: MessageID.make("msg_user-toolsearch"),
      sessionID,
      role: "user",
      time: { created: Date.now() },
      agent: "test",
      model: { providerID: ProviderV2.ID.make(model.providerID), modelID: model.id },
    } satisfies SessionV1.User,
    sessionID,
    model,
    agent: {
      name: "test",
      mode: "primary",
      options: {},
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    } satisfies Agent.Info,
    permission: over.permission ?? [{ permission: "*", pattern: "*", action: "allow" }],
    system: [],
    messages: [{ role: "user", content: "Hello" }],
    ...(over.small !== undefined ? { small: over.small } : {}),
    tools: over.tools ?? mixedTools,
    provider: {
      id: ProviderV2.ID.make("openai"),
      name: "OpenAI",
      source: "api",
      env: [],
      options: {},
      models: {},
    },
    auth: undefined,
    plugin,
    flags,
    isWorkflow: false,
  })
  return Effect.runPromise(layer === undefined ? effect : effect.pipe(Effect.provide(layer)))
}

const hasDeferLoading = (def: unknown): boolean =>
  typeof def === "object" &&
  def !== null &&
  (def as { providerOptions?: { openai?: { deferLoading?: unknown } } }).providerOptions?.openai?.deferLoading === true

beforeEach(() => {
  SessionTools.resetStickySnapshots()
})

describe("SessionTools tool_search classification", () => {
  test("eager set covers the required always-on coding tools", () => {
    for (const name of [
      "bash",
      "read",
      "edit",
      "write",
      "grep",
      "glob",
      "task",
      "todowrite",
      "question",
      "webfetch",
      "websearch",
      "skill",
      "apply_patch",
      "multiedit",
      "ls",
    ]) {
      expect(SessionTools.TOOL_SEARCH_EAGER_NAMES.has(name)).toBe(true)
    }
    expect(SessionTools.TOOL_SEARCH_EAGER_NAMES.size).toBe(15)
  })

  test("supportsToolSearchDefer gates on gpt-5.4+ and the gpt-6 family only", () => {
    for (const id of ["gpt-5.4", "gpt-5.4-2026-03-05", "gpt-5.4-mini", "gpt-5.9", "gpt-6", "gpt-6-astra", "openai/gpt-5.4"]) {
      expect(SessionTools.supportsToolSearchDefer(id)).toBe(true)
    }
    for (const id of ["gpt-5", "gpt-5.3", "gpt-5.2", "gpt-4o", "gpt-60", "gpt-50", "o3-mini"]) {
      expect(SessionTools.supportsToolSearchDefer(id)).toBe(false)
    }
  })

  test("applyToolSearchDefer marks only non-eager tools and appends tool_search", () => {
    const input = Object.fromEntries(
      Object.entries(mixedTools).map(([name, def]) => [name, def as Tool]),
    )
    const result = SessionTools.applyToolSearchDefer(input)
    expect(result.deferred.toSorted((a, b) => a.localeCompare(b))).toEqual(DEFERRED_WIRE)
    for (const name of EAGER_WIRE) expect(hasDeferLoading(result.tools[name])).toBe(false)
    for (const name of DEFERRED_WIRE) expect(hasDeferLoading(result.tools[name])).toBe(true)
    expect(result.tools["tool_search"] as unknown).toEqual({
      type: "provider",
      id: "openai.tool_search",
      args: {},
    })
    // Input record untouched (no in-place mutation).
    expect(hasDeferLoading(input["bash"])).toBe(false)
    expect(input["tool_search"]).toBeUndefined()
  })

  test("all-eager set stays byte-for-byte (no tool_search entry)", () => {
    const eagerOnly = { bash: mixedTools.bash, read: mixedTools.read }
    const result = SessionTools.applyToolSearchDefer(eagerOnly)
    expect(result.deferred).toEqual([])
    expect(result.tools).toBe(eagerOnly)
    expect(result.tools["tool_search"]).toBeUndefined()
  })
})

describe("LLMRequestPrep tool_search defer (banyancode_tool_search_defer)", () => {
  test("flag off (service absent): byte-for-byte current behavior", async () => {
    const prepared = await prepareWith(undefined)
    expect(prepared.deferredTools).toBeUndefined()
    expect(Object.keys(prepared.tools)).toEqual(ALL_WIRE)
    expect(prepared.tools["tool_search"]).toBeUndefined()
    for (const name of ALL_WIRE) expect(hasDeferLoading(prepared.tools[name])).toBe(false)
    expect(prepared.toolSnapshot?.toolNames).toEqual(ALL_WIRE)
  })

  test("flag explicitly false: unchanged", async () => {
    const prepared = await prepareWith(configLayer(false))
    expect(prepared.deferredTools).toBeUndefined()
    expect(Object.keys(prepared.tools)).toEqual(ALL_WIRE)
    expect(prepared.tools["tool_search"]).toBeUndefined()
    for (const name of ALL_WIRE) expect(hasDeferLoading(prepared.tools[name])).toBe(false)
  })

  test("flag on + gpt-5.4: tool_search entry, defer_loading on remainder, eager set intact", async () => {
    const prepared = await prepareWith(configLayer(true))
    expect(prepared.deferredTools?.toSorted((a, b) => a.localeCompare(b))).toEqual(DEFERRED_WIRE)

    const keys = Object.keys(prepared.tools)
    expect(keys).toEqual([...ALL_WIRE, "tool_search"].toSorted((a, b) => a.localeCompare(b)))
    expect(prepared.tools["tool_search"] as unknown).toEqual({
      type: "provider",
      id: "openai.tool_search",
      args: {},
    })

    for (const name of EAGER_WIRE) expect(hasDeferLoading(prepared.tools[name])).toBe(false)
    for (const name of DEFERRED_WIRE) expect(hasDeferLoading(prepared.tools[name])).toBe(true)

    // Sticky snapshot must still freeze the FULL catalog — tool_search is a
    // wire pseudo-entry, never a snapshot name, and eager/deferred membership
    // does not narrow allowedTools.
    expect(prepared.toolSnapshot?.toolNames).toEqual(ALL_WIRE)
    expect(prepared.allowedTools).toEqual(ALL_WIRE)
    expect(prepared.toolChoiceHint).toBeUndefined()
  })

  test("flag on: second turn reuses the snapshot and re-applies the same split", async () => {
    const first = await prepareWith(configLayer(true), { sessionID: "ses-toolsearch-turn" })
    const second = await prepareWith(configLayer(true), {
      sessionID: "ses-toolsearch-turn",
      permission: [
        { permission: "*", pattern: "*", action: "allow" },
        { permission: "edit_plan", pattern: "*", action: "deny" },
      ],
    })
    expect(second.toolSnapshot).toBe(first.toolSnapshot)
    // Wire function names + order unchanged (tools_changed cache miss avoided).
    expect(Object.keys(second.tools)).toEqual(Object.keys(first.tools))
    expect(second.deferredTools?.toSorted((a, b) => a.localeCompare(b))).toEqual(DEFERRED_WIRE)
    // Permission narrowing still only shrinks allowedTools.
    expect(second.allowedTools?.toSorted((a, b) => a.localeCompare(b))).toEqual(
      ALL_WIRE.filter((name) => name !== "edit_plan"),
    )
  })

  test("flag on but pre-5.4 model: gate closed", async () => {
    const prepared = await prepareWith(configLayer(true), { model: createModel("gpt-5.2") })
    expect(prepared.deferredTools).toBeUndefined()
    expect(Object.keys(prepared.tools)).toEqual(ALL_WIRE)
    expect(prepared.tools["tool_search"]).toBeUndefined()
  })

  test("flag on + gpt-6 family: gate open", async () => {
    const prepared = await prepareWith(configLayer(true), { model: createModel("gpt-6-astra") })
    expect(prepared.deferredTools?.toSorted((a, b) => a.localeCompare(b))).toEqual(DEFERRED_WIRE)
    expect(prepared.tools["tool_search"]).toBeDefined()
  })

  test("flag on but non-OpenAI provider: gate closed", async () => {
    const prepared = await prepareWith(configLayer(true), {
      model: createModel("claude-sonnet-4", "anthropic", "@ai-sdk/anthropic"),
    })
    expect(prepared.deferredTools).toBeUndefined()
    expect(prepared.tools["tool_search"]).toBeUndefined()
    for (const name of ALL_WIRE) expect(hasDeferLoading(prepared.tools[name])).toBe(false)
  })

  test("flag on but small request: gate closed", async () => {
    const prepared = await prepareWith(configLayer(true), { small: true })
    expect(prepared.deferredTools).toBeUndefined()
    expect(prepared.tools["tool_search"]).toBeUndefined()
  })
})
