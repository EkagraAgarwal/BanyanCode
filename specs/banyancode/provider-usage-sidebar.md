# Provider Usage Sidebar

## Status

Implementation plan. The feature is first-class and enabled automatically; it is not gated behind an experimental flag.

## Objective

Add a compact sidebar widget directly below System Resources that shows the usage limits, rate limits, balances, and reset times exposed by every explicitly configured or connected provider.

The implementation must never invent a quota. Providers without a usable usage source remain represented as unavailable, while providers with exact, reported, or estimated data are labelled accordingly.

## Behavior Contract

- Discover every explicitly configured or connected provider automatically.
- Show exact remaining limits and reset times when the provider exposes an account usage endpoint.
- Show current rate-limit windows when only response headers are available.
- Show remaining credits when the provider exposes a balance endpoint.
- Show `Usage unavailable` when no usable source exists.
- Isolate provider failures so one failed adapter does not block other providers.
- Keep credentials, upstream headers, and raw upstream responses on the server.
- Allow built-in and third-party providers to register adapters without extending a central provider switch.

## Initial Provider Coverage

| Provider | Initial support | Source | Confidence |
|---|---|---|---|
| OpenCode Go | Rolling, weekly, and monthly usage | `GET https://opencode.ai/zen/go/v1/usage` | Exact, documented |
| ChatGPT/Codex OAuth | Five-hour, weekly, and additional limits | `GET https://chatgpt.com/backend-api/wham/usage` | Exact, undocumented |
| Anthropic OAuth | Session and weekly limits | Anthropic OAuth usage endpoint | Exact, undocumented |
| GitHub Copilot | Requests and entitlement | `GET https://api.github.com/copilot_internal/user` | Exact, undocumented |
| OpenRouter | Limit, usage, and remaining credits | `GET https://openrouter.ai/api/v1/key` | Exact, documented |
| Kimi | Coding-plan usage | Vendor usage endpoint | Exact, vendor-defined |
| Zhipu | Usage and quota | Vendor quota endpoint | Exact, vendor-defined |
| MiniMax | Coding-plan remaining usage | Vendor plan endpoint | Exact, vendor-defined |
| OpenAI API key | Current request/token rate limits | Response headers | Reported |
| Anthropic API key | Current request/token rate limits | Response headers | Reported |
| xAI, Groq, Cerebras, Mistral, Perplexity | Rate limits when returned | Response headers | Reported |
| Custom OpenAI-compatible providers | Best-effort common rate-limit headers | Response headers | Reported or unavailable |
| Gemini API key | No account quota endpoint | None | Unavailable |
| Azure, Bedrock, Vertex | Requires separate cloud IAM and billing APIs | None through ordinary provider credentials | Unavailable |
| Together, DeepInfra | Balance endpoints require verification | None initially | Unavailable |

Do not display local token counts as remaining provider quota unless a provider-defined limit is also known. Local counts may be shown separately as usage, but not as an estimated subscription balance.

## Prior Art

The implementation may use these MIT-licensed projects as references:

- `slkiser/opencode-quota`: OpenCode Go usage adapter and credential precedence.
- `xihuai18/opencode-quota-sidebar`: Codex, Anthropic, Copilot, Kimi, Zhipu, and MiniMax adapters, plus server/TUI separation.
- `50sotero/opencode-usage-quota`: exact, reported, and estimated confidence labels.
- `ridho9/opencode-go-usage`: historical reference only; its HTML scraping path is obsolete.

Do not copy from `ranjithrajv/opencode-usage-quota-tracker`; it is AGPL-3.0 and is reference-only.

## Normalized Data Model

Add `packages/core/src/banyancode/provider-usage.ts` with Effect schemas for a normalized provider snapshot.

```ts
interface ProviderUsageSnapshot {
  providerID: string
  displayName: string
  status: "available" | "stale" | "unsupported" | "unauthenticated" | "error"
  confidence: "exact" | "reported" | "estimated"
  windows: ProviderUsageWindow[]
  balance?: {
    remaining: number
    currency?: string
  }
  message?: string
  fetchedAt: number
}

interface ProviderUsageWindow {
  id: string
  label: string
  kind: "quota" | "rate_limit"
  usedPercent?: number
  remainingPercent?: number
  resetsAt?: number
  durationSeconds?: number
  limit?: number
  remaining?: number
}
```

Normalization rules:

- Clamp percentages to `0..100`.
- Derive `remainingPercent` from `usedPercent` only when the provider reports a real percentage.
- Identify windows by duration where possible. For example, `18,000` seconds is five hours and `604,800` seconds is one week.
- Never assume a provider's `primary` window is five hours.
- Preserve unknown windows with a provider-supplied label rather than dropping them.
- Treat timestamps as absolute epoch milliseconds after normalization.
- Return normalized, user-safe errors instead of raw upstream payloads.

## Provider Usage Service

Add `packages/opencode/src/provider/usage.ts` as the server-side registry and cache.

The service should expose:

```ts
interface ProviderUsage {
  snapshots(): Effect.Effect<ProviderUsageSnapshot[]>
  refresh(providerID?: string): Effect.Effect<ProviderUsageSnapshot[]>
  register(adapter: ProviderUsageAdapter): Effect.Effect<void>
  ingestRateLimitHeaders(providerID: string, headers: Headers): Effect.Effect<void>
}
```

The service should be instance-scoped because provider configuration and custom endpoints can differ by project. Cache keys must include the provider and active account identity so account switches cannot reuse another account's snapshot.

### Provider Discovery

Build the provider set from:

- Active credentials in `Auth.Service`.
- Explicit entries in `config.provider`.
- Environment-authenticated providers initialized by `Provider.Service`.
- Provider hooks supplied by plugins.
- The active session model provider.

Do not enumerate the complete Models.dev catalog. Only providers that are configured, authenticated, environment-enabled, plugin-defined, or active belong in the widget.

Every discovered provider receives one of these outcomes:

- `available`: current data exists.
- `stale`: last successful data exists but refresh failed or expired.
- `unsupported`: no registered adapter or observable rate-limit data exists.
- `unauthenticated`: the provider is configured but required credentials are absent.
- `error`: retrieval failed and no previous snapshot exists.

## Adapter Contract

Built-in and plugin adapters implement a shared contract:

```ts
interface ProviderUsageAdapter {
  id: string
  providerID: string
  supports(input: ProviderUsageAdapterInput): boolean
  refreshIntervalSeconds: number
  fetch(input: ProviderUsageAdapterContext): Effect.Effect<ProviderUsageSnapshot, ProviderUsageError>
}
```

The adapter context supplies provider metadata, account metadata, and an authenticated request capability. The SDK and TUI never receive raw credentials.

Add an optional in-process plugin hook such as `provider.usage`. The usage service collects these hooks alongside built-in adapters. A custom provider should be able to add quota support by returning a usage adapter from its plugin without changing the registry implementation.

Keep plugin registration process-local. Do not accept executable adapter code over HTTP or configuration JSON.

## Built-In Adapters

Create focused adapter files under `packages/opencode/src/provider/usage/`:

- `opencode-go.ts`
- `openai-codex.ts`
- `anthropic.ts`
- `github-copilot.ts`
- `openrouter.ts`
- `kimi.ts`
- `zhipu.ts`
- `minimax.ts`
- `rate-limit-headers.ts`

### OpenCode Go

Call `GET https://opencode.ai/zen/go/v1/usage` with the workspace API key.

Credential precedence:

1. `OPENCODE_API_KEY`
2. `provider.opencode-go.options.apiKey`
3. `provider.opencode.options.apiKey`
4. Active `opencode-go` auth entry
5. Legacy active `opencode` auth entry

Normalize the rolling, weekly, and monthly windows. The endpoint does not currently return credit balance, so do not infer one.

### ChatGPT/Codex OAuth

Call `GET https://chatgpt.com/backend-api/wham/usage` with the OAuth bearer token and `ChatGPT-Account-Id` when available.

Refactor and reuse the refresh behavior in `packages/opencode/src/plugin/openai/codex.ts` rather than implementing a second refresh-token path. On an expired token, refresh and persist once, then retry the usage call once.

Classify windows by their reported duration. Preserve additional limits such as Spark-specific windows.

### Generic Rate-Limit Headers

Observe provider HTTP responses and ingest common rate-limit headers:

- `x-ratelimit-limit-*`
- `x-ratelimit-remaining-*`
- `x-ratelimit-reset-*`
- `anthropic-ratelimit-*`
- Adapter-defined vendor equivalents

Header-derived values are `reported` rate limits, not subscription quotas. They should be labelled and rendered accordingly.

## Cache and Refresh Policy

- Use a 60-second default TTL, overridable by each adapter.
- Deduplicate concurrent refreshes per provider/account.
- Fetch adapters concurrently with a bound of four.
- Return cached data immediately and refresh stale entries in the background.
- Preserve the last successful snapshot when a refresh fails.
- Retry once after OAuth token refresh on `401`.
- Respect `429` and back off until the reported reset or a conservative fallback delay.
- Do not automatically retry other failures that could increase provider load.
- Redact credentials, authorization headers, cookies, and raw upstream bodies from logs and errors.

The TUI polls the cached list every 60 seconds while visible (the server refreshes stale entries in the background, so polling stays light). It forces a refresh on mount only via session/auth events and user action: after provider authentication changes and after the active session finishes a provider request. Countdown labels update locally between network refreshes. A syntactically safe but unknown `providerID` on refresh returns an empty list (200); only unsafe IDs fail with 400 at the schema boundary.

No new queue or event bridge is required for the first implementation. Existing session and authentication events can trigger a debounced endpoint refresh. Add a dedicated event only if later consumers require push updates independent of existing events.

## HTTP API

Add global routes because provider usage is account-level and must work without an active session:

```text
GET  /global/provider-usage
POST /global/provider-usage/refresh
```

The GET route returns cached normalized snapshots and may start stale refreshes. The POST route forces a refresh for all providers or one requested provider.

Update the RootHttpApi group and handler under:

- `packages/opencode/src/server/routes/instance/httpapi/groups/global.ts`
- `packages/opencode/src/server/routes/instance/httpapi/handlers/global.ts`

The response must never contain credentials, raw headers, upstream request URLs containing secrets, or raw provider errors.

Regenerate the JavaScript SDK after the route and schema changes:

```text
./packages/sdk/js/script/build.ts
```

## Sidebar Widget

Add `packages/tui/src/feature-plugins/sidebar/provider-usage.tsx` and register it in `packages/tui/src/feature-plugins/builtins.ts`.

Use `sidebar_content` order `135`, directly after System Resources at order `130` and before the agent/codegraph cluster.

Example compact rendering:

```text
USAGE
ChatGPT
5h  ███████░░ 68%  2h14m
1w  ████░░░░░ 39%  4d8h
OpenCode Go
5h  █████████ 86%  3h42m
1w  ██████░░░ 57%  5d2h
1mo ████████░ 75%  18d
Gemini
Usage unavailable
```

Rendering rules:

- Render one row per usage window; do not use separate label and bar rows.
- Order the active session provider first, then other available providers, then unsupported providers.
- Use the provider's display name, not only its internal ID.
- Show remaining percentage for quota windows and raw remaining/limit for count-based rate limits.
- Show a short reset countdown when a reset timestamp is available.
- Label stale data and retain it instead of replacing the section with an error.
- Render configured providers without credentials as `Not connected`.
- Render providers without a usable source as `Usage unavailable`.
- Allow the existing sidebar scroll container to handle many configured providers; do not silently cap the list.
- Subscribe to session and auth events with `onCleanup`.

## Sidebar Density Cleanup

The current sidebar contains approximately five to six redundant vertical rows. The compact-density contract is:

- Exactly one wrapper-owned separator row between major sidebar plugins.
- No blank rows inside a plugin section.
- Plugin roots use `gap={0}`.
- The first content row after a header uses `marginTop={0}`.
- Progress bars use one terminal row.
- Footer rows use no extra vertical padding.

Apply these changes:

1. In `packages/tui/src/feature-plugins/sidebar/system-status.tsx`, change the Memory and Disk blocks from `marginTop={1}` to `marginTop={0}`.
2. In `packages/tui/src/feature-plugins/sidebar/context.tsx`, replace the three-row bordered segmented bar with a one-row borderless segmented bar.
3. In `packages/tui/src/routes/session/sidebar.tsx`, remove the footer container's extra `paddingTop` and internal `gap`.
4. In the sidebar footer component, set the root gap to zero and remove conditional card vertical padding.
5. Give the provider-usage widget `gap={0}`, `marginTop={0}`, and one-row window bars.
6. Retain the shared `sidebar_content` wrapper gap of one. Individual plugins must not add their own leading section margin.

This removes redundant space while preserving one consistent boundary between major sections.

## Implementation Phases

### Phase 1: Core Schema and Service

- Add the normalized Effect schemas.
- Add the usage adapter types and registry.
- Implement provider discovery.
- Implement per-provider/account caching, stale handling, concurrency bounds, and failure isolation.

### Phase 2: First-Party Exact Adapters

- Implement OpenCode Go.
- Implement ChatGPT/Codex OAuth with shared token refresh.
- Implement Anthropic OAuth.
- Implement GitHub Copilot.
- Implement OpenRouter.
- Implement Kimi, Zhipu, and MiniMax after fixture verification.

### Phase 3: Generic Provider Coverage

- Capture common rate-limit headers from provider responses.
- Normalize headers into reported rate-limit windows.
- Return explicit unsupported and unauthenticated snapshots for all other discovered providers.

### Phase 4: Global HTTP API

- Add list and refresh routes.
- Wire the service into both relevant application runtimes.
- Add response schemas and security tests.
- Regenerate the JavaScript SDK.

### Phase 5: TUI Widget and Density Cleanup

- Add the order-135 provider usage widget.
- Add polling, auth/session refresh triggers, countdowns, stale rendering, and cleanup.
- Apply the System Resources, Context, and footer spacing reductions.
- Verify scrolling with many providers and narrow terminals.

### Phase 6: Plugin Extensibility

- Add the optional provider usage plugin hook.
- Add plugin types and documentation.
- Add a fixture plugin proving that a custom provider can register an adapter without central changes.

## Testing Plan

### Core and Service Tests

- Decode and normalize fixture responses for every built-in adapter.
- Classify five-hour, weekly, monthly, and unknown windows by duration.
- Clamp malformed percentages.
- Handle absent reset timestamps and additional windows.
- Verify OAuth refresh and one retry on `401`.
- Verify `429` backoff.
- Verify stale-while-revalidate behavior.
- Verify account-switch cache isolation.
- Verify one failing provider does not block others.
- Verify unsupported and unauthenticated providers remain represented.
- Verify no credentials or raw authorization headers appear in returned snapshots or errors.

### HTTP Tests

- List cached provider snapshots.
- Force refresh globally and by provider.
- Reject invalid provider IDs.
- Confirm routes work without an active session.
- Confirm secrets are absent from encoded responses.
- Confirm partial adapter failure still returns successful snapshots for other providers.

### Plugin Tests

- Register a provider usage adapter from a fixture plugin.
- Confirm duplicate adapter IDs are handled deterministically.
- Confirm plugin failure is isolated.
- Confirm configured custom providers without adapters return `unsupported`.

### TUI Tests

- Render exact, reported, stale, unsupported, unauthenticated, and error states.
- Render multiple providers and unknown windows.
- Update countdown text without refetching.
- Refresh after session completion and auth changes.
- Dispose polling timers and event subscriptions on unmount.
- Verify narrow-width truncation and sidebar scrolling.
- Verify no overlap at `80x24` and wider terminal sizes.

### Spacing Tests

- Extend `packages/tui/test/feature-plugins/sidebar/sidebar-compact-spacing.test.tsx` with the provider usage plugin.
- Assert the shared wrapper retains `gap={1}`.
- Assert Context, System Resources, footer, and Provider Usage do not introduce `marginTop={1}` or internal vertical gaps.
- Assert the Context bar is one row and borderless.
- Add a row-count regression test proving a five-to-six-row reduction for the screenshot configuration.
- Add a populated provider-usage row-count test.

### Verification Commands

Run tests and typechecks from package directories, never from the repository root:

```text
packages/core: bun typecheck
packages/opencode: bun test <affected provider-usage and HTTP tests>
packages/opencode: bun typecheck
packages/tui: bun test test/feature-plugins/sidebar
packages/tui: bun typecheck
```

## Acceptance Criteria

- The widget appears directly below System Resources without a feature flag.
- Every explicitly configured or connected provider is represented.
- ChatGPT and OpenCode Go display real remaining windows and reset times.
- Providers with exact endpoints, balances, or reported rate limits display only the data they actually expose.
- Unsupported providers never display fabricated limits.
- Third-party providers can register an adapter without editing the registry.
- Credentials and raw upstream responses never leave the server.
- One provider's failure does not affect other providers.
- OAuth refresh and account switching do not leak or reuse stale account data.
- The sidebar removes the redundant internal spacing shown in the reference screenshot.
- Context, Performance, System Resources, Provider Usage, and footer sections remain readable without overlap at narrow terminal sizes.
- Relevant package tests and typechecks pass, and the JavaScript SDK is regenerated for the new global routes.

## Sources

- https://github.com/slkiser/opencode-quota
- https://github.com/xihuai18/opencode-quota-sidebar
- https://github.com/50sotero/opencode-usage-quota
- https://github.com/ridho9/opencode-go-usage
- https://github.com/anomalyco/opencode/issues/44189
- https://opencode.ai/docs/go/
- https://openrouter.ai/docs/api_reference/limits
- https://developers.openai.com/api/docs/guides/rate-limits
- https://platform.claude.com/docs/en/api/overview
- https://github.com/openai/codex/issues/15281
