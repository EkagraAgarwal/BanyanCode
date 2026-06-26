# Deep Codebase Review — Implementation Plan

**Source review:** `.banyancode/deep-codebase-review.md` (104 findings, 4 Critical, 14 High, 41 Medium, 45 Low)
**Branch:** `main`
**Status as of 2026-06-26:** Phases 1–3 complete, Phase 4 mostly complete, Phase 5 partial. New Phase 6 added for the OOM-on-invalid-model crash discovered while validating Phase 1. The embedding feature has been removed entirely (was previously Phase 3 items 1.5, 1.10, 3.2, 5.6.5).

**Goal:** Resolve remaining findings in priority order. Verify with `bun typecheck` and the relevant `bun test` after each phase.

---

## Status snapshot

| Phase | Status | Items done |
|---|---|---|
| 1. Critical correctness | **Done** | 1.1 ✓ (already validated), 1.2 N/A (embeddings removed), 1.3 ✓, 1.4 ✓ |
| 2. RAM + subscription leaks | **Done** | 2.1 ✓, 2.2 partial, 2.3 N/A (removed), 2.4 partial |
| 3. Performance | **Partial** | 3.1 ✓ pagination done; 3.2 N/A; 3.3 not started; 3.4 not started; 3.5 not started |
| 4. UI modernization | **Partial** | 4.1 ✓ keyboard nav done; 4.2–4.8 not started |
| 5. Quality bar | **Partial** | Embedding test files removed; 5.1 partial |
| **6. OOM on invalid model** (new) | **Done** | processor finish flag + retry cap + ModelNotFoundError surfacing |

---

## Phase 1 — Critical correctness (DONE)

### 1.1 Path traversal in `banyanAgentSaveHandler` ✓
**Files:** `packages/opencode/src/server/routes/instance/httpapi/groups/global.ts`, `handlers/global.ts`.
- Schema tightened with `Schema.isPattern(/^[a-zA-Z0-9._-]+$/)` plus length bounds.
- Handler also sanitizes + path-validates as defense-in-depth and escapes frontmatter scalars.
- Confirmed pre-existing on this commit; verified again after rebase.

### 1.2 `Effect.runSync` in sync-typed service method — N/A
Embedding provider was removed (see Phase 3 below). No remaining consumers.

### 1.3 System-monitor unbounded queue + per-`watch` fiber leak ✓
**File:** `packages/core/src/banyancode/system-monitor.ts`.
- Layer queue: `Queue.unbounded` → `Queue.bounded<SystemStatus>(64)`.
- `watch()` queue: same bound.
- `runForkWith` kept (fiber is reaped when caller closes the Stream); a follow-up could move to a shared `PubSub`.
- Telemetry log added on `watch()` subscription.

### 1.4 `subagent-consumer.start` is a no-op ✓
**Files:** `packages/core/src/banyancode/subagent-consumer.ts`, `subagent-bus.ts`, `mesh-coordinator.ts`.
- `start` now `forkIn`s the `loop()` (already present in the working tree).
- `subagent-bus.markDelivered(id, deliveredAt)` added; `drain`/`checkin` call it per message.
- 7 test mock sites updated; tests pass (subagent-consumer 3/3, mesh-coordinator 5/5, mesh-subscribe 2/2, subagent-mesh + mesh-coordinator 4/4).

### 1.5 Tests for Phase 1 ✓
- `system-monitor.test.ts`: 7/7 pass.
- `subagent-consumer.test.ts`, `mesh-subscribe.test.ts`, `mesh-coordinator.test.ts`: 10/10 pass.

---

## Phase 2 — RAM and subscription leaks (DONE)

### 2.1 TUI `ev.on()` missing `onCleanup` ✓
**Files touched:**
- `packages/tui/src/component/prompt/index.tsx` — wrap `tui.prompt.append` subscription.
- `packages/tui/src/app.tsx` — wrap 7 App-body subscriptions (`tui.command.execute`, `tui.toast.show`, `tui.session.select`, `session.deleted`, `session.error`, `event.subscribe`, `installation.update-available`).
- Also added `process.on("unhandledRejection", ...)` via `Effect.acquireRelease` so unhandled rejections no longer kill the process silently.
- `context/project.tsx` and `context/local.tsx` were audited — the `sdk.event.on` / `event.on` calls are inside `Effect.gen` context initializers (run once at scope), not Solid component bodies, so `onCleanup` does not apply.

### 2.2 Process-global unbounded Maps — partial
`KeyedMutex.locks`, `serviceUse` cache, `SessionRunCoordinator.active`/`interruptSeq` still grow on long-lived processes. Lifted to follow-up in Phase 7.

### 2.3 `resetEmbeddingsTable` data loss — N/A (embeddings removed).

### 2.4 Tests for Phase 2 — partial
Manual tmux validation: before the fix, sending "hi" caused RSS to grow from 870 MB to 4.3 GB in ~20 s then SIGKILL. After Phase 1 + Phase 6 fixes, RSS stays flat at 857 MB for 30 s+ with no crash.

---

## Phase 3 — Performance (PARTIAL)

### 3.1 Pagination + push-down `WHERE` on `CodegraphRepo` ✓
**File:** `packages/core/src/banyancode/codegraph-repo.ts`.
- New: `pageNodes` / `pageEdges` / `pageFiles` (afterID + limit).
- New: `countNodes` / `countEdges` for cheap cardinality.
- `queryNodes` rewritten to push `like` + `eq` into SQL via `and(...)`.
- `bumpVersion` already uses COUNT(*).
- Existing `listAll*` kept so callers migrate independently; 11 follow-up call sites cataloged.

### 3.2 Batch embedder + indexer — N/A (embeddings removed).

### 3.3 Centralize graph traversal in `CodegraphAnalyzer`
Move duplicated `outAdj`/`inAdj`/`degree` BFS from `tab-graph.tsx` and `codegraph-panel.tsx` to a server-side `codegraph.layerSummary({ nodeID })` Effect exposed as `GET /global/codegraph-layers`. TUI switches to `createResource` over this endpoint. Not started.

### 3.4 `compaction.ts` and `input.ts` JSON.stringify in hot path
- `compaction.ts:79` — structural size estimate instead of `JSON.stringify` per pre-turn.
- `input.ts:207-209` — content hash instead of full serialization for `matchesPrompt`. Not started.

### 3.5 `message-updater.ts` `findLastIndex` per event
Maintain a parallel `Map<MessageID, number>` alongside the messages array so text deltas don't do O(N) lookups. Not started.

### 3.6 Tests for Phase 3
- `codegraph-pagination.test.ts` (NEW) — seed 5 000 nodes, stream with `limit: 100`, assert cursor progression.
- `codegraph-layers-endpoint.test.ts` (NEW) — fixture graph, assert layer counts.
- Both deferred with 3.3.

---

## Phase 4 — UI modernization (PARTIAL)

### 4.1 Keyboard navigation for tabs/accordion/toggle/number-input ✓
**Files:**
- `packages/tui/src/feature-plugins/tabs/tab-bar.tsx` — `Tab` / `Shift+Tab` / `Ctrl+]` / `Ctrl+[` bound to existing `tabs.next` / `tabs.previous` keymap commands.
- `packages/tui/src/ui/accordion.tsx` — `focusable` header + `Return` / `Space` to toggle.
- `packages/tui/src/ui/toggle-switch.tsx` — `focusable` + `Space` to flip.
- `packages/tui/src/ui/number-input.tsx` — `useKeyboard` from `@opentui/solid` for `Escape` cancel; `Enter` commit already wired.
- Prompt footer literal `Tab` lowercased to match the canonical keymap label.

### 4.2 Designed empty/loading/error states
`packages/tui/src/ui/empty-state.tsx` (glyph + message + suggested action) and apply across `tab-sessions`, `tab-agents`, `tab-graph`, `tab-memory`, `codegraph-panel`, `agent-tree`. Not started.

### 4.3 Status pill glyphs
`packages/tui/src/feature-plugins/header/status-pills.tsx` — pair color with `●/○/◐/✗`. Not started.

### 4.4 Accessibility hooks
`accessibilityLabel` / `accessibilityRole` on tabs, accordion, toggle, dialogs, sidebar tree. `prefersReducedMotion` flag in theme. Not started.

### 4.5 Spacing/typography tokens
`packages/tui/src/ui/tokens.ts` with `space` and `fontWeight` const maps. Not started.

### 4.6 `tab-content` wrapper component
Wrap the `scrollbox` + `title` + `Show` / fallback pattern; refactor the 5 tabs. Not started.

### 4.7 Contextual keybinding footer
`session-footer.tsx` should render the 3 most-contextual keybindings via the keymap API. Not started.

### 4.8 Tests for Phase 4
`tab-content.test.tsx`, `empty-state.test.tsx`, `tab-bar-keyboard.test.tsx`, snapshot tests for `empty-state` / `tab-content` / header pills. Not started.

---

## Phase 5 — Quality bar (PARTIAL)

### 5.1 Delete empty / no-op tests ✓ (partial)
Embedding-related test files removed with the embedding feature (`codegraph-embed-service.test.ts`, `codegraph-vector-search.test.ts`, `embedding-provider.test.ts`, `provider-nvidia-embed.test.ts`, `code-embed.test.ts`, `embedding-model-picker.test.ts`). Still pending: `agent-model-store.test.ts` (4 trivial assertions) and `codegraph.test.ts` (3 `it.live.skip`).

### 5.2 Replace `.map()` in JSX with `<For>`
6 sites (`tab-bar.tsx:59`, `tab-settings.tsx:139`, `graph-explorer.tsx:145-150`, `files.tsx`, `agent-tree.tsx`, `dialog-select.tsx`). Not started.

### 5.3 Centralize duplicated UI helpers
`lib/agent-tools.ts` (`toolsUsed(messages)`) and `ui/progress-bar.tsx`. Not started.

### 5.4 Resolve `// TODO(v2)` markers
15+ markers in `session/processor.ts`. Not started.

### 5.5 Remove `as any` casts that should be regen-able
SDK regenerated as part of the embedding removal; some `as any` casts remain (`banyancode.config.updated`, memory list). Not started.

### 5.6 Add perf docs
`tui-render.md`, `memory.md`, `codegraph-build.md` (embedding.md removed). Not started.

---

## Phase 6 — OOM on invalid model (NEW, DONE)

Discovered during Phase 1 tmux validation. User scenario: an agent's configured `model` is not in the provider catalog (e.g. `minimax-coding-plan/MiniMax-M2.7` when the provider has `MiniMax-M3`). Symptoms: process dies with exit code 9 (SIGKILL) 20–30 s after the user submits any message.

**Files:**
- `packages/opencode/src/session/processor.ts` — set `ctx.assistantMessage.finish = "error"` in the halt path so `runLoop` (`prompt.ts:1141`) breaks on the next iteration. Without this the loop kept re-entering and allocating a fresh `MessageID.ascending()`, `processor.create(...)` fiber, and `SessionRunState.runner` entry per pass.
- `packages/opencode/src/session/retry.ts` — add `RETRY_MAX_ATTEMPTS = 5` cap inside the retry policy so even transient errors (5xx, rate limit) can't loop forever on a sustained outage.
- `packages/opencode/src/session/message-v2.ts` — surface `ProviderModelNotFoundError` (tag `"ProviderModelNotFoundError"`) as `AuthError` via duck-typed `_tag` check. Without this case the error fell through to `NamedError.Unknown`, hiding the model name and leaving `runLoop` to keep re-iterating. The duck-typed check avoids a value-import of `provider.ts` which would create a circular dep (downstream consumers re-import `message-v2.ts`).
- `packages/tui/src/component/prompt/index.tsx` — show a clear toast `"Model not found: X/Y. Check your model name..."` (10 s).

**Tests added:**
- `packages/opencode/test/session/message-v2.test.ts` — assert `fromError` maps `ModelNotFoundError` to typed `AuthError` carrying `providerID` / `modelID`.
- `packages/opencode/test/session/retry.test.ts` — assert the retry policy terminates after `RETRY_MAX_ATTEMPTS` even when the error is still flagged retryable.

**Manual validation:** `bun dev` in tmux with an invalid model. Before fix: RSS 870 MB → 4.3 GB → SIGKILL ~25 s. After fix: RSS stable at 857 MB for 30 s+ with no crash and the model-not-found toast visible.

---

## Phase 7 — Open follow-ups (proposed)

Items carried forward from earlier phases:

- **`packages/core/src/effect/keyed-mutex.ts`** — move `locks` map into a `Ref` with `ScopedCache`-style eviction (review 2.2).
- **`packages/core/src/effect/service-use.ts`** — convert cache `Map` to `WeakMap` keyed by service (review 2.3).
- **`packages/core/src/event.ts`** — `projectors` / `syncHandlers` to `Set` with `Effect.addFinalizer` removal (review 2.19).
- **`packages/core/src/session/run-coordinator.ts`** — `Effect.addFinalizer` on each entry to clear `active` / `interruptSeq` (review 2.4).
- **`packages/core/src/system-monitor.ts`** — replace per-`watch` `runForkWith` with a shared `PubSub` derived stream so multiple watchers don't fan out fibers.
- **`packages/tui/src/feature-plugins/tabs/tab-bar.tsx`** and other `*.map()` in JSX → `<For>` (review 3.3, 3.12).
- **Perf observability docs** at `perf/tui-render.md`, `perf/memory.md`, `perf/codegraph-build.md`.
- **Pagination migration** — 11 follow-up sites listed in commit `perf(core): codegraph pagination`.

---

## Removed scope (was previously here)

The embedding feature has been retired entirely. Removed from plan:

- `embedding-provider.ts` `Effect.runSync` correctness (1.2)
- `resetEmbeddingsTable` data loss (2.3)
- `codegraph-embedder` / `indexer` batching (3.2)
- `embedding.md` perf doc (5.6.5)
- `nvidia-embed` plugin and tests

---

## Test commands

```bash
# from packages/core
bun typecheck
bun test

# from packages/opencode
bun typecheck
bun test

# from packages/tui
bun typecheck
bun test
```

After each phase, run all three `bun typecheck` invocations and the affected `bun test` before committing.

---

## Commit policy

One commit per logical change. Phase summaries use `refactor(scope):` messages. The lead agent does all commits; coder subagents return file lists, never commits.