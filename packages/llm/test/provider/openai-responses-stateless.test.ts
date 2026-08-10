import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { LLM, Message, ToolCallPart } from "../../src"
import { Auth, LLMClient } from "../../src/route"
import * as OpenAIResponses from "../../src/protocols/openai-responses"
import { OpenAIOptions } from "../../src/protocols/utils/openai-options"
import { it } from "../lib/effect"

// OpenAI-compatible deployment (meta) that speaks the Responses protocol but
// does not document OpenAI's server-side `store` / `item_reference` semantics.
const compatibleModel = OpenAIResponses.route
  .with({ provider: "meta", endpoint: { baseURL: "https://api.meta.test/v1/" }, auth: Auth.bearer("test") })
  .model({ id: "llama-4-scout-17b" })

const openaiModel = OpenAIResponses.route
  .with({ endpoint: { baseURL: "https://api.openai.test/v1/" }, auth: Auth.bearer("test") })
  .model({ id: "gpt-4.1-mini" })

const reasoningPart = {
  type: "reasoning",
  text: "Checked the previous diff.",
  providerMetadata: { openai: { itemId: "rs_1", reasoningEncryptedContent: "encrypted-state" } },
} as const

describe("OpenAI Responses stateless mode", () => {
  it.effect("lowers full items with store:false for OpenAI-compatible routes", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
        LLM.request({
          model: compatibleModel,
          messages: [
            Message.user("What changed?"),
            Message.assistant([reasoningPart, { type: "text", text: "The parser changed." }]),
            Message.assistant([ToolCallPart.make({ id: "call_1", name: "lookup", input: { query: "weather" } })]),
            Message.tool({ id: "call_1", name: "lookup", result: { forecast: "sunny" } }),
            Message.user("Summarize it."),
          ],
        }),
      )

      expect(prepared.body.store).toBe(false)
      expect(prepared.body.include).toEqual(["reasoning.encrypted_content"])
      expect(prepared.body.input).not.toContainEqual(expect.objectContaining({ type: "item_reference" }))
      expect(prepared.body.input).toContainEqual({
        type: "reasoning",
        id: "rs_1",
        encrypted_content: "encrypted-state",
        summary: [{ type: "summary_text", text: "Checked the previous diff." }],
      })
      expect(prepared.body.input).toContainEqual({
        type: "function_call",
        call_id: "call_1",
        name: "lookup",
        arguments: '{"query":"weather"}',
      })
      expect(prepared.body.input).toContainEqual({
        type: "function_call_output",
        call_id: "call_1",
        output: '{"forecast":"sunny"}',
      })
    }),
  )

  it.effect("drops hosted tool references for OpenAI-compatible routes", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
        LLM.request({
          model: compatibleModel,
          messages: [
            Message.assistant([
              ToolCallPart.make({
                id: "ws_1",
                name: "web_search",
                input: { query: "effect 4" },
                providerExecuted: true,
                providerMetadata: { openai: { itemId: "ws_1" } },
              }),
              {
                type: "tool-result",
                id: "ws_1",
                name: "web_search",
                result: { type: "json", value: { type: "web_search_call", id: "ws_1", status: "completed" } },
                providerExecuted: true,
                providerMetadata: { openai: { itemId: "ws_1" } },
              },
            ]),
            Message.user("Continue."),
          ],
        }),
      )

      expect(prepared.body.input).toEqual([
        { role: "user", content: [{ type: "input_text", text: "Continue." }] },
      ])
      expect(prepared.body.input).not.toContainEqual(expect.objectContaining({ type: "item_reference" }))
    }),
  )

  it.effect("keeps item_reference for OpenAI's own route", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
        LLM.request({
          model: openaiModel,
          messages: [
            Message.assistant([
              {
                type: "reasoning",
                text: "Checked the previous diff.",
                providerMetadata: { openai: { itemId: "rs_1" } },
              },
            ]),
          ],
          providerOptions: { openai: { store: true } },
        }),
      )

      expect(prepared.body.store).toBe(true)
      expect(prepared.body.input).toEqual([{ type: "item_reference", id: "rs_1" }])
    }),
  )

  it.effect("merges the encrypted-reasoning include with caller includes", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
        LLM.request({
          model: compatibleModel,
          prompt: "hi",
          providerOptions: { openai: { include: ["web_search_call.results"] } },
        }),
      )

      expect(prepared.body.include).toEqual(["reasoning.encrypted_content", "web_search_call.results"])
    }),
  )

  it.effect("keeps a caller include that already has encrypted reasoning", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
        LLM.request({
          model: compatibleModel,
          prompt: "hi",
          providerOptions: {
            openai: { include: ["reasoning.encrypted_content", "code_interpreter_call.outputs"] },
          },
        }),
      )

      expect(prepared.body.include).toEqual(["reasoning.encrypted_content", "code_interpreter_call.outputs"])
    }),
  )

  it.effect("does not emit prompt_cache_key for compatible providers by default", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
        LLM.request({ model: compatibleModel, prompt: "hi" }),
      )
      expect(prepared.body).not.toHaveProperty("prompt_cache_key")
    }),
  )

  it.effect("emits an explicitly passed prompt_cache_key for compatible providers", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
        LLM.request({
          model: compatibleModel,
          prompt: "hi",
          providerOptions: { openai: { promptCacheKey: "explicit-key" } },
        }),
      )
      expect(prepared.body.prompt_cache_key).toBe("explicit-key")
    }),
  )

  it.effect("serializes identical history byte-identically across requests", () =>
    Effect.gen(function* () {
      const history = [
        Message.user("What changed?"),
        Message.assistant([reasoningPart, { type: "text", text: "The parser changed." }]),
        Message.assistant([ToolCallPart.make({ id: "call_1", name: "lookup", input: { query: "weather" } })]),
        Message.tool({ id: "call_1", name: "lookup", result: { forecast: "sunny" } }),
        Message.user("Summarize it."),
      ]
      const first = yield* LLMClient.prepare(LLM.request({ model: compatibleModel, messages: history }))
      const second = yield* LLMClient.prepare(LLM.request({ model: compatibleModel, messages: history }))
      const repeat = yield* LLMClient.prepare(LLM.request({ model: compatibleModel, messages: history }))
      expect(JSON.stringify(first.body)).toBe(JSON.stringify(second.body))
      expect(JSON.stringify(repeat.body)).toBe(JSON.stringify(first.body))
    }),
  )
})

const SESSION_ID = `ses_${"a".repeat(64)}`

describe("prompt cache key policy", () => {
  test("auto sends the session id only to documented providers", () => {
    expect(OpenAIOptions.promptCacheKeyPolicy("auto", "openai", SESSION_ID)).toBe("a".repeat(64))
    expect(OpenAIOptions.promptCacheKeyPolicy("auto", "openrouter", SESSION_ID)).toBe("a".repeat(64))
    expect(OpenAIOptions.promptCacheKeyPolicy("auto", "mistral", SESSION_ID)).toBe("a".repeat(64))
    expect(OpenAIOptions.promptCacheKeyPolicy("auto", "meta", SESSION_ID)).toBeUndefined()
    expect(OpenAIOptions.promptCacheKeyPolicy("auto", "deepseek", SESSION_ID)).toBeUndefined()
    expect(OpenAIOptions.promptCacheKeyPolicy("auto", "togetherai", SESSION_ID)).toBeUndefined()
  })

  test("off suppresses the key for every provider", () => {
    expect(OpenAIOptions.promptCacheKeyPolicy("off", "openai", SESSION_ID)).toBeUndefined()
    expect(OpenAIOptions.promptCacheKeyPolicy("off", "meta", SESSION_ID)).toBeUndefined()
  })

  test("an explicit string is always sent", () => {
    expect(OpenAIOptions.promptCacheKeyPolicy("my-cache-key", "openai", SESSION_ID)).toBe("my-cache-key")
    expect(OpenAIOptions.promptCacheKeyPolicy("my-cache-key", "meta", SESSION_ID)).toBe("my-cache-key")
  })

  test("non-ses session ids pass through unchanged", () => {
    expect(OpenAIOptions.promptCacheKeyPolicy("auto", "openai", "plain-session-id")).toBe("plain-session-id")
  })

  test("explicit providerOptions keys win for any provider", () => {
    const keyed = LLM.request({
      model: compatibleModel,
      prompt: "hi",
      providerOptions: { openai: { promptCacheKey: "explicit-key" } },
    })
    expect(OpenAIOptions.promptCacheKey(keyed)).toBe("explicit-key")
    const openaiKeyed = LLM.request({
      model: openaiModel,
      prompt: "hi",
      providerOptions: { openai: { promptCacheKey: "explicit-key" } },
    })
    expect(OpenAIOptions.promptCacheKey(openaiKeyed)).toBe("explicit-key")
    expect(OpenAIOptions.promptCacheKey(LLM.request({ model: compatibleModel, prompt: "hi" }))).toBeUndefined()
  })
})
