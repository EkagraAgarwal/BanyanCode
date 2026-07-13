# Upstream Provider / Model / Thinking Sync Plan

Sync OpenCode upstream providers, models, and thinking-variant support into the BanyanCode fork so that MiniMax M3, DeepSeek V4, Claude Sonnet 5, GLM-5.2, and future models.dev metadata-driven models work the same way as in upstream OpenCode.

Validated 2026-07-13 against the local worktree (`mesh-phase0-complete`) and upstream `dev`.

## Baseline

- Upstream tag: `v1.17.18`
- BanyanCode fork: `mesh-phase0-complete` (custom branch, ~15 patch versions behind upstream)
- Local upstream commits present: `3a669d5`, `22cc758` (both not ancestors, valid sync candidates)
- Local upstream commits missing: `a8062ea`, `8168f0f` (need `git fetch upstream dev`)
- Typecheck baseline: `packages/core` clean, `packages/tui` clean, `packages/opencode` has 3 known `AppLayer` cast errors (`app-runtime.ts:205`, `app-runtime-logger.test.ts:44`, `httpapi-exercise/index.ts:1560`) — pre-existing and unchanged.

## What BanyanCode already has in sync

- MiniMax M3 thinking toggle (`transform.ts:669-677`)
- MiniMax M3 default `thinking: adaptive` for Anthropic SDK (`transform.ts:1117-1120`)
- DeepSeek V4 `max` effort on OAI-compatible SDKs (`transform.ts:838-839`)
- DeepSeek requires reasoning on assistant messages (`transform.ts:269-284`)
- Gemini 3 flash/pro-image thinking levels (`transform.ts:626-633`)
- Claude Opus 4.7 / Sonnet 4.6 adaptive efforts (`transform.ts:608-619`)
- GLM-5.2 temperature/topP (`transform.ts:486, 501`)
- Grok reasoning efforts (`transform.ts:695-707`)
- Claude Fable 5 (`anthropicOmitsThinking` checks `fable-5`)
- Kimi K2 thinking via Anthropic SDK (`transform.ts:1123-1131`)
- Alibaba/DashScope `enable_thinking` (`transform.ts:1138-1145`)

## What is missing and why

| Gap | Source | Severity | Impact |
|---|---|---|---|
| `anthropicSonnet5OrLater()` helper missing | `3a669d5` Jun 30 | HIGH | Claude Sonnet 5 falls through to legacy heuristic variants |
| `reasoningVariants()` function missing | `a8062ea` Jul 13 | HIGH | Fork cannot consume `reasoning_options` metadata from models.dev |
| `ReasoningOption` schema missing | `a8062ea` | HIGH | Same root cause |
| Gateway variants route by `api.id` (not `model.id`) | `8168f0f` Jul 13 | MEDIUM | Gateway-routed models get wrong variants |
| GLM-5.2 native high/xhigh/max | `22cc758` Jun 20 | MEDIUM | GLM-5.2 needs its native variant map |

## Why the user's M3/DeepSeek variants don't show today

Two invalid assumptions in the original planning pass were corrected:

1. **The MCP tool server is NOT the LLM transport.** The user's `mcp.minimax` config in `opencode.json` registers an MCP tool server. The model transport for `minimax-coding-plan/MiniMax-M3` is whatever the provider plugin uses — likely `@ai-sdk/openai-compatible` (the models.dev default when npm is unspecified). The MCP block is unrelated.
2. **DeepSeek variants must come from models.dev metadata.** Current upstream returns no heuristic variants for most `deepseek-*` IDs. Inventing `low`/`medium`/`high` would be wrong. After PR 2, variants come from models.dev `reasoning_options`.

## Execution plan

### Phase 0 — Isolate and baseline

1. **Do not work on the current dirty worktree.** Stash uncommitted changes first.
2. Create a dedicated sync branch (`sync/upstream-providers`).
3. `git fetch upstream dev`.
4. Capture baseline typecheck + test results into `specs/banyancode/upstream-sync-baseline.md` so PRs can be diffed.
5. Validate that `packages/opencode` typecheck fails only with the known 3 `AppLayer` errors.

### PR 1 — Small upstream reasoning fixes (LOW risk)

Cherry-pick in dependency order on the sync branch:
- `3a669d5` — Sonnet 5 adaptive thinking
- `22cc758` — GLM-5.2 native high/max
- `8168f0f` — gateway variants route by `api.id`
- Lower-risk additions only after conflict inspection: `1db5c24` (Grok), `2e43d41` (Muse), `c4bc902` (Fable 5), `ab701d2` (vLLM), `373cd08` (Copilot endpoint)

Validation gate:
```bash
bun test ./test/provider/transform.test.ts
bun test ./test/provider/provider.test.ts
bun typecheck
```

### PR 2 — `reasoningVariants` metadata refactor (HIGH impact, schema-changing)

Cherry-pick `a8062ea314fb760723c551d786f5bfcd45ed733f` plus any required companion commit.

Files touched (from the upstream patch):
- `packages/core/src/models-dev.ts`
- `packages/core/test/models.test.ts`
- `packages/opencode/src/provider/provider.ts`
- `packages/opencode/src/provider/transform.ts`
- `packages/opencode/test/provider/provider.test.ts`
- `packages/opencode/test/provider/transform.test.ts`
- `packages/sdk/js/src/v2/gen/types.gen.ts`
- `packages/sdk/openapi.json`

Required follow-up:
```bash
cd packages/sdk/js
bun script/build.ts
```

This PR is the foundation that lets the fork consume future models.dev `reasoning_options` without code changes.

Validation gate:
```bash
bun typecheck
bun test ./test/provider/
bun test ./test/core/models.test.ts
bun test ./test/sdk/  # SDK regen tests
```

### PR 3 — Runtime model diagnostics (MANDATORY before PR 4)

Add a focused provider diagnostic test that resolves the user's two specific setups and reports the runtime shape. **Do not** write a MiniMax-specific patch before this returns.

Resolves:
- `minimax-coding-plan / MiniMax-M3` → `model.api.npm`, `model.api.id`, `model.capabilities.reasoning`, models.dev `reasoning_options`, generated `model.variants`
- `deepseek / <user model>` → same fields

If PR 2 already produces the expected variants for the user's npm package, PR 4 is unnecessary. The diagnostics file lives at:
- `packages/opencode/test/banyancode/upstream-sync/provider-diagnostics.test.ts`

### PR 4 — MiniMax and DeepSeek compatibility patch (CONDITIONAL on PR 3)

Only if PR 3 shows the resolved transport is unsupported by `reasoningVariants`, add a narrow adapter. Rules:

- Trust `reasoning_options` from models.dev, never invent effort values.
- Match the actual transport’s provider-options shape (check the `npm` field).
- Do not add a generic `file://` rule unless the diagnostic proves that is the model transport.
- Add exact regression tests for:
  - `minimax-coding-plan/MiniMax-M3`
  - `deepseek / <target model>`
  - disabled or absent reasoning metadata
  - catalog-provided empty reasoning options

### PR 5 — BanyanCode endpoint wiring (BanyanCode-only feature, NOT an upstream cherry-pick)

The schema `banyancode_openai_compatible_endpoints` is currently defined but has no consumer. Implement it now that upstream provider surfaces are stabilized:

- Read endpoints from `BanyanConfig` in `packages/core/src/banyancode/`.
- Register each through the existing `@ai-sdk/openai-compatible` provider plugin.
- Surface the resulting provider + models in the catalog.
- Wire UI controls into `packages/tui/src/feature-plugins/tabs/tab-settings.tsx`.
- Tests at provider/catalog/UI layers.

### PR 6 — Dependency synchronization (LAST)

Apply upstream-compatible SDK bumps only after functional provider sync is green:
- `@ai-sdk/cerebras`
- `@ai-sdk/xai`
- `@ai-sdk/venice`
- `gitlab-ai-provider`
- `opencode-gitlab-auth`

Then:
```bash
bun install
bun typecheck
bun test ./test/provider/
```

## Open decisions (validated)

- **Sync scope:** Full sync — 6 PRs.
- **MCP safety gate:** Always enable thinking variants when models.dev metadata marks the model as reasoning-capable. The MCP server is the tool layer, not the LLM transport — the right gate is models.dev metadata.
- **M3 endpoint resolution:** Diagnose the runtime transport first (PR 3). Only patch if the resolved `npm` is unsupported. Do not assume `file://`.
- **Execution order:** Baseline typecheck/test first (Phase 0), then PR 1 small commits, then PR 2 refactor, then PR 3 diagnostics, then PR 4 if needed, then PR 5, then PR 6 dep bumps last.

## Risk and mitigation

| Risk | Mitigation |
|---|---|
| Schema migration in PR 2 breaks consumer code | Typecheck across all packages after cherry-pick; SDK regen is mandatory |
| Cherry-pick conflicts on the dirty worktree | Stash first; do not start sync on uncommitted state |
| MiniMax M3 MCP vs transport confusion | PR 3 diagnostic resolves it before any patch |
| DeepSeek variant invention | Trust models.dev `reasoning_options`; do not invent `low`/`medium`/`high` |
| Missing upstream commit objects | `git fetch upstream dev` before any cherry-pick |
| Dependency bumps regress behavior | Apply after functional sync is green; baseline tests gate |

## Out of scope for this plan

- Larger UX changes (sidebar layout, model picker dialog)
- Mesh / orchestration work (PRs A, C, D from the prior build pass)
- Adding new tool surfaces
- BanyanCode-only agents / prompts

## Validation criteria (final)

- `bun typecheck` in `packages/core`, `packages/tui`, `packages/opencode` succeeds with the known 3 baseline `AppLayer` errors only.
- `bun test ./test/provider/` passes.
- The user's specific setup `minimax-coding-plan/MiniMax-M3` exposes variants matching models.dev metadata.
- `deepseek` model setup exposes catalog-advertised variants.
- SDK regen is committed in the same PR as the schema migration.
- All baseline banyancode tests pass.

## Rollback strategy

Each PR is independently revertible. If PR 2 causes downstream regressions, the `reasoning_options` schema can be reverted by reverting PR 2 alone; PR 1 fixes remain valid.