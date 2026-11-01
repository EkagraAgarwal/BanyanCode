export * as Cache from "./cache.js"

import type { Context } from "@opencode/plugin/effect/plugin"
import { Cause, Effect, type Scope } from "effect"
import type { BanyanConfig } from "../config/index.js"
import type { Storage } from "../storage/index.js"
import { planBody } from "./policy.js"
import { maybePrewarm } from "./prewarm.js"
import { captureResponseId, lastResponseId } from "./response-ids.js"

export interface CacheDeps {
  readonly storage: Storage.Interface
  readonly config: BanyanConfig.Interface
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/**
 * Prompt-cache tuning. The `model.request` hook fires the (network-less)
 * prewarm gate; `http.request` applies the provider-options payload;
 * `http.response` records the last response id for diagnostics.
 */
export const register = (ctx: Context, deps: CacheDeps): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function* () {
    yield* ctx.session.hook("model.request", (event) =>
      Effect.gen(function* () {
        const loaded = yield* deps.config.get()
        maybePrewarm({
          providerID: event.model.providerID,
          modelID: event.model.id,
          promptCacheMode: loaded.config.banyancode_prompt_cache_mode ?? "implicit",
          enabled: loaded.config.banyancode_prompt_cache_prewarm ?? false,
          stablePrefix: event.model.id,
        })
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("prompt cache prewarm gate failed", { cause: Cause.pretty(cause) }),
        ),
      ),
    )

    yield* ctx.session.hook("http.request", (event) =>
      Effect.gen(function* () {
        const loaded = yield* deps.config.get()
        const contentType = event.request.headers.get("content-type")?.toLowerCase() ?? ""
        // Only JSON bodies carry the cache fields. Streaming bodies are not
        // request-side, so this is a cheap guard.
        if (!contentType.includes("json")) return
        const text = yield* Effect.tryPromise({
          try: () => event.request.clone().text(),
          catch: () => undefined,
        })
        if (typeof text !== "string") return
        const parsed = yield* Effect.try({
          try: () => JSON.parse(text) as unknown,
          catch: () => undefined,
        })
        if (!isRecord(parsed)) return
        const comparisonResponseID = lastResponseId(event.sessionID)
        const plan = planBody({
          config: loaded.config,
          providerID: event.model.providerID,
          modelID: event.model.id,
          sessionID: event.sessionID,
          body: parsed,
          ...(comparisonResponseID === undefined ? {} : { comparisonResponseID }),
        })
        if (!plan.changed) return
        event.request = new Request(event.request, { body: JSON.stringify(plan.body) })
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("prompt cache body rewrite failed", { cause: Cause.pretty(cause) }),
        ),
      ),
    )

    yield* ctx.session.hook("http.response", (event) =>
      Effect.gen(function* () {
        const loaded = yield* deps.config.get()
        if (loaded.config.banyancode_prompt_cache_diagnostics !== true) return
        yield* captureResponseId(event.sessionID, event.response)
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("prompt cache diagnostics capture failed", { cause: Cause.pretty(cause) }),
        ),
      ),
    )
  })
