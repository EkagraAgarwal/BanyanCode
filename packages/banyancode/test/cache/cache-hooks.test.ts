import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import * as Cache from "../../src/cache/cache.js"
import {
  captureResponseId,
  lastResponseId,
  resetResponseIds,
} from "../../src/cache/response-ids.js"
import { maybePrewarm, prewarmFiredCount, resetPrewarm } from "../../src/cache/prewarm.js"
import { callHook, configFor, makeContext, withStorage, withTemp } from "../gateway/harness.js"

const setup = async (directory: string, values: Record<string, unknown>) => {
  const config = await configFor(directory, values)
  const harness = makeContext(directory)
  await withStorage(directory, (storage) => Cache.register(harness.ctx, { storage, config })).pipe(Effect.runPromise)
  return harness
}

const requestEvent = (request: Request, providerID = "openai", id = "gpt-5.6") => ({
  sessionID: "ses_abc",
  agent: "build",
  model: { id, providerID },
  kind: "primary" as const,
  request,
})

const jsonRequest = (body: Record<string, unknown>) =>
  new Request("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })

describe("prompt cache hooks", () => {
  test("http.request injects the cache key and options", async () => {
    await withTemp(async (directory) => {
      const harness = await setup(directory, {})
      const event = requestEvent(jsonRequest({ model: "gpt-5.6", input: "hi" }))
      await Effect.runPromise(callHook(harness.session.get("http.request"), event))
      const body = await event.request.json() as Record<string, unknown>
      expect(body.prompt_cache_key).toBe("ses_abc")
      expect(body.prompt_cache_options).toEqual({ mode: "implicit" })
    })
  })

  test("off config strips the fields", async () => {
    await withTemp(async (directory) => {
      const harness = await setup(directory, {
        banyancode_prompt_cache_key: "off",
        banyancode_prompt_cache_mode: "off",
      })
      const event = requestEvent(
        jsonRequest({ prompt_cache_key: "old", prompt_cache_options: { mode: "implicit" } }),
      )
      await Effect.runPromise(callHook(harness.session.get("http.request"), event))
      const body = await event.request.json() as Record<string, unknown>
      expect(body).toEqual({})
    })
  })

  test("non-openai JSON bodies are left untouched", async () => {
    await withTemp(async (directory) => {
      const harness = await setup(directory, {})
      const request = jsonRequest({ model: "claude-sonnet-4" })
      const event = requestEvent(request, "anthropic", "claude-sonnet-4")
      await Effect.runPromise(callHook(harness.session.get("http.request"), event))
      expect(event.request).toBe(request)
    })
  })

  test("non-JSON requests are left untouched", async () => {
    await withTemp(async (directory) => {
      const harness = await setup(directory, {})
      const request = new Request("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: "hello",
      })
      const event = requestEvent(request)
      await Effect.runPromise(callHook(harness.session.get("http.request"), event))
      expect(event.request).toBe(request)
    })
  })

  test("diagnostics records the response id and reuses it as comparison_response_id", async () => {
    await withTemp(async (directory) => {
      resetResponseIds()
      const response = new Response(JSON.stringify({ id: "resp_9" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
      await Effect.runPromise(captureResponseId("ses_abc", response))
      expect(lastResponseId("ses_abc")).toBe("resp_9")

      const harness = await setup(directory, { banyancode_prompt_cache_diagnostics: true })
      const event = requestEvent(jsonRequest({ model: "gpt-5.6" }))
      await Effect.runPromise(callHook(harness.session.get("http.request"), event))
      const body = await event.request.json() as Record<string, unknown>
      expect(body.prompt_cache_options).toEqual({
        mode: "implicit",
        comparison_response_id: "resp_9",
      })
    })
  })

  test("SSE responses never populate the response id", async () => {
    resetResponseIds()
    const response = new Response('data: {"id":"resp_sse"}\n\n', {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    })
    await Effect.runPromise(captureResponseId("ses_sse", response))
    expect(lastResponseId("ses_sse")).toBeUndefined()
  })

  test("prewarm gate is idempotent per model and stable prefix", () => {
    resetPrewarm()
    const input = {
      providerID: "openai",
      modelID: "gpt-5.6",
      promptCacheMode: "implicit",
      enabled: true,
      stablePrefix: "gpt-5.6",
    }
    expect(maybePrewarm(input)).toBe(true)
    expect(maybePrewarm(input)).toBe(false)
    expect(prewarmFiredCount()).toBe(1)
    expect(maybePrewarm({ ...input, modelID: "gpt-5.5" })).toBe(false)
    expect(maybePrewarm({ ...input, promptCacheMode: "off" })).toBe(false)
    expect(maybePrewarm({ ...input, providerID: "anthropic" })).toBe(false)
  })

  test("model.request hook fires the prewarm gate from config", async () => {
    await withTemp(async (directory) => {
      resetPrewarm()
      const harness = await setup(directory, { banyancode_prompt_cache_prewarm: true })
      const event = {
        sessionID: "ses_abc",
        agent: "build",
        model: { id: "gpt-5.6", providerID: "openai" },
        kind: "primary",
        headers: {},
      }
      await Effect.runPromise(callHook(harness.session.get("model.request"), event))
      expect(prewarmFiredCount()).toBe(1)
    })
  })
})
