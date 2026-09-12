# BanyanCode local token telemetry

Status: shipped, local-only. This spec documents the implementation, not a
remote reporting contract.

## Scope and capture point

- V2 only: the V2 session runner supplies `TokenAttribution` to the LLM event
  publisher. V1 is not instrumented.
- One event is captured at `step-finish`, after the step is published and only
  when usage is present.
- The capture point is
  `packages/core/src/session/runner/publish-llm-event.ts:380-404`.
- The service is mounted by the per-location layer at
  `packages/core/src/location-layer.ts:80-90`.

## Event contract

`TokenAttributionInput` is normalized to `TokenAttributionEvent` by
`packages/core/src/banyancode/token-attribution.ts:9-34,52-80`.

Identity and lineage:

- `callID`, `modelID`, `provider`, `sessionID`
- optional `parentSessionID`, `agentRole`, and `depth`
- `startedAt`, `durationMs`, and `status` (`success`, `error`, or `aborted`)
- optional `traceName` and `parentTraceName` when supplied by a caller

Usage fields:

- `inputTokens`, `outputTokens`, `reasoningTokens`, and `totalTokens`
- `cacheReadInputTokens` and `cacheWriteInputTokens`
- `uncachedInputTokens`

`inputTokens` is the provider's inclusive input total (cache components may be
included), while `uncachedInputTokens` is the fresh/non-cached portion.
`outputTokens` is inclusive output; `reasoningTokens` is a subset, not an
additional amount. The canonical `Usage` shape is defined at
`packages/llm/src/schema/events.ts:7-49`.

Normalization rules:

- `durationMs` is clamped to zero or greater.
- `uncachedInputTokens` uses `usage.nonCachedInputTokens` when available.
- Otherwise it is derived only when input, cache-read, and cache-write values
  are all known: `max(0, input - cacheRead - cacheWrite)`.
- Missing usage values remain absent; they are not guessed.

## Cache semantics

Cache reads and writes are separate breakdown fields, while `inputTokens` is
the provider's inclusive total and may include both. A direct provider-supplied
non-cached count wins over the derived value. With incomplete cache components,
no uncached count is emitted. The
tests pin these rules in
`packages/core/test/banyancode/token-attribution.test.ts:61-74`.

## Retention and lifecycle

The service stores events in an in-memory `Ref` and exposes `record`, `recent`,
and `count` (`token-attribution.ts:41-50,83-114`). Defaults are:

- maximum 256 events
- 24-hour retention window

Both options are configurable through `TokenAttribution.layer({ maxEvents,
retentionMs })`. Values are normalized to `maxEvents >= 1` and
`retentionMs >= 0`. Retention is enforced when recording: entries older than
the new event's `startedAt - retentionMs` are removed, then the newest
`maxEvents` are kept. There is no timer-based cleanup.

Each location gets a fresh service layer. Sessions in that location share its
bounded buffer; `recent({ sessionID, since })` provides read-time filtering.
The location map keeps idle services for up to 60 minutes, so this telemetry
is discarded when the location layer is disposed. Retention is applied on the
next record, not by a cleanup timer. It is not shared across locations or
persisted across process starts. If the optional service is absent, V2 runs
without recording.

## Privacy boundary

This implementation is local in-memory state. It performs no network request,
does not use PostHog, and does not write a database or file. It records no
prompts, completions, tool arguments or results, output paths, provider
metadata/payloads, hostnames, usernames, or device identifiers. The stored
shape is limited to the fields listed above, though IDs, provider/model names,
agent role, trace names, and timing remain metadata in memory. The
provider-payload exclusion is asserted at
`packages/core/test/banyancode/token-attribution.test.ts:33-59`.

## Current limitations

- No persistence or cross-process aggregation.
- No PostHog transport or dashboard event.
- No finding telemetry, overlap telemetry, or ablation telemetry yet.
- Only successful `step-finish` usage is currently recorded by the V2
  publisher; provider failures and interrupted steps do not create an
  attribution record there.
- The buffer is bounded but is not an accounting ledger; evicted events cannot
  be recovered.

## Verification and future use

From `packages/core`, run:

```text
bun test test/banyancode/token-attribution.test.ts
bun test test/session-runner-tool-events.test.ts
```

The service-level tests cover normalization, cache-component handling,
retention, and bounds at
`packages/core/test/banyancode/token-attribution.test.ts:32-89`.
The V2 integration test proves capture at step finish at
`packages/core/test/session-runner-tool-events.test.ts:131-161`.

Future phases should consume `recent`/`count` through the service boundary,
add tests before changing the event contract, and explicitly choose a
persistence and transport policy. Do not infer remote telemetry or durable
historical totals from this buffer.
