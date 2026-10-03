import type { NamedError } from "@opencode-ai/core/util/error"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Cause, Clock, Duration, Effect, Schedule } from "effect"
import { MessageV2 } from "./message-v2"
import { iife } from "@/util/iife"
import { isRecord } from "@/util/record"

export type Err = ReturnType<NamedError["toObject"]>

export const GO_UPSELL_MESSAGE = "Free usage exceeded, subscribe to Go"
export const GO_UPSELL_URL = "https://opencode.ai/go"
export type RetryReason = "free_tier_limit" | "account_rate_limit" | (string & {})

export type Retryable = {
  message: string
  action?: {
    reason: RetryReason
    provider: string
    title: string
    message: string
    label: string
    link?: string
  }
}

export const RETRY_INITIAL_DELAY = 2000
export const RETRY_BACKOFF_FACTOR = 2
export const RETRY_MAX_DELAY_NO_HEADERS = 30_000 // 30 seconds
export const RETRY_MAX_DELAY = 2_147_483_647 // max 32-bit signed integer for setTimeout
// Cap total retries even when the provider keeps reporting transient errors.
// Without this, a sustained outage keeps allocating new fibers and error
// objects per retry — the loop only terminates when the schedule itself is
// cancelled. Permanent errors (e.g. invalid model) already short-circuit
// via Cause.done; this guard is for the retryable transient case.
export const RETRY_MAX_ATTEMPTS = 5

// Deterministic terminal quota-exhaustion signals. These are permanent
// account/billing states — retrying them (even with backoff) only burns
// fibers and delays the actionable error. Classification is pure
// string/status matching; Jev is never consulted for HTTP status
// interpretation.
//
// FreeUsageLimitError / GoUsageLimitError are NOT terminal: they carry the
// subscription/action UX consumed by the retry status surface and stay
// retryable via the branches below. Exclusions win globally: if any
// examined string carries a Free/Go marker, the error is never terminal,
// even when another field also mentions quota/billing.
const QUOTA_SIGNALS = [
  "insufficient_quota",
  "insufficient quota",
  "exceeded your current quota",
  "quota_exceeded",
  "quota exceeded",
  "billing_hard_limit",
  "billing hard limit",
] as const

const QUOTA_EXCLUSIONS = ["FreeUsageLimitError", "GoUsageLimitError"] as const

function containsExclusion(value: unknown): boolean {
  if (typeof value !== "string" || value.length === 0) return false
  return QUOTA_EXCLUSIONS.some((marker) => value.includes(marker))
}

function containsQuotaSignal(value: unknown): boolean {
  if (typeof value !== "string" || value.length === 0) return false
  const lower = value.toLowerCase()
  return QUOTA_SIGNALS.some((signal) => lower.includes(signal))
}

function jsonQuotaSignal(value: unknown): boolean {
  if (!isRecord(value)) return false
  for (const key of ["code", "type"] as const) {
    if (containsQuotaSignal(value[key])) return true
  }
  const nested = value["error"]
  if (isRecord(nested)) {
    for (const key of ["code", "type", "message"] as const) {
      if (containsQuotaSignal(nested[key])) return true
    }
  }
  return false
}

/**
 * True when the error is a terminal quota/billing exhaustion: never retryable,
 * regardless of `isRetryable` or status arithmetic. Returns false for the
 * Free/Go limit markers (they keep their action UX) and for plain transient
 * rate limits (429 without a quota signal stays retryable).
 */
export function isTerminalQuotaExhaustion(error: Err): boolean {
  if (SessionV1.APIError.isInstance(error)) {
    const candidates = [error.data.responseBody, error.data.message]
    if (candidates.some(containsExclusion)) return false
    const parsed = parseJSON(error.data.responseBody)
    if (isRecord(parsed)) {
      const top = [parsed["code"], parsed["type"]]
      if (top.some(containsExclusion)) return false
      const nested = parsed["error"]
      if (isRecord(nested) && [nested["code"], nested["type"], nested["message"]].some(containsExclusion))
        return false
    }
    if (error.data.statusCode === 402) return true
    if (candidates.some(containsQuotaSignal)) return true
    if (jsonQuotaSignal(parsed)) return true
    return false
  }
  const msg = isRecord(error.data) ? error.data.message : undefined
  if (typeof msg !== "string") return false
  if (containsExclusion(msg)) return false
  const parsed = parseJSON(msg)
  if (isRecord(parsed)) {
    const all = [parsed["code"], parsed["type"]]
    if (all.some(containsExclusion)) return false
    const nested = parsed["error"]
    if (isRecord(nested) && [nested["code"], nested["type"], nested["message"]].some(containsExclusion))
      return false
  }
  if (containsQuotaSignal(msg)) return true
  return jsonQuotaSignal(parsed)
}

function cap(ms: number) {
  return Math.min(ms, RETRY_MAX_DELAY)
}

export function delay(attempt: number, error?: SessionV1.APIError) {
  if (error) {
    const headers = error.data.responseHeaders
    if (headers) {
      const retryAfterMs = headers["retry-after-ms"]
      if (retryAfterMs) {
        const parsedMs = Number.parseFloat(retryAfterMs)
        if (!Number.isNaN(parsedMs)) {
          return cap(parsedMs)
        }
      }

      const retryAfter = headers["retry-after"]
      if (retryAfter) {
        const parsedSeconds = Number.parseFloat(retryAfter)
        if (!Number.isNaN(parsedSeconds)) {
          // convert seconds to milliseconds
          return cap(Math.ceil(parsedSeconds * 1000))
        }
        // Try parsing as HTTP date format
        const parsed = Date.parse(retryAfter) - Date.now()
        if (!Number.isNaN(parsed) && parsed > 0) {
          return cap(Math.ceil(parsed))
        }
      }

      return cap(RETRY_INITIAL_DELAY * Math.pow(RETRY_BACKOFF_FACTOR, attempt - 1))
    }
  }

  return cap(Math.min(RETRY_INITIAL_DELAY * Math.pow(RETRY_BACKOFF_FACTOR, attempt - 1), RETRY_MAX_DELAY_NO_HEADERS))
}

export function retryable(error: Err, provider: string) {
  // context overflow errors should not be retried
  if (SessionV1.ContextOverflowError.isInstance(error)) return undefined
  // terminal quota/billing exhaustion is never retried, even when the
  // provider SDK marks it retryable. The Retryable shape below is unchanged:
  // SessionProcessor.policy passes `action` straight through to the retry
  // status surface, so subscription/action UX is preserved by construction.
  if (isTerminalQuotaExhaustion(error)) return undefined
  if (SessionV1.APIError.isInstance(error)) {
    const status = error.data.statusCode
    // 5xx errors are transient server failures and should always be retried,
    // even when the provider SDK doesn't explicitly mark them as retryable.
    if (!error.data.isRetryable && !(status !== undefined && status >= 500)) return undefined
    if (error.data.responseBody?.includes("FreeUsageLimitError")) {
      return {
        message: GO_UPSELL_MESSAGE,
        action: {
          reason: "free_tier_limit",
          provider,
          title: "Free limit reached",
          message: "Subscribe to OpenCode Go for reliable access to the best open-source models, starting at $5/month.",
          label: "subscribe",
          link: GO_UPSELL_URL,
        },
      }
    }
    if (error.data.responseBody?.includes("GoUsageLimitError")) {
      const body = parseJSON(error.data.responseBody)
      const workspace = str(body?.metadata?.workspace)
      const limitName = str(body?.metadata?.limitName)
      const retryAfter = num(error.data.responseHeaders?.["retry-after"])
      const resetIn = iife(() => {
        if (retryAfter === undefined) return ""
        const seconds = Math.max(0, Math.ceil(retryAfter))
        const days = Math.floor(seconds / 86_400)
        const hours = Math.floor((seconds % 86_400) / 3_600)
        const minutes = Math.ceil((seconds % 3_600) / 60)
        const unit = (value: number, name: string) => `${value} ${name}${value === 1 ? "" : "s"}`

        if (days > 0) return hours > 0 ? `${unit(days, "day")} ${unit(hours, "hour")}` : unit(days, "day")
        if (hours > 0) return minutes > 0 ? `${unit(hours, "hour")} ${unit(minutes, "minute")}` : unit(hours, "hour")
        return minutes > 0 ? unit(minutes, "minute") : "less than a minute"
      })

      const message = `${limitName ? `${limitName} usage limit` : "Usage limit"} reached. It will reset in ${resetIn}. To continue using this model now, enable usage from your available balance`

      const link = `https://opencode.ai/workspace/${workspace}/go`
      return {
        message: `${message} - ${link}`,
        action: {
          reason: "account_rate_limit",
          provider,
          title: "Go limit reached",
          message,
          label: "open settings",
          link,
        },
      }
    }
    return { message: error.data.message.includes("Overloaded") ? "Provider is overloaded" : error.data.message }
  }

  // Check for rate limit patterns in plain text error messages
  const msg = isRecord(error.data) ? error.data.message : undefined
  if (typeof msg === "string") {
    const lower = msg.toLowerCase()
    if (
      lower.includes("rate increased too quickly") ||
      lower.includes("rate limit") ||
      lower.includes("too many requests")
    ) {
      return { message: msg }
    }
  }

  const json = parseJSON(msg)
  if (!json || typeof json !== "object") return undefined
  const code = typeof json.code === "string" ? json.code : ""

  if (json.type === "error" && json.error?.type === "too_many_requests") {
    return { message: "Too Many Requests" }
  }
  if (code.includes("exhausted") || code.includes("unavailable")) {
    return { message: "Provider is overloaded" }
  }
  if (json.type === "error" && typeof json.error?.code === "string" && json.error.code.includes("rate_limit")) {
    return { message: "Rate Limited" }
  }
  return undefined
}

function str(value: unknown) {
  if (value === undefined || value === null) return ""
  return String(value)
}

function num(value: unknown) {
  const parsed = Number.parseFloat(str(value))
  if (Number.isNaN(parsed)) return undefined
  return parsed
}

function parseJSON(value: unknown) {
  return iife(() => {
    try {
      if (typeof value !== "string") return undefined
      return JSON.parse(value)
    } catch {
      return undefined
    }
  })
}

export function policy(opts: {
  provider: string
  parse: (error: unknown) => Err
  set: (input: { attempt: number; message: string; action?: Retryable["action"]; next: number }) => Effect.Effect<void>
}) {
  return Schedule.fromStepWithMetadata(
    Effect.succeed((meta: Schedule.InputMetadata<unknown>) => {
      const error = opts.parse(meta.input)
      const retry = retryable(error, opts.provider)
      if (!retry) return Cause.done(meta.attempt)
      if (meta.attempt > RETRY_MAX_ATTEMPTS) return Cause.done(meta.attempt)
      return Effect.gen(function* () {
        const wait = delay(meta.attempt, SessionV1.APIError.isInstance(error) ? error : undefined)
        const now = yield* Clock.currentTimeMillis
        yield* opts.set({
          attempt: meta.attempt,
          message: retry.message,
          action: retry.action,
          next: now + wait,
        })
        return [meta.attempt, Duration.millis(wait)] as [number, Duration.Duration]
      })
    }),
  )
}

export * as SessionRetry from "./retry"
