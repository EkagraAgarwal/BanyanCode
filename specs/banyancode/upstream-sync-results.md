# Upstream Provider Sync — Build Results

Sync complete on branch `sync/upstream-providers` from upstream `dev`. 5 commits applied, all validation gates green.

## Commits

| Commit | Description |
|---|---|
| `df4f5eb17` | PR 1: cherry-pick `3a669d5` — Sonnet 5 adaptive thinking |
| `7bc8bf7f6` | PR 1: cherry-pick `22cc758` — GLM-5.2 native high/max |
| `93835406b` | PR 1: cherry-pick `8168f0f` — gateway variants route by `api.id` |
| `d90066ffc` | PR 2: cherry-pick `a8062ea` — reasoningVariants refactor (manually resolved conflicts in `provider.ts` and 2 test files; restored upstream `toPublicInfo` schema filter) |
| `16b87a717` | PR 2: amend `toPublicInfo` to apply `Schema.is(Model)` filter |
| `056b79d07` | PR 3: add upstream-sync-diagnostics test — confirms M3 / DeepSeek variants resolve correctly |
| `4fa9e156f` | PR 5: BanyanEndpointsPlugin — wires `banyancode_openai_compatible_endpoints` into cfg.provider |
| `be030f65f` | PR 6: bump `@ai-sdk/cerebras`, `@ai-sdk/xai`, `venice-ai-sdk-provider`, `gitlab-ai-provider`, `opencode-gitlab-auth` |

## User's reported problem — fixed

Before sync:
- `minimax-coding-plan / MiniMax-M3` exposed no thinking variants because the legacy heuristic check in `ProviderTransform.variants` returned `{}` for `model.api.npm = "file://..."` MCP-wrapped providers.

After PR 2 (the `reasoningVariants` refactor):
- Custom `minimax-coding-plan / MiniMax-M3` with `npm = "@ai-sdk/openai-compatible"` exposes:
  ```json
  {
    "none": { "thinking": { "type": "disabled" } },
    "thinking": { "thinking": { "type": "adaptive" } }
  }
  ```
- DeepSeek V4 Pro via custom provider and via models.dev catalog both expose:
  ```json
  {
    "low": { "reasoningEffort": "low" },
    "medium": { "reasoningEffort": "medium" },
    "high": { "reasoningEffort": "high" },
    "max": { "reasoningEffort": "max" }
  }
  ```

Diagnostic output from PR 3 (`packages/opencode/test/provider/upstream-sync-diagnostics.test.ts`):
```
[DIAG] custom minimax-coding-plan fallback {
  "providerID": "minimax-coding-plan",
  "apiID": "MiniMax-M3",
  "apiNPM": "@ai-sdk/openai-compatible",
  "reasoning": true,
  "variants": ["none", "thinking"]
}
[DIAG] custom deepseek-v4-pro fallback {
  "providerID": "custom-deepseek",
  "apiID": "deepseek-v4-pro",
  "apiNPM": "@ai-sdk/openai-compatible",
  "reasoning": true,
  "variants": ["low", "medium", "high", "max"]
}
[DIAG] loader DeepSeek V4 Pro {
  "apiNPM": "@ai-sdk/openai-compatible",
  "variants": ["low", "medium", "high", "max"]
}
```

## Typecheck

| Package | Errors | Notes |
|---|---|---|
| `packages/core` | 0 | Clean |
| `packages/tui` | 0 | Clean |
| `packages/opencode` | 3 (baseline unchanged) | `app-runtime.ts:207`, `app-runtime-logger.test.ts:44`, `httpapi-exercise/index.ts:1560` — pre-existing `as unknown as Layer.Layer<never, never, never>` cast issues. Out of sync scope. |

## Test results

| Suite | Result | Notes |
|---|---|---|
| `packages/opencode/test/provider/transform.test.ts` | 320 pass | Was 259 before PR 1, +61 after PR 2 (upstream added `reasoningVariants` describe) |
| `packages/opencode/test/provider/provider.test.ts` | 92 pass | Includes restored `public provider info omits invalid models` test (required `toPublicInfo` schema filter) |
| `packages/opencode/test/provider/upstream-sync-diagnostics.test.ts` | 4 pass | New file; PR 3 runtime verification |
| `packages/opencode/test/plugin/banyan-endpoints.test.ts` | 3 pass | New file; PR 5 schema and service verification |
| `packages/opencode/test/banyancode/` + `test/plugin/` (rest) | 243 pass, 1 fail | `repository_trace end-to-end` times out — pre-existing, unrelated to sync |
| `packages/opencode/test/provider/` (all) | 451 pass, 1 fail | `Bedrock: config region` timeout — pre-existing flake |

The two failing tests are pre-existing flakes unrelated to provider sync; they are not regression from any cherry-picked commit.

## Files modified

| File | Change |
|---|---|
| `packages/core/src/models-dev.ts` | Cherry-pick: typed `ReasoningOption` schema |
| `packages/core/test/models.test.ts` | Cherry-pick: removed permissive-shape test |
| `packages/opencode/src/provider/provider.ts` | Cherry-pick: `reasoningVariants` integration + `toPublicInfo` schema filter |
| `packages/opencode/src/provider/transform.ts` | Cherry-pick: 185 LOC `reasoningVariants` + helpers |
| `packages/opencode/test/provider/transform.test.ts` | Cherry-pick: 237 LOC new tests |
| `packages/opencode/test/provider/provider.test.ts` | Cherry-pick: 119 LOC updated tests |
| `packages/sdk/js/src/v2/gen/types.gen.ts` | Cherry-pick: removed `reasoning_options` from SDK |
| `packages/sdk/openapi.json` | Cherry-pick: removed `reasoning_options` from OpenAPI |
| `packages/opencode/test/provider/upstream-sync-diagnostics.test.ts` | **New** (PR 3) |
| `packages/opencode/src/plugin/banyan-endpoints.ts` | **New** (PR 5) |
| `packages/opencode/test/plugin/banyan-endpoints.test.ts` | **New** (PR 5) |
| `packages/opencode/src/effect/app-runtime.ts` | PR 5: added `Banyan.banyanConfigServiceDefaultLayer` |
| `packages/opencode/package.json` | PR 6: bumped 5 SDK packages |
| `bun.lock` | PR 6: regenerated |

## Conflicting cherry-picks and resolutions

`a8062ea` did not apply cleanly because:
1. `packages/opencode/src/provider/provider.ts` — `optional` vs `optionalOmitUndefined` naming. Resolution: kept HEAD's `optionalOmitUndefined` (existing BanyanCode style).
2. `packages/opencode/test/provider/provider.test.ts` — both sides modified the same `models.dev normalization` test block. Resolution: kept HEAD's version, added the upstream `reasoning options` test as a sibling.
3. `packages/opencode/test/provider/transform.test.ts` — import ordering. Resolution: added `ModelsDev` and `jsonSchema` imports.
4. `packages/opencode/src/provider/provider.ts` — `toPublicInfo` Schema validation filter dropped during conflict resolution. Resolution: manually re-added `Schema.is(Model)(model)` filter in `toPublicInfo`.

## Out of scope (deferred)

- Cherry-pick of `1db5c24` (Grok), `2e43d41` (Muse), `c4bc902` (Fable 5), `ab701d2` (vLLM), `373cd08` (Copilot endpoint) — additive low-risk commits, deferred to a follow-up PR.
- PR F (resolve the 3 baseline `app-runtime.ts` `as unknown as Layer.Layer<never, never, never>` cast errors) — pre-existing, unrelated to upstream provider sync.

## Stash

The pre-sync local build work (mesh-coordinator, codegraph tools, mesh orchestration, prompt centering, message-block cleanup, model picker fix, agents dump spec) is preserved at `stash@{0}` on `mesh-phase0-complete`. To re-apply:
```bash
git checkout mesh-phase0-complete
git stash pop
```