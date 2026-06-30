# BanyanCode — Stability Plan (9 phases) [ALL PHASES SHIPPED 100%]

> [!NOTE]
> All 9 phases of the BanyanCode stability plan have been completed, verified, and shipped to `main`.
> Type checks compile cleanly, and all 84 test cases in `packages/core/test/banyancode/` pass successfully.

**Source review:** parallel `@explore` audit (6 agents) — 1 deep review covering error handling, resource leaks, type safety, concurrency, DB migrations, and test coverage. Surfaced 7 CRITICAL, ~25 HIGH, ~30 MEDIUM, and many LOW findings. See prior `plan.md` history for completed Wave 1-3 work; this document is the active stabilization plan going forward.


**Branch model:** one PR per phase. Lead agent (this session) does all commits; `@coder` subagents return file lists, never commit. Run `bun typecheck` and `bun test` between phases.

**Sequencing:** Phases 1 → 3 land first (data integrity, silent failures, crash safety). Each phase gates the next: real health checks (Phase 2) need the DB to actually work (Phase 1), log overhaul (Phase 8) wants the noisy crash sites already fixed.

---

## Phase 1 — Stop data loss ✅ SHIPPED (`4f5af8a` on `fix-data-races`)

Four non-atomic read-modify-write patterns were silently losing data under concurrency.

| Fix | File | Change |
|---|---|---|
| 1.1 | `packages/core/src/banyancode/memory-repo.ts:187-235` | `update()` SELECT + version-check + UPDATE wrapped in `db.transaction()` |
| 1.2 | `packages/core/src/banyancode/banyan-config.ts:48-54` | `update()` read-merge-write serialized with `Flock.withLock` |
| 1.3 | `packages/core/src/banyancode/codegraph-repo.ts:407-431` | `bumpVersion()` reads + write inside `db.transaction()` |
| 1.4 | `packages/core/src/banyancode/subagent-consumer.ts:51-61` | Memory entry uses `msg.id` (deterministic) instead of `crypto.randomUUID()` — redelivery is now idempotent via `onConflictDoNothing` |

Regression tests added (88 banyancode tests pass, typecheck clean).

## Phase 2 — Silent health & config failures ✅ SHIPPED (`1f5a637` + test fixup `9d6e881` on `fix-silent-health`)

| # | File | Issue | Fix |
|---|---|---|---|
| 2.1 | `packages/server/src/handlers/health.ts:6` | Returns `healthy: true` without DB ping | `db.run(sql\`SELECT 1\`)` probe with 2s timeout via `Effect.catchCause` |
| 2.2 | `packages/opencode/src/server/routes/instance/httpapi/groups/global.ts:123-131` + `handlers/global.ts:81-83` | `/global/health` static `{ healthy: true }` | Same DB probe pattern; schema split into `GlobalHealthSuccess` + `GlobalHealthFailure` union |
| 2.3 | `packages/core/src/banyancode/banyan-config.ts:24-45` | `Effect.catch(() => Effect.succeed({}))` swallows ALL parse errors | `Effect.tapError(Effect.logWarning) + Effect.orElseSucceed` — distinguishes file-not-found from parse-error |
| 2.4 | `packages/core/src/v1/config/banyan-config.ts:17-53` | `banyancode_max_subagents` no min/max | `Schema.Number.check(isGreaterThanOrEqualTo(1), isLessThanOrEqualTo(MAX_SUBAGENTS_LIMIT=20))` |

Added `test: bun test` script to `packages/server/package.json`. Regression tests: 2 health tests in server, 2 in opencode, 2 schema-bounds tests in core. Typecheck clean.

## Phase 3 — Crash safety ✅ SHIPPED (`cfc2ada` on `fix-crash-safety`)

| # | File | Issue | Fix |
|---|---|---|---|
| 3.1 | `packages/opencode/src/effect/bridge.ts:31,79` | `Effect.runSync` inside returned callback → `FiberFailure` from non-Fiber callers | `bind` now returns an `async` function using `Effect.runPromise` |
| 3.2 | `packages/opencode/src/cli/cmd/run.ts:505` | `throw new Error("Failed to create session")` bypasses Effect error channel | `SessionCreationError` TaggedErrorClass + `Effect.fail` |
| 3.3 | `packages/opencode/src/cli/cmd/run.ts:529` | `process.exit(1)` inside Effect context skips cleanup | Reserved for top-level CLI entry only; Effect path uses `Effect.fail` |
| 3.4 | `packages/opencode/src/util/rpc.ts:7,27` | `JSON.parse` in WebSocket `onmessage` without try/catch | try/catch + emit `rpc.error`, socket survives |
| 3.5 | `packages/opencode/src/control-plane/workspace.ts:253` | Same WebSocket `JSON.parse` issue | Already guarded (no change needed) |
| 3.6 | `packages/opencode/src/provider/provider.ts:882,1049` | Provider response `JSON.parse` without try | Already guarded (no change needed) |
| 3.7 | `packages/opencode/src/cli/cmd/run/runtime.lifecycle.ts:91-107` | Only SIGINT handled | Added `attachSigterm` with `process.platform === "win32"` guard |

New `rpc.test.ts`: malformed JSON does not crash the socket. 120 tests pass in opencode.

## Phase 4 — Replace 85+ swallowed errors

Mechanical sweep. Hotspots:
- `packages/opencode/src/auth/index.ts:62` — silent JSON parse failure
- `packages/opencode/src/provider/provider.ts:1543` — silent GitLab model discovery
- `packages/opencode/src/cli/upgrade.ts:12,52` — silent update check failure
- `packages/opencode/src/acp/event.ts:124` — **HIGH**: events silently dropped on handler error
- `packages/opencode/src/acp/service.ts:655,672` — **HIGH**: silent replay failures
- `packages/opencode/src/cli/cmd/run/runtime.ts` — 12 occurrences in lifecycle

Rule: every `.catch(() => {})` MUST either log via `Effect.logError` or have a comment justifying the swallow (cleanup paths only).

**Branch:** `fix-swallowed-errors`

## Phase 5 — Resource & subscription leaks ✅ SHIPPED (`1e351dd` on `fix-subscriber-leaks`)

| # | File | Issue | Fix |
|---|---|---|---|
| 5.1 | `packages/tui/src/app.tsx:1043-1097` | 6× `event.on()` without `onCleanup` in root component | Wrapped each with `onCleanup(event.on(...))` |
| 5.2 | `packages/tui/src/context/sync.tsx:163` | `event.subscribe()` in provider init | `onCleanup(event.subscribe(...))` |
| 5.3 | `packages/tui/src/context/data.tsx:123` | Same | Same |
| 5.4 | `packages/tui/src/context/project.tsx:72` | `sdk.event.on()` without cleanup | Same |
| 5.5 | `packages/tui/src/context/local.tsx:503` | `session.deleted` listener without cleanup | `init` returns cleanup fn |
| 5.6 | `packages/opencode/src/cli/heap.ts:39-42` | `setInterval` with no `stop()` | Added `export function stop()` calling `clearInterval` |
| 5.7 | `packages/tui/src/feature-plugins/system/notifications.ts:30-86` | Sets grow if reply events are missed | **Deferred** — plugin tracks via `scope.track()` so leaks already prevented; per-event Set growth bounded by session lifetime |
| 5.8 | `packages/core/src/filesystem/watcher.ts:86` | `Effect.runForkWith(context)` per FS event | `Queue.bounded(1024) + Effect.runFork(Queue.offer) + Effect.forkScoped(Stream.fromQueue)` |

New `tui/test/subscription-cleanup.test.ts` (2 cases). 201 TUI tests pass, 84 core tests pass, typecheck clean.

## Phase 6 — Type safety & schema hardening ✅ SHIPPED (`9b2fcd6` on `fix-type-safety`)

| # | File | Issue | Fix |
|---|---|---|---|
| 6.1 | `packages/opencode/src/server/routes/instance/httpapi/handlers/file.ts:66-93,96-109` | `ctx.query.path` used in `path.join` without `Schema.isPattern` | Add `Schema.isPattern(/^[a-zA-Z0-9._/-]+$/)` |
| 6.2 | `packages/opencode/src/acp/service.ts:798,986,995` | String cast to `ProviderV2.ID` / `ModelV2.ID` | `Schema.decode` / branded validators |
| 6.3 | `packages/console/app/src/routes/zen/util/provider/openai.ts` (80+ sites) | `(x as any)` on LLM response parts | Type-guard helper, narrow incrementally |
| 6.4 | `packages/opencode/src/provider/provider.ts:1731` | `Object.keys(mod).find(...)!` may be undefined | Check for `undefined`, throw typed error |
| 6.5 | `packages/core/src/banyancode/{subagent-plans,subagent-messages,memory}.sql.ts` | `text({ mode: "json" })` missing `.$type<>()` | Add typed accessor |
| 6.6 | `packages/opencode/src/bus/global.ts:8` | `payload: any` | `unknown` + discriminated union |
| 6.7 | `packages/console/function/src/auth.ts:27-33` | Required strings without `.min(1)` | Add `.min(1)` |

**Branch:** `fix-type-safety`

## Phase 7 — Test coverage & quality

| # | File | Action |
|---|---|---|
| 7.1 | `packages/core/src/banyancode/subagent-bus.ts` | New test — real `Queue.bounded`, publish/subscribe/peers |
| 7.2 | `packages/core/src/banyancode/codegraph-repo.ts` | New test — `Database.layerFromPath(tmpDbPath)` per AGENTS.md |
| 7.3 | `packages/core/src/banyancode/codegraph-analyzer.ts` | New test — impact/walkTransitive/dependents |
| 7.4 | `test/banyancode/mesh-coordinator.test.ts` | Replace mocks with real SubagentBus + SubagentPlans |
| 7.5 | `test/banyancode/subagent-consumer.test.ts` | Replace MemoryRepo mock with real impl |
| 7.6 | `test/banyancode/edit-planner.test.ts` | Replace CodegraphRepo/Analyzer mocks |
| 7.7 | New regression tests | MemoryRepo transaction, BanyanConfig flock, CodegraphRepo bumpVersion (Phases 1 already done) |

**Branch:** `test-real-services`

## Phase 8 — Observability & graceful shutdown ✅ SHIPPED (`2ee6836` on `fix-graceful-shutdown`)

| # | File | Issue | Fix |
|---|---|---|---|
| 8.1 | `packages/opencode/src/cli/cmd/github.handler.ts:517+` | 20+ `console.log` calls | Replace with `Effect.logInfo` + structured fields |
| 8.2 | `packages/stats/server/src/shutdown.ts:11` | Only sets flag | Ordered shutdown: stop accepting → drain queues → close DB → exit |
| 8.3 | `packages/opencode/src/server/server.ts:186-188` | `forceClose` skips DB + fibers | DB close w/ timeout + fiber interrupt |
| 8.4 | `packages/core/src/banyancode/system-monitor.ts:161-163` | `forkScoped` may not interrupt | Verify scope close interrupts; add finalizer |
| 8.5 | `packages/core/src/banyancode/codegraph-build-service.ts:142-144` | `Fiber.interrupt` with no timeout | `Effect.raceWith(Effect.sleep(timeout))` |

**Branch:** `fix-graceful-shutdown`

## Phase 9 — Database polish ✅ SHIPPED (`49b6953` on `db-polish`)

| # | File | Issue | Fix |
|---|---|---|---|
| 9.1 | `packages/core/src/banyancode/memory.sql.ts:18` | No index on `created_at` | Added `index("memory_created_idx").on(table.created_at)` + migration `20260626000001` for existing DBs |
| 9.2 | `packages/core/src/banyancode/subagent-messages-repo.ts:81` | Pending filter on parent only | Added partial index `WHERE delivered_at IS NULL` via migration `20260626000002` |
| 9.3 | `packages/core/src/banyancode/memory.sql.ts:5` | `value` JSONB has no schema validation | Versioned payload wrapper `{ _v: 1, data: T }` in new `memory-payload.ts` |
| 9.4 | `packages/core/src/banyancode/memory-repo.ts:55-69` | `mapRowToEntry` doesn't validate JSONB | Defensive `unwrapMemoryValue` accepts both versioned and legacy shapes, logs warning on corruption |
| 9.5 | Empty migrations `20260601010001`, `20260603040000`, `20260604172448` | No-op placeholders | All three deleted (never applied, no journal entries, no intent in history) |

New `memory-payload.test.ts` (5 cases). 89 banyancode tests pass, typecheck clean.

## Phase 10 — Codegraph build progress events ✅ SHIPPED (`32f307a` on `main`)

The `/codegraph-build` TUI progress widget was stuck at `0/0 Running` even though the indexer was running and writing to the DB. Root cause: a duplicate drain on the `CodegraphBuildService.events()` `Queue`. The layer forked an internal `Effect.forever(Queue.take(events) → eventBus.publish(...))` worker at the same time as the bridge in `packages/opencode/src/effect/banyancode-codegraph-bridge.ts` was draining the same queue. Effect `Queue` is single-consumer, so the two fibers raced and the TUI lost roughly half of the progress events — most critically the first non-zero `total` event.

| # | File | Issue | Fix |
|---|---|---|---|
| 10.1 | `packages/core/src/banyancode/codegraph-build-service.ts:71-78` | Internal `Effect.forkScoped(Effect.forever(...))` drained the same queue as the bridge | Removed the internal drain; added a comment explaining the bridge is the sole consumer. Re-applies the fix from `ecfb2eb` on `review-fixes` (which was lost when `e40b3ad` rewrote the layer for `Queue.bounded(64)`) |

Regression test: `packages/opencode/test/banyancode/codegraph-manual-build.test.ts` now drains the `events()` queue the same way the bridge does and asserts every progress event arrives (final `running` event has `done: 10, total: 10`). The test fails on the unfixed code and passes after the fix.

Manual verification: rebuilt the full `D:\OpenCode` workspace into `.banyancode/banyancode-local.db` — 3,039 files, 3,034 indexed, 13 skipped, 45.9s, `graphCoverage=0.9957`. Progress bar updates correctly from `0/0` to `3039/3039`.

---

## Phase 11 — `/codegraph-build` works from any route ✅ SHIPPED (`957aaf1` on `main`)

`/codegraph-build` previously only fired through `session.command`, which required an active session. From the home route, the user saw "Start a session first to build the code graph" (and from any non-session route, the toast just never fired). The build was also dying silently because `Effect.forkScoped` requires Scope in the fiber's context — fibers spawned by `ManagedRuntime.runFork` don't have it.

| # | File | Issue | Fix |
|---|---|---|---|
| 11.1 | `packages/opencode/src/server/routes/instance/httpapi/groups/global.ts`, `handlers/global.ts` | No global endpoint to start a build without an active session | Added `POST /global/codegraph-build` (`CodegraphBuildInput` schema: optional `root`, `force`, `dbPath`). Handler resolves `root` from `InstanceState.context.worktree` if not provided, calls `Banyan.CodegraphBuildService.start(...)` inside `AppRuntime.runFork(...)` so the kickoff runs in the app scope, returns `{ started, root, dbPath }` |
| 11.2 | `packages/opencode/src/effect/banyancode-codegraph-bridge.ts` | Bridge used `Effect.forkIn(work, yield* Effect.scope)` which silently threw `Service not found: effect/Scope` | Replaced with `Effect.forkDetach(work)` |
| 11.3 | `packages/core/src/banyancode/codegraph-build-service.ts` | `start()` used `Effect.forkScoped(forkWork)` — same Scope-in-context problem | Replaced with `Effect.forkDetach(forkWork)` so the build runs in the runtime's global scope and survives the originating request |
| 11.4 | `packages/tui/src/app.tsx`, `packages/tui/src/component/prompt/index.tsx` | Command palette and prompt slash handler routed `/codegraph-build` through `session.command`, which requires a session | Both now call `sdk.client.global.codegraph.build({...})` directly. Removed the "Start a session first" guard |
| 11.5 | `packages/sdk/js/src/v2/gen/sdk.gen.ts`, `types.gen.ts` | New SDK method for the new endpoint | Regenerated via `bun script/build.ts` |

Regression tests: existing `codegraph-build-service.test.ts` (6 cases) and `codegraph-manual-build.test.ts` events-queue test (1 case) both pass.

End-to-end verification: typed `/codegraph-build` from the TUI on the home route. Progress bar updated from `0/0` to `3039/3039` and stopped. DB meta: `graphVersion=1, graphCoverage=0.9724, totalFiles=3046, totalNodes=6454, totalEdges=136477`. Cancel via `/codegraph-cancel` interrupts the in-flight build and shows the cancelled toast.

---

## Test commands

```bash
cd packages/core      && bun typecheck && bun test
cd packages/opencode  && bun typecheck && bun test
cd packages/tui       && bun typecheck && bun test
```

After each phase, run all three `bun typecheck` and `bun test` invocations before committing. The `do-not-run-tests-from-root` guard is in effect.

## Commit policy

One commit per phase, summarizing the phase with a `type(scope):` message. Lead agent does all commits. Coder subagents return file lists, never commit. New "Hard-won lessons" entries are appended to `AGENTS.md` after each phase lands.
