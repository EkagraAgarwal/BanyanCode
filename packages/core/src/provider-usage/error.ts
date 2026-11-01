import { Schema } from "effect"

/**
 * A typed, secret-safe adapter failure.
 *
 * Every `message` is built from static text here (or sanitized by
 * `redactSecrets` before it reaches a snapshot). Credentials, authorization
 * headers, account ids, raw upstream bodies, and request objects are never
 * attached — an adapter only reports a reason and a short label.
 */
export class ProviderUsageError extends Schema.TaggedError<ProviderUsageError>()("ProviderUsage.Error", {
  providerID: Schema.String,
  reason: Schema.Literals(["unauthenticated", "rate_limited", "upstream", "unsupported", "network"]),
  message: Schema.String,
  retryAfterMs: Schema.optional(Schema.Number),
}) {}
