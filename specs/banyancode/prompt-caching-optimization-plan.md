# OpenAI Prompt-Caching Optimization Plan

Status: **v4 — measure-first restructure** after necessity review (2026-09-23). OpenAI optimization-docs + Anthropic cross-provider delta folded in. Gemini unverified (fetch timed out). Necessity audit cut unconditional PR3–5 down to: ship the two load-bearing PRs, measure real miss reasons, build the rest only if diagnostics prove they matter.

Out of scope: opencode v2-tools / SessionRunner parity (dropped). Workspace prune of out-of-scope `console`/`stats`/`slack` (kills BS Dependabot PRs #19/#30) is a **separate chore**, not part of this plan.

## Goal

Higher cache hit rates, lower input cost (reads 0.1×, writes 1.25×), lower TTFT on GPT-5.6/GPT-6 — without breaking Anthropic caching and without building speculative machinery.

## Necessity summary (why this shape)

| Workstream | Need | Disposition |
|---|---|---|
| WS0 diagnostics | Instrument that proves every other decision | **Ship (PR1′)** — free, ZDR-safe, first-reason-only |
| WS1 config keys | Toggle surface | **Ship (PR1′)** — only keys we actually emit day one |
| WS2 wire `prompt_cache_options` | Core feature | **Ship (PR1′)** — implicit mode first |
| WS7a `cache_write` usage schema | Correct cost math | **Ship (PR1′)** — thin, folds into observability |
| WS3 prefix reorder | Fixes real bug: date/graph-state sit at prompt start → daily/cache-state breaks | **Ship (PR2)** — load-bearing, not optional |
| WS5 sticky tools / `allowed_tools` | Only fires when tool set changes mid-session (permission edits, user.tools); most sessions stable | **Conditional** — build only if diagnostics shows `tools_changed` |
| WS4 `configuration_update` | GPT-6 only; only when user changes thinking mid-chat; high complexity (message model + compaction guards) for low frequency; without it: one cache break per change (tolerable) | **Conditional** — build only if `reasoning_effort_changed` is material |
| WS6 prewarm | First-request TTFT only; costs 1.25× write; user usually types for seconds anyway; default-off | **Last / probably never** — gold-plating until measured need |
| WS7b TUI hit-rate widget | Polish | **Optional** — after measure gate if users want it |
| Tool_search / defer (~40 tools vs <20 guidance) | May beat caching itself on input-token cost | **Elevated next** after measure gate — higher ROI than WS3–6 for many users |

**Sequencing principle:** ship what is either (a) the feature itself or (b) required for the feature to work; then stop and read diagnostics; then build only against observed miss reasons.

## Sources read

Primary (user-supplied):
- `openai.com/index/better-prompt-caching-for-gpt-6` (2026-09-22)
- `api/docs/guides/prompt-caching` (incl. manage-tools-with-append-only-updates, prewarm-the-cache, choose-a-caching-mode, change-reasoning-effort-without-rewriting-the-prefix)
- `api/docs/guides/reasoning?api-mode=responses#change-reasoning-mid-conversation`

Extended (researcher, `.md` twins): diagnostics, tools-tool-search, function-calling, compaction, conversation-state, migrate-to-responses, gpt-6-astra, gpt-5.6, upgrading-to-gpt-5p6-sol, reasoning, agents-api/observability, latency-optimization, cost-optimization, deployment-checklist, websocket-mode, steering, async-tool-calling, tools-programmatic-tool-calling, streaming, fast-mode, background, token-counting, `pricing.md`, Responses create API reference.

Cross-provider: Anthropic prompt-caching guide (`platform.claude.com/docs/en/build-with-claude/prompt-caching`, fetched directly). Gemini: timed out, unverified.

## Feature inventory (exact API shapes)

| Feature | API shape | Model gate | Notes |
|---|---|---|---|
| Cache options | `prompt_cache_options: { mode?, ttl?, prewarm?, comparison_response_id? }` | GPT-5.6+ | default = one OpenAI-chosen implicit breakpoint; `prompt_cache_retention` DEPRECATED → `ttl` |
| Mode | `"implicit"` \| `"explicit"` | GPT-5.6+ | implicit: 1 implicit + latest 3 explicit; explicit: latest 4 explicit; **explicit + zero breakpoints = no caching** |
| TTL | `ttl: "30m"` | GPT-5.6+ | only supported value |
| Prewarm | `prewarm: true` | GPT-5.6+ | no output; overrides `generate` to false; billed 1.25× write |
| Explicit breakpoint | `prompt_cache_breakpoint: { mode: "explicit" }` on content blocks | GPT-5.6+ | max 4 writes/req; 80-breakpoint lookback; illegal on top-level `instructions` / `additional_tools` |
| Diagnostics | request `comparison_response_id` → response `prompt_cache_diagnostics` | GPT-5.6+ | free, first-reason-only; 9 miss reasons: `model_changed`, `prompt_cache_key_changed`, `service_tier_changed`, `tools_changed`, `text_format_changed`, `reasoning_effort_changed`, `verbosity_changed`, `context_compacted`, `input_changed` |
| Stable key | `prompt_cache_key` | pre-5.6 routing; 5.6+ accounting | already = sessionID; keep stable within conversation |
| Tools append-only | keep `tools` stable; restrict via **`tool_choice: { type: "allowed_tools", mode, tools: [{type,name}] }`** or `tool_choice: "none"` | all | `allowed_tools` lives inside `tool_choice`, not top-level |
| Deferred tools | `{ type: "tool_search" }` + `defer_loading: true` / namespaces; optional `additional_tools` input item | gpt-5.4+ | injects at END of context; **soft guidance <20 eager fns** — we have ~40 |
| Reasoning mid-conversation | append `{ type: "configuration_update", reasoning: { effort } }`; keep top-level effort frozen | GPT-6, standard single-agent | no adjacent updates; not with auto-compaction; **response echoes REQUEST effort** (telemetry trap) |
| Observability | `usage.input_tokens_details.{ cached_tokens, cache_write_tokens }` | raw Responses | cost = uncached×I + cached×0.1×C + write×1.25×W + output |
| Replay completeness | push ALL `response.output` back (encrypted reasoning, `phase`, tool_search/program/compaction items, configuration_update positions) | all | drop `phase` → preambles read as final answers |

Pricing (per 1M, short-context): read 0.1×, write 1.25× (GPT-5.6/GPT-6). Break-even ~1.28 re-reads within 30m TTL. Long-context >272K doubles rates. Batch/Flex 50%; fast mode 2× with cache discounts intact.

## Current state in BanyanCode (integration map)

Already done:
- OpenAI forced to Responses API (`provider.ts:215-222`); native path also Responses default.
- `prompt_cache_key` = sessionID (`transform.ts:1128-1130`; native `openai-responses.ts:131,460,478`; config `banyancode_prompt_cache_key`).
- `store: false` + full stateless replay; `reasoning.encrypted_content` fully wired.
- `cached_tokens` read on native path → `Usage.cacheReadInputTokens`; Copilot too.
- Anthropic `cache_control` path exists (`transform.ts:323-372`, `utils/cache.ts`) — NOT used for OpenAI.
- Downstream cache-write plumbing exists (Anthropic-sourced): `token-attribution.ts`, `publish-llm-event.ts`, telemetry, billing.

Missing (0 hits — greenfield):
- `prompt_cache_options`, `prompt_cache_breakpoint`, `configuration_update`, `allowed_tools` (as tool_choice), `tool_search`/`defer_loading`, diagnostics `comparison_response_id`.
- OpenAI `cache_write_tokens` wire field in usage schema.
- Sticky per-session tool snapshot; session layer never sets `tool_choice:"none"`.
- System-prompt prefix stability: `Today's date` (`system.ts:76`), cwd (`:72-73`), codegraph graph-state (`:139-151`), skills/references sit near prompt START.

Structural constraints:
- THREE request implementations: AI SDK `transform.ts` (default), native `openai-responses.ts` (experimental), Copilot (deferred).
- `@ai-sdk/openai` may not emit new fields → providerOptions, SDK upgrade, or native-path fallback.
- Effort changes today always rewrite top-level `reasoning.effort` (`request.ts:84-95`) — the cache-breaking pattern `configuration_update` replaces.
- Change hooks exist: TUI `dialog-thinking.tsx`, ACP `setVariant`, CLI `variant.shared.ts`.
- ~40 eager tools exceeds OpenAI's <20 soft guidance; every tool def is billed as input EVERY turn.

---

## Workstreams

Necessity tags: **[PR1′]** ship now · **[PR2]** ship now · **[COND]** only after measure gate · **[OPT]** polish · **[NEXT]** elevated follow-up.

### WS0 — Diagnostics instrumentation **[PR1′]**

1. Emit `prompt_cache_options.comparison_response_id` = previous completed response `id` when `banyancode_prompt_cache_diagnostics=true`. Omit on first turn; hold the same baseline while A/B-ing a fix.
2. Read response `prompt_cache_diagnostics`; log/store miss `reason` + `cache_missed_tokens` (bus event / telemetry). Never block or alter output.
3. Tests: fixture with `cache_miss` reason `tools_changed` → assert we surface it; tolerate `comparison_response_not_found`.

Config: `banyancode_prompt_cache_diagnostics` (boolean, default `false`; recommend default `true` in dev/eval builds).

Acceptance: two-turn recorded exchange carries `comparison_response_id` on turn 2 and decodes diagnostics on the response.

### WS1 — Config keys (BanyanConfig.Info only; never ConfigV1) **[PR1′]**

File: `packages/core/src/v1/config/banyan-config.ts` (precedent `banyancode_prompt_cache_key:138-144`).

| Key | Type | Default | Status |
|---|---|---|---|
| `banyancode_prompt_cache_key` | enum/string | existing | unchanged |
| `banyancode_prompt_cache_mode` | `"implicit" \| "explicit" \| "off"` | `"implicit"` | **PR1′** |
| `banyancode_prompt_cache_diagnostics` | boolean | `false` | **PR1′** |
| `banyancode_prompt_cache_stable_prefix` | boolean | `true` | **PR2** |
| `banyancode_prompt_cache_prewarm` | boolean | `false` | **[COND]** add key only if/when WS6 built |
| `banyancode_reasoning_configuration_update` | boolean | `true` | **[COND]** add key only if/when WS4 built |
| `banyancode_tool_search_defer` | boolean | `false` | **[NEXT]** with tool_search PR |

Read via `Banyan.BanyanConfigService` + `Effect.serviceOption` (`llm.ts:227-233`).

### WS2 — Wire `prompt_cache_options` + breakpoints **[PR1′]**

1. Native schema: extend closed `OpenAIResponsesCoreFields` (`openai-responses.ts:123-147`) with `prompt_cache_options?` (`mode`, `ttl`, `prewarm`, `comparison_response_id`); breakpoint pass-through on input content blocks; `lowerOptions` (`:457-484`) + `fromRequest` (`:486-500`).
2. AI SDK path: `transform.ts options()` (`:1073-1228`) via `providerOptions.openai` (or upgrade `@ai-sdk/openai` — **spike first in PR1′**). Gate on gpt-5.6+/gpt-6 (effort tables `:517-588`). NEVER send 5.6-only fields to older models.
3. Ship **implicit mode only** in PR1′. Explicit breakpoints + placement rules stay specified (below) but land in PR2+ only if measure gate says implicit isn't enough — do NOT globally convert to explicit (upgrade-guide rule).
   - Placement (when built): after stable system/developer block as `input_text` in a developer message in `input` (NOT top-level `instructions`); optionally after tool-result groups; respect 4-writes/request.
4. OAuth path caveat: system moves to `options.instructions` (`request.ts:103`) where breakpoints are illegal — explicit mode needs developer-message migration or stays implicit-only for OAuth.
5. Keep `prompt_cache_key` = sessionID; never rotate mid-session.
6. Freeze `service_tier` per conversation if ever set (response-echoed; drift = miss reason).
7. Copilot: defer. `ttl`: omit (default 30m). Prewarm field: schema-ready but only emitted if WS6 ships.

Acceptance: body contains `prompt_cache_options` (implicit + comparison id when diagnostics on) for GPT-5.6+; omitted for older models / mode=off / non-OpenAI providers.

### WS3 — Prefix stability (system prompt reorder) **[PR2]**

File: `packages/opencode/src/session/system.ts` + V2 epoch prep (`llm.ts:193-219`, assembly seam only — no v2-tools work).

1. Split assembly:
   - **STABLE**: provider base (`prompt/gpt.txt`), agent prompt, CodegraphSystemSource `POLICY_TEXT` + tool guide, banyan static render, static examples.
   - **DYNAMIC**: `Today's date`, cwd/worktree/platform, references, skills drift, codegraph graph-state, version header (`request.ts:18`), request IDs.
2. Order: tools wire-array → STABLE → (explicit breakpoint here when mode=explicit, PR2+) → DYNAMIC → conversation (append-only).
3. Key V2 `SessionContextEpoch` baseline on STABLE only.
4. Gate: `banyancode_prompt_cache_stable_prefix` (default `true`).
5. Cheap same-PR if trivial: `text.verbosity` once at session level on GPT-5.6+ instead of "be concise" phrasing (verbosity is cache-affecting — never flip mid-conversation).

Acceptance: golden tests show date/graph-state after stable block; two same-day requests differ only in dynamic tail.

### WS5 — Tool-set stability **[COND — only if diagnostics shows `tools_changed`]**

Trigger to build: measure gate reports material `tools_changed` misses from permission edits / `user.tools` / plugin mutations. Most sessions have a stable tool set — do not build speculatively.

When triggered:
1. Sticky snapshot: freeze tools array (defs + order) on first request of session (key = session + model). Permission narrowing must NOT remove wire `tools` entries.
2. Emit OpenAI-only `tool_choice: { type: "allowed_tools", mode: "auto", tools: [{type:"function",name}] }` when callability shrinks; `tool_choice: "none"` + full `tools` when none callable (native already has `toolChoice` `openai-responses.ts:114-117`).
3. Gate: OpenAI + mode ≠ off. Non-OpenAI keeps filtering as today.
4. `apply_patch`↔`edit/write` swap (`registry.ts:306-309`) is model-stable — model in snapshot key; model switch = new snapshot (expected break).
5. CodegraphSystemSource tool guide renders from FROZEN set.
6. Pin strict-mode emission (always omit OR always explicit) so serialized tool objects never flip mid-session.

Acceptance: permission revoke changes only `tool_choice.allowed_tools`, not `tools`; diagnostics stops reporting `tools_changed` on permission-only turns.

### WS4 — `configuration_update` **[COND — only if diagnostics shows material `reasoning_effort_changed`]**

Trigger to build: users actually change thinking mid-chat on GPT-6 often enough that `reasoning_effort_changed` misses hurt. Without this: one cache break per change — acceptable for many users.

When triggered:
1. Per session: `baseReasoningEffort` (frozen) + `effectiveReasoningEffort` (mutable).
2. On thinking change (TUI/ACP/CLI) with flag on: do NOT change top-level `reasoning.effort`; append persisted `{ type: "configuration_update", reasoning: { effort } }` before next user turn (preserve position on replay).
3. Extend message store to round-trip the item through stateless replay; coalesce — never adjacent (API 400).
4. Gate: GPT-6 family, standard single-agent only.
5. Compaction guard: forbid auto-compaction with an update in history; re-add fresh update after manual `compaction_trigger`.
6. Telemetry: read effective effort from LOCAL state, never response `reasoning.effort` (echoes request level).
7. Preserve assistant `phase` on any history-rewrite paths touched here.

Acceptance: effort change leaves every prior input byte identical except new update item + new user message; top-level effort constant across session.

### WS6 — Prewarm **[OPT — last / probably never]**

Only if measure gate shows first-turn TTFT misses that prewarm would fix AND users wait long enough for the write to pay back (≥1.28 reads). Spec already: fire once per hash(stable system + tools + model) with `prewarm: true`, await before first real request, skip when mode=off.

Default remains **off**. Do not build in PR1–2.

### WS7 — Observability

**WS7a `cache_write` usage schema [PR1′]:**
1. Extend `openai-responses.ts:165-171` with `cache_write_tokens`; map into existing `Usage.cacheWriteInputTokens` (`publish-llm-event.ts` / `token-attribution.ts` already emit it).
2. Wire V1 `ai-sdk.ts:72-81` if AI SDK exposes the detail.
3. Verify `session.ts:394-424` cost math with OpenAI multipliers.

**WS7b TUI hit-rate widget [OPT]:** `session-cost.tsx` cached-% / `$saved` readout after measure gate if wanted. Do NOT overload `provider-usage.tsx` (quota). CLI `telemetry.ts:243-244` verify only (thin).

**WS7c diagnostics surface:** log reason when `banyancode_prompt_cache_diagnostics=true` (part of WS0; optional TUI toast later).

### WS8 — Tests (per shipped slice)

- PR1′: `transform.test.ts` (options body, mode off/on, model gates, comparison_response_id, provider gating); `openai-responses.test.ts` (closed-schema, lowerOptions, usage cache_write); diagnostics decode fixture.
- PR2: system-assembly golden (stable/dynamic split); Anthropic non-regression (applyCaching untouched, `anthropic-messages-cache` fixtures green).
- COND slices: sticky-tools test; configuration_update coalesce + local-state telemetry; prewarm idempotency if ever built.
- Never run tests from repo root. `bun typecheck` per touched package.

---

## Sequencing (revised — measure-first)

### Phase A — ship the load-bearing pair

1. **PR1′ — WS0 + WS1 (partial) + WS2 (implicit) + WS7a**: config keys `mode`/`diagnostics` only; `prompt_cache_options` implicit + `comparison_response_id` (model-gated, provider-gated); `cache_write_tokens` usage schema; AI SDK field-support spike; unit tests. Immediate benefit + the instrument.
2. **PR2 — WS3**: system reorder behind `stable_prefix` (default on) + golden tests + Anthropic non-regression. Unlocks safe explicit breakpoints later if needed.

Each: `bun typecheck` + package tests; lead commits; zero v2-tools changes; zero Anthropic wire changes.

### Phase B — MEASURE GATE (1–2 weeks of real/dev sessions with diagnostics on)

Read miss-reason distribution:

| Observed reason | Action |
|---|---|
| mostly `input_changed` / none / low misses | **Stop.** Caching works. Ship nothing more. |
| `tools_changed` material | Build **WS5** (conditional PR3) |
| `reasoning_effort_changed` material | Build **WS4** (conditional PR4) |
| first-turn TTFT pain + short sessions | Consider **WS6** prewarm (optional PR5) |
| users want a hit-rate readout | **WS7b** TUI widget |
| (always, independent) large input-token share from ~40 tool defs | Prioritize **tool_search / defer** (NEXT) — may beat all of the above on cost |

Do NOT pre-build WS4/WS5/WS6 "just in case."

### Phase C — follow-ups as earned

- Conditional PR3 (WS5), PR4 (WS4), PR5 (WS6+WS7b) — each only with a diagnostics citation in the PR description.
- **NEXT:** tool_search / `defer_loading` namespaces (`banyancode_tool_search_defer`) — measure with `POST /v1/responses/input_tokens` before/after; likely highest remaining input-token win.
- Still deferred (unchanged): Copilot parity, WebSocket mode (~40% faster at 20+ tool calls), lean-prompt audit (41–66% token cut), async tools, PTC, server compaction, Gemini.

## Separate chore (not this plan)

Dependabot PRs **#19** (`@jsx-email/cli` → console/mail) and **#30** (stripe → console/core) target **out-of-scope** `packages/console/*` (`ARCHITECTURE.md:32`) but workspaces still include `packages/console/*` + `packages/stats/*` (`package.json:24-31`). Close those PRs and prune workspace globs + `dev:console`/`dev:stats` scripts to stop the spam. In-scope open PRs (#17 htmlparser2, #18 parcel/watcher) are real and correctly CHANGES_REQUESTED — handle on their own merits.

## Risks / open questions

1. **AI SDK field support** — highest technical risk. PR1′ spike; fallback = implicit-only on default path, full features on `OPENCODE_EXPERIMENTAL_NATIVE_LLM`.
2. **Three implementations drift** — per-PR checklist: transform.ts / openai-responses.ts / (Copilot deferred).
3. **OAuth instructions path** — breakpoints illegal on `instructions`; only matters if explicit mode is ever adopted.
4. **configuration_update × stateless replay × compaction** — only paid if WS4 is triggered.
5. **tool_choice.allowed_tools emission** — API shape confirmed; AI SDK unverified; only paid if WS5 is triggered.
6. **Prewarm cost** — 1.25× write; stays off until measured.
7. **Minimum 1024 tokens** — coding agents clear easily; short sessions may not — document, don't pad.
8. **Telemetry trap** — never read effective effort from response `reasoning.effort`.
9. **prompt_cache_key** — stable sessionID; keep for accounting.

## Cross-provider delta (Anthropic verified; Gemini unverified)

Source: `platform.claude.com/docs/en/build-with-claude/prompt-caching` (2026-09-23).

| Behavior | OpenAI GPT-5.6+ | Anthropic | Our code today |
|---|---|---|---|
| Modes | `prompt_cache_options.mode` implicit \| explicit | Automatic top-level `cache_control` OR explicit; combinable | Explicit-style via `applyCaching` + `utils/cache.ts` |
| Breakpoint budget | 4 writes/req; 80-breakpoint lookback | 4 breakpoints; **20-block lookback** (tool_use/tool_result runs count as 1) | 4-cap matches |
| TTL | `ttl: "30m"` only | 5m default; **1h at 2× write** | 5m/1h supported |
| Write / read | 1.25× / 0.1× | 1.25× (5m) / 2× (1h) / 0.1× read (0.05× Opus 5.5, 0.025× Fable 5.1) | 1.25/0.1 formula OK |
| Min cacheable | 1024 visible | 512 / 1024 / 2048 / 4096 by model | server-side |
| Prefix order | tools → system → messages | **tools → system → messages** | WS3 helps both |
| Usage | `cached_tokens`, `cache_write_tokens` | `cache_read_input_tokens`, `cache_creation_input_tokens`, `input_tokens` (after last bp) | Both mapped |
| Mid-conv tool change | `allowed_tools` / `tool_choice:none` / `additional_tools` | `inline-tools` beta `tool_addition`; mid-conv system msgs (model-gated) | OpenAI-only for WS5 |
| Mid-conv effort | `configuration_update` (GPT-6) | Top-level change invalidates messages; per-message effort via `role:"system"` in messages leaves prefix intact (beta) | WS4 OpenAI-only |

**Anthropic non-regression (every PR):** do NOT touch `transform.ts applyCaching` (`:323-372`), Anthropic gate (`:433-445`), `utils/cache.ts`, `bedrock-cache.ts`, `anthropic-messages.ts` usage (`:174-175,566-567`). Keep `anthropic-messages-cache/*` + `applyCaching` tests green. New OpenAI fields provider-gated only. WS3 reorder benefits Anthropic too (same hierarchy) behind the shared flag.

**Config-key naming:** keep generic `banyancode_prompt_cache_*`. `stable_prefix`/`diagnostics` are cross-provider; `mode`/`prewarm` documented "ignored for non-OpenAI." No Anthropic TTL key until asked. Matches existing generic `banyancode_prompt_cache_key` + provider allowlist pattern (`openai-options.ts:79-98`).

**Gemini:** fetch timed out. Different object model (context caches with TTL). Out of scope.

## Exit criteria

**Phase A (must):**
1. GPT-5.6+ sessions send `prompt_cache_options` (implicit + diagnostics id when enabled); older models / mode=off / non-OpenAI omit them.
2. System stable/dynamic split lands; date/graph-state after stable block.
3. Usage carries `cache_read` + `cache_write`; cost math uses 0.1×/1.25×.
4. Diagnostics reason logged when flag on.
5. Tests + `bun typecheck` green; zero v2-tools changes; Anthropic path untouched and its fixtures green; OpenAI-only fields never emitted for other providers.

**Phase B+:** conditional work only with a diagnostics citation; tool_search prioritized when tool-def token share justifies it; prewarm/TUI widget only if users ask or measurements demand.

**Explicit non-goals unless earned:** sticky tools, configuration_update, prewarm, TUI hit-rate widget, explicit-mode-by-default, Copilot parity, WebSocket.
