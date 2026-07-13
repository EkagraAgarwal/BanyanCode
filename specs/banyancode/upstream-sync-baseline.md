# Upstream Sync Baseline

Captured on `sync/upstream-providers` branch at `mesh-phase0-complete` HEAD before any cherry-picks.

## Typecheck

| Package | Errors | Notes |
|---|---|---|
| `packages/core` | 0 | Clean |
| `packages/tui` | 0 | Clean |
| `packages/opencode` | 3 (known baseline) | `app-runtime.ts:205`, `app-runtime-logger.test.ts:44`, `httpapi-exercise/index.ts:1560` — pre-existing `as unknown as Layer.Layer<never, never, never>` cast issues. PR F scope from previous build pass. |

## Test suites

| Suite | Result | Notes |
|---|---|---|
| `packages/opencode/test/provider/transform.test.ts` | 259 pass, 0 fail | Clean |
| `packages/opencode/test/provider/provider.test.ts` | 87 pass, 1 fail (timeout flake) | `opencode loader keeps paid models when auth exists` timed out at 5297ms — unrelated to provider sync |
| `packages/core/test/models.test.ts` | 9 pass, 0 fail | Clean |

## Cherry-pick availability

| Commit | Local availability | Action |
|---|---|---|
| `3a669d5` (Sonnet 5 adaptive) | Present | PR 1 |
| `22cc758` (GLM-5.2 native high/max) | Present | PR 1 |
| `8168f0f` (gateway variants by api id) | Now fetched | PR 1 |
| `a8062ea` (reasoningVariants refactor) | Now fetched | PR 2 |

## Stash

Working changes from previous build pass are stashed as:
```
stash@{0}: On mesh-phase0-complete: wip: prior build phase changes
```

Includes: mesh-coordinator fixes, codegraph tools, mesh orchestration, prompt centering, message-block cleanup, model picker fix, agents dump spec.