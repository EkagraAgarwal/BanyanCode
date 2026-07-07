# Permission Bypass for `code_find` and `websearch_free`

**Date:** 2026-07-08
**Status:** Implemented

## Diagnosis

The `code_find` and `websearch_free` tools required manual permission approval every time, even when the user clicked "Allow Always". The root cause was a two-part bug in `packages/opencode/src/effect/permission-bridge.ts`:

1. **Defect in `toAskInput` (line 12):** When `save: ["*"]` (the user's "allow always" intent), the `always` field was mapped to `[...input.resources]` — the actual resource symbols — instead of preserving `"*"`. This caused the V1 rule stored to be `{ permission: "code_find", pattern: "Agent" }` instead of `{ permission: "code_find", pattern: "*" }`, so subsequent calls with different symbols re-triggered the prompt.

2. **Missing bypass predicate:** The bridge's `assert` and `ask` functions bypass V1 for `codegraph_*`, `repository_*`, and `edit_plan` tools (deemed safe by design), but `code_find` and `websearch_free` were not in the bypass list. They fell through to `v1.ask()`, which triggered the broken `toAskInput` mapping.

## Fix

### Edit A — `permission-bridge.ts:12`

```ts
// Before:
always: input.save?.includes("*") ? [...input.resources] : [],

// After:
always: input.save?.includes("*") ? input.save : [],
```

This preserves the user's `"*"` intent instead of substituting resources.

### Edit B — `permission-bridge.ts:63-74, 76-93`

Added `code_find` and `websearch_free` to the bypass predicate in both `assert` and `ask`:

```ts
if (
  input.action.startsWith("codegraph_") ||
  input.action.startsWith("repository_") ||
  input.action === "edit_plan" ||
  input.action === "code_find" ||
  input.action === "websearch_free"
) {
  return // (assert) or return { id, effect: "allow" } (ask)
}
```

## Rationale

`code_find` and `websearch_free` are read-only tools — `code_find` searches code symbols and `websearch_free` performs web search. Neither writes files, spawns subprocesses, or has network side-effects beyond the search query itself. They are equivalent in risk class to `grep`/`read`/`glob`, which never trigger permission prompts.

All built-in agents already declare `code_find: "allow"` (e.g., `packages/opencode/src/agent/agent.ts:210,273,324,370,492`), and the plugin agent declares `{ action: "code_find", resource: "*", effect: "allow" }` in `packages/core/src/plugin/agent.ts:200`. The agents consider these tools allowed — only the bridge was re-prompting.

## Cross-References

- **Agent declaration:** `packages/opencode/src/agent/agent.ts:210` (`code_find: "allow"`)
- **Plugin declaration:** `packages/core/src/plugin/agent.ts:200`
- **Bypass predicate:** `packages/opencode/src/effect/permission-bridge.ts:63-93`
- **Defensive `always` fix:** `packages/opencode/src/effect/permission-bridge.ts:12`
- **YOLO mode still applies:** `packages/opencode/src/permission/index.ts:85` — `banyancode_yolo_mode` in `BanyanConfig` still short-circuits all permission prompts before any other logic, including for non-bypass actions.

## Regression Test

`packages/opencode/test/banyancode/permission-bypass.test.ts` verifies:
- `assert({ action: "code_find", ... })` does NOT call `v1.ask`
- `assert({ action: "websearch_free", ... })` does NOT call `v1.ask`
- `assert({ action: "bash", ... })` still calls `v1.ask` (bypass does not over-extend)
- `ask({ action: "code_find", ... })` returns `effect: "allow"` without calling `v1.ask`
- `ask({ action: "websearch_free", ... })` returns `effect: "allow"` without calling `v1.ask`
- `toAskInput` preserves `"*"` in `always` when `save` contains `"*"`
