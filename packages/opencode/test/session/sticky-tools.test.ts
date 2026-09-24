import { beforeEach, describe, expect, test } from "bun:test"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { tool, type Tool } from "ai"
import { Effect } from "effect"
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

// Insertion order (read, bash, edit) deliberately differs from alpha order so
// the frozen snapshot proves it owns wire ordering.
const defaultTools = {
  read: tool({ description: "Read a file", inputSchema: z.object({}) }),
  bash: tool({ description: "Run a command", inputSchema: z.object({}) }),
  edit: tool({ description: "Edit a file", inputSchema: z.object({}) }),
}

type PrepareOverrides = {
  sessionID?: string
  model?: Provider.Model
  permission?: PermissionV1.Ruleset
  tools?: Record<string, Tool>
  small?: boolean
}

const prepare = (over: PrepareOverrides = {}) => {
  const sessionID = SessionID.make(over.sessionID ?? "ses-sticky")
  const model = over.model ?? createModel("gpt-5.2")
  return Effect.runPromise(
    LLMRequestPrep.prepare({
      user: {
        id: MessageID.make("msg_user-sticky"),
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
      tools: over.tools ?? defaultTools,
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
    }),
  )
}

beforeEach(() => {
  SessionTools.resetStickySnapshots()
})

describe("session.llm sticky tool snapshot (WS5a)", () => {
  test("permission revoke keeps wire tools identical and shrinks allowedTools", async () => {
    const first = await prepare()
    expect(Object.keys(first.tools)).toEqual(["bash", "edit", "read"])
    expect(first.allowedTools).toEqual(["bash", "edit", "read"])
    expect(first.toolChoiceHint).toBeUndefined()
    expect(first.toolSnapshot?.sessionID).toBe("ses-sticky")
    expect(first.toolSnapshot?.modelID).toBe("gpt-5.2")
    expect(first.toolSnapshot?.toolNames).toEqual(["bash", "edit", "read"])

    const revoked = await prepare({
      permission: [
        { permission: "*", pattern: "*", action: "allow" },
        { permission: "edit", pattern: "*", action: "deny" },
      ],
    })
    // Wire tools (defs + order) unchanged — no tools_changed cache miss.
    expect(Object.keys(revoked.tools)).toEqual(Object.keys(first.tools))
    expect(revoked.tools.edit).toBeDefined()
    // Only the callable set narrows; same frozen snapshot object is reused.
    expect(revoked.allowedTools).toEqual(["bash", "read"])
    expect(revoked.toolChoiceHint).toBeUndefined()
    expect(revoked.toolSnapshot).toBe(first.toolSnapshot)
  })

  test("revoking every callable tool sets toolChoiceHint to none without shrinking wire tools", async () => {
    const first = await prepare()
    const revoked = await prepare({ permission: [{ permission: "*", pattern: "*", action: "deny" }] })
    expect(Object.keys(revoked.tools)).toEqual(Object.keys(first.tools))
    expect(revoked.allowedTools).toEqual([])
    expect(revoked.toolChoiceHint).toBe("none")
  })

  test("model switch creates a fresh snapshot that re-freezes the current set", async () => {
    const first = await prepare({ model: createModel("gpt-5.2") })
    expect(first.toolSnapshot?.modelID).toBe("gpt-5.2")

    // A tool added to the registry mid-session stays off the frozen wire for
    // the original model.
    const glob = tool({ description: "Glob files", inputSchema: z.object({}) })
    const grown = { ...defaultTools, glob }
    const sameModel = await prepare({ tools: grown })
    expect(sameModel.toolSnapshot).toBe(first.toolSnapshot)
    expect(Object.keys(sameModel.tools)).toEqual(["bash", "edit", "read"])
    expect(sameModel.allowedTools).toEqual(["bash", "edit", "read"])

    // The model is part of the snapshot key: the first request on a new model
    // re-freezes from the CURRENT set (glob included).
    const switched = await prepare({ model: createModel("gpt-5.6"), tools: grown })
    expect(switched.toolSnapshot).not.toBe(first.toolSnapshot)
    expect(switched.toolSnapshot?.modelID).toBe("gpt-5.6")
    expect(switched.toolSnapshot?.sessionID).toBe(first.toolSnapshot?.sessionID)
    expect(switched.toolSnapshot?.toolNames).toEqual(["bash", "edit", "glob", "read"])
    expect(Object.keys(switched.tools)).toEqual(["bash", "edit", "glob", "read"])
  })

  test("non-OpenAI providers keep today's wire filtering (sticky gate off)", async () => {
    const model = createModel("claude-sonnet-4", "anthropic", "@ai-sdk/anthropic")
    const first = await prepare({ model })
    expect(first.toolSnapshot).toBeUndefined()
    expect(first.allowedTools).toBeUndefined()
    expect(first.toolChoiceHint).toBeUndefined()

    const revoked = await prepare({
      model,
      permission: [
        { permission: "*", pattern: "*", action: "allow" },
        { permission: "edit", pattern: "*", action: "deny" },
      ],
    })
    expect(Object.keys(revoked.tools)).toEqual(["bash", "read"])
  })

  test("small requests bypass the snapshot so title-gen tools:{} cannot freeze it", async () => {
    const small = await prepare({ small: true, tools: {} })
    expect(small.toolSnapshot).toBeUndefined()
    expect(small.allowedTools).toBeUndefined()

    const real = await prepare()
    expect(real.toolSnapshot?.toolNames).toEqual(["bash", "edit", "read"])
    expect(Object.keys(real.tools)).toEqual(["bash", "edit", "read"])
  })
})
