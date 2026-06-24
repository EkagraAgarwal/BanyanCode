# Deep Codebase Review — Refactor Plan

**Source review:** `.banyancode/deep-codebase-review.md` (104 findings, 4 Critical, 14 High, 41 Medium, 45 Low)
**Branch:** `review-fixes` (off `codegraph-tui-fixes`)
**Goal:** Resolve findings in priority order. Verify with `bun typecheck` and full test suite after each phase.

---

## Phase 1 — Critical correctness

Resolve the four Critical findings. These are correctness/security bugs; the rest of the refactor builds on a solid foundation.

### 1.1 Path traversal in `banyanAgentSaveHandler`
**Files:**
- `packages/opencode/src/server/routes/instance/httpapi/groups/global.ts` — tighten `BanyanAgentSaveInput.name` with `Schema.pattern(/^[a-zA-Z0-9._-]+$/)` and bound `description` length.
- `packages/opencode/src/server/routes/instance/httpapi/handlers/global.ts` — escape frontmatter fields, validate name matches the pattern in the handler as a defense-in-depth, return `InvalidRequestError` on failure.

### 1.2 System-monitor unbounded queue + per-`watch` fiber leak
**File:** `packages/core/src/banyancode/system-monitor.ts`
- Replace `Queue.unbounded` with `Queue.bounded<SystemStatus>(60)` for the shared poll.
- Hoist polling to a single `Effect.forkIn(work, yield* Effect.scope)` inside the layer.
- Replace `watch()`'s `runForkWith` with `Stream.fromEffect(status()).pipe(Stream.schedule(Schedule.spaced(...)))` derived from the same shared state.
- Update `Interface` docs; consumers may shift from imperative queue to reactive stream.

### 1.4 `subagent-consumer.start` is a no-op
**Files:**
- `packages/core/src/banyancode/subagent-bus.ts` — add `markDelivered(ids: string[])` repo method; switch `subscribe` to `Stream` over `PubSub` so multiple consumers don't conflict.
- `packages/core/src/banyancode/subagent-messages-repo.ts` — add the `markDelivered` SQL.
- `packages/core/src/banyancode/subagent-consumer.ts` — wire `start` to `loop(input, queue)` via `Effect.forkIn`.

### 1.4 Tests for Phase 1
- `packages/core/test/banyancode/system-monitor.test.ts` — assert the polling fiber is interruptible (use `Effect.scoped` + interrupt) and the queue is bounded.
- `packages/core/test/banyancode/subagent-consumer.test.ts` — replace the trivial single-assertion test with a full loop test: publish `plan` message, assert memory receives it; publish `kill`, assert loop exits.
- `packages/core/test/banyancode/subagent-messages-repo.test.ts` — add `markDelivered` round-trip test.
- `packages/opencode/test/banyancode/banyan-agent-save-validation.test.ts` (NEW) — assert path traversal is rejected with `InvalidRequestError`.

**Verify:** `bun typecheck` from `packages/core`, `packages/opencode`, `packages/tui`. Full `bun test` from each.

---

## Phase 2 — RAM and subscription leaks

### 2.1 TUI `ev.on()` missing `onCleanup`
**Files (5):**
- `packages/tui/src/feature-plugins/tabs/tab-graph.tsx`
- `packages/tui/src/feature-plugins/sidebar/codegraph-panel.tsx`
- `packages/tui/src/feature-plugins/inspector/graph-explorer.tsx`
- `packages/tui/src/feature-plugins/sidebar/agent-tree.tsx`
- `packages/tui/src/routes/session/index.tsx`

Pattern:
```tsx
const unsub = ev.on("banyancode.codegraph.build", handler)
onCleanup(unsub)
```

### 2.2 Process-global unbounded Maps in core
**Files:**
- `packages/core/src/effect/keyed-mutex.ts` — move `locks` Map into a `Ref` with `ScopedCache`-style finalizer.
- `packages/core/src/effect/service-use.ts` — convert `cache` Map to `WeakMap` keyed by the service.
- `packages/core/src/event.ts` — convert `listeners`/`projectors`/`syncHandlers` to `Set`; projector registry gets `Effect.addFinalizer` removal.
- `packages/core/src/session/run-coordinator.ts` — add `Effect.addFinalizer` on entry to clear `active` and `interruptSeq`.

### 2.3 Tests for Phase 2
- New `packages/tui/test/feature-plugins/tabs/tab-graph-cleanup.test.tsx` — mount the tab, unmount, fire event, assert handler is not invoked.
- `packages/core/test/effect/keyed-mutex.test.ts` (NEW) — assert map size returns to 0 after `Scope` closes.
**Verify:** typecheck + full test suite.

---

## Phase 3 — Performance

### 3.1 Pagination + push-down WHERE on `CodegraphRepo`
**File:** `packages/core/src/banyancode/codegraph-repo.ts`
- Add `streamNodes({ afterID?, kind?, limit?, name? })` returning a `Stream`.
- Add `countNodes()` / `countEdges()` / `countFiles()` for cheap cardinality.
- Replace `queryNodes` with a SQL `WHERE`.
- Update `bumpVersion` to use `COUNT(*)`.
- Update `banyan-config.ts` HTTP `/global/codegraph-nodes` and `/global/codegraph-edges` to accept `limit`/`cursor` query params and return `{ items, total, nextCursor }`.

### 3.2 Batch indexer
**File:** `packages/core/src/banyancode/codegraph-indexer.ts`
- Buffer nodes + edges in memory, flush via Drizzle `insert(...).values([...batch])` with `onConflictDoUpdate`.
- Use one transaction per file (or batch of N files) instead of N inserts.

### 3.3 Centralize graph traversal in `CodegraphAnalyzer`
- Move the duplicated `outAdj`/`inAdj`/`degree` BFS from `tab-graph.tsx` and `codegraph-panel.tsx` into a server-side `codegraph.layerSummary({ nodeID })` Effect.
- New HTTP endpoint `GET /global/codegraph-layers?nodeID=...` returns `{ L0, L1, L2, L3, totalNodes, totalEdges }`.
- TUI uses `createResource` over this single endpoint instead of computing locally.

### 3.4 `compaction.ts` and `input.ts` JSON.stringify in hot path
- `packages/core/src/session/compaction.ts:79` — replace `JSON.stringify` with structural size estimate.
- `packages/core/src/session/input.ts:207-209` — replace with content hash.

### 3.5 `message-updater.ts` `findLastIndex` per event
- Maintain a parallel `Map<MessageID, number>`.

### 3.6 Tests for Phase 3
- `packages/core/test/banyancode/codegraph-pagination.test.ts` (NEW) — seed 5000 nodes, stream with limit 100, assert correct cursor progression.
- `packages/core/test/banyancode/codegraph-layers-endpoint.test.ts` (NEW) — fixture graph, assert layer counts.

**Verify:** typecheck + full test suite. (Optional: `bun run bench:test` from `packages/opencode` for a perf before/after.)

---

## Phase 4 — UI modernization

### 4.1 Keyboard navigation for tabs/accordion/toggle/number-input
**Files:**
- `packages/tui/src/feature-plugins/tabs/tab-bar.tsx` — register `app.tab.next`/`app.tab.prev` keybinds, focus-visible state.
- `packages/tui/src/ui/accordion.tsx` — Enter/Space to toggle.
- `packages/tui/src/ui/toggle-switch.tsx` — Space to flip.
- `packages/tui/src/ui/number-input.tsx` — Enter commits, Esc cancels (probably already).

### 4.2 Designed empty/loading/error states
- Create `packages/tui/src/ui/empty-state.tsx` — glyph + message + suggested action.
- Apply across `tab-sessions`, `tab-agents`, `tab-graph`, `tab-memory`, `codegraph-panel`, `agent-tree`.

### 4.3 Status pill glyphs
- `packages/tui/src/feature-plugins/header/status-pills.tsx` — pair color with `●/○/◐/✗` glyph.

### 4.4 Accessibility hooks
- Add `accessibilityLabel`/`accessibilityRole` to interactive widgets (tabs, accordion, toggle, dialogs, sidebar tree).
- Add `prefersReducedMotion` flag in theme.

### 4.5 Spacing/typography tokens
- Create `packages/tui/src/ui/tokens.ts` with `space` and `fontWeight` const maps.

### 4.6 `tab-content` wrapper component
- `packages/tui/src/ui/tab-content.tsx` — wraps the scrollbox + title + show/fallback pattern.
- Refactor `tab-sessions`, `tab-agents`, `tab-graph`, `tab-memory`, `tab-settings` to use it.

### 4.7 Contextual keybinding footer
- `packages/tui/src/feature-plugins/footer/session-footer.tsx` — render 3 most-contextual keybindings via the keymap API.

### 4.8 Tests for Phase 4
- New `packages/tui/test/ui/tab-content.test.tsx`.
- New `packages/tui/test/ui/empty-state.test.tsx`.
- New `packages/tui/test/feature-plugins/tabs/tab-bar-keyboard.test.tsx` — simulate Tab keypress, assert active tab advances.
- Snapshot tests for `empty-state`, `tab-content`, header pills.

**Verify:** typecheck + full test suite.

---

## Phase 5 — Quality bar

### 5.1 Delete empty / no-op tests
- `packages/opencode/test/banyancode/agent-model-store.test.ts` — delete (4 trivial assertions).
- `packages/opencode/test/banyancode/codegraph.test.ts` — delete or fix (3 `it.live.skip`).
- `packages/core/test/banyancode/code-find.test.ts` — replace inline arithmetic with real tool invocation.

### 5.2 Replace `.map()` in JSX with `<For>`
**Files (6):**
- `packages/tui/src/feature-plugins/tabs/tab-bar.tsx:59`
- `packages/tui/src/feature-plugins/tabs/tab-settings.tsx:139`
- `packages/tui/src/feature-plugins/inspector/graph-explorer.tsx:145-150`
- `packages/tui/src/feature-plugins/sidebar/files.tsx` (likely)
- `packages/tui/src/feature-plugins/sidebar/agent-tree.tsx`
- `packages/tui/src/component/dialog-select.tsx` (tabs.map)

### 5.3 Centralize duplicated UI helpers
- New `packages/tui/src/util/agent-tools.ts` — `toolsUsed(messages)`.
- New `packages/tui/src/ui/progress-bar.tsx` — `<ProgressBar value={0..1} thresholds={{...}} />`.
- Update consumers in `agent-tree`, `agent-details`, `system-status`, `codegraph-panel`.

### 5.4 Resolve `// TODO(v2)` markers
- `packages/opencode/src/session/processor.ts` — review the 15+ `// TODO(v2)` lines; resolve or move to `specs/v2/migration.md`.

### 5.5 Remove `as any` casts that should be regen-able
- `packages/tui/src/component/dialog-memory.tsx` — drop the `(props.api.client as any).memory?.list?.(...)` cast by regen'ing the SDK (`packages/sdk/js/script/build.ts`).
- `packages/opencode/src/server/routes/instance/httpapi/handlers/global.ts:268` — register `banyancode.config.updated` in `EventV2`, regen SDK.
- `packages/opencode/src/command/index.ts:194,199` — fix `execute` return type or change YOLO command to use a real return schema.

### 5.6 Add perf docs
- `perf/tui-render.md` — render frame cost at 80×24, 120×40, 200×60.
- `perf/memory.md` — RSS after warmup, GC pauses for long sessions.
- `perf/codegraph-build.md` — files/sec, MB/sec.

### 5.7 Tests for Phase 5
- Update stale tests after SDK regen to use typed methods.
- Add `packages/core/test/banyancode/code-find-real-tool.test.ts` (NEW) that drives the actual `code_find` tool through `mat.settle`.

**Verify:** typecheck + full test suite. `bun run bench:test` from `packages/opencode` to confirm no perf regression.

---

## Out of scope (deferred)

- Solid reconciler micro-optimizations (`createMemo` everywhere)
- TUI bundle size tracking
- Sustained-soak memory test
- Provider-specific logic extraction in `agent.ts:538`

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

After each phase, run all three `bun typecheck` and `bun test` invocations before committing.

---

## Commit policy

One commit per finding (or per coherent fix group) per AGENTS.md. Phase commits summarize the phase with `refactor(scope):` messages. The lead agent (this session) does all commits. Coder subagents return file lists, never commit.

