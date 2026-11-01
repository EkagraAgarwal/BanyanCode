export * as CacheResponseIds from "./response-ids.js"

import { Cause, Effect } from "effect"

// Last completed provider response id per session, used for
// `prompt_cache_options.comparison_response_id` when diagnostics are enabled.
// v2's `session.http.response` hook is the only available seam; streaming
// (SSE) responses are skipped, so diagnostics populate for JSON responses only.

const MAX_BYTES = 1024 * 1024
const ids = new Map<string, string>()

export const rememberResponseId = (sessionID: string, id: string): void => {
  ids.set(sessionID, id)
}

export const lastResponseId = (sessionID: string): string | undefined => ids.get(sessionID)

export const resetResponseIds = (): void => {
  ids.clear()
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export const captureResponseId = (
  sessionID: string,
  response: Response,
): Effect.Effect<void, never, never> =>
  Effect.gen(function* () {
    if (response.status < 200 || response.status >= 300) return
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? ""
    if (!contentType.includes("application/json")) return
    const length = Number(response.headers.get("content-length") ?? "0")
    if (Number.isFinite(length) && length > MAX_BYTES) return
    const text = yield* Effect.tryPromise({
      try: () => response.clone().text(),
      catch: () => undefined,
    })
    if (typeof text !== "string" || text.length > MAX_BYTES) return
    const parsed = yield* Effect.try({
      try: () => JSON.parse(text) as unknown,
      catch: () => undefined,
    })
    if (!isRecord(parsed)) return
    const direct = typeof parsed.id === "string" ? parsed.id : undefined
    const nested = isRecord(parsed.response) && typeof parsed.response.id === "string" ? parsed.response.id : undefined
    const id = direct ?? nested
    if (id !== undefined && id.length > 0) rememberResponseId(sessionID, id)
    if (parsed.prompt_cache_diagnostics !== undefined) {
      yield* Effect.logInfo("prompt cache diagnostics", {
        "session.id": sessionID,
        diagnostics: parsed.prompt_cache_diagnostics,
      })
    }
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("prompt cache response id capture failed", { cause: Cause.pretty(cause) }),
    ),
  )
