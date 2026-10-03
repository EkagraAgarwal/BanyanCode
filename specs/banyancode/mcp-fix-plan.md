# MCP + perf follow-up: fix plan

Date: 2026-10-03. Base: `dev` @ `027a92758f` (published as `banyancode@26.10.1-dev.027a927`).
Replaces the earlier MCP/perf plans, which have been deleted.

Each issue below was reproduced on `dev`, and its root cause is pinned to file:line. Items are ordered by severity. Fix each one in its own commit (`type(scope): summary`).

---

## F1. `/global/code-find`, `/preflight`, `/blast-radius`, `/safe-rename` return 500 for every client (P0)

**Repro.** `POST /global/code-find` returns `UnknownError`, logged as `Service not found: @opencode/v2/Banyan/CodegraphRepo`. This breaks the MCP tools `banyan_code_find` and `banyan_change_check`, and any HTTP caller. Present since 26.10.1. Earlier, a schema error stopped requests before they reached this point.

**Root cause.** In `packages/opencode/src/server/routes/instance/httpapi/server.ts` `createRoutes()`:
- `Banyan.codegraphAnalyzerDefaultLayer` is used only via `Layer.provide` (lines 286 and 292), so the handlers never see it.
- `Banyan.codegraphRepoDefaultLayer` is used only via `Layer.provide` (line 310), so the handlers never see it.

The handlers in `handlers/global.ts:872-925` need `Banyan.CodegraphRepo` and `Banyan.CodegraphAnalyzer` directly. `CodegraphReadiness`, `RepositoryIntelligence`, `EditPlanner` and `PermissionV2` are already exported. `AppLayer` does this correctly (`effect/app-runtime.ts:142,144`).

**Fix.** In `createRoutes()`, export both services to the handler context. Add, after the `Layer.provideMerge(Layer.mergeAll(Banyan.repositoryIntelligenceDefaultLayer, …))` block:
```ts
Layer.provideMerge(Banyan.codegraphAnalyzerDefaultLayer),
Layer.provideMerge(Banyan.codegraphRepoDefaultLayer.pipe(Layer.provide(Database.defaultLayer))),
```
Same layer objects means the shared memoMap dedupes them, so no second instance is created. Order matters: a later `provideMerge` provides to everything before it. If `codegraphAnalyzerDefaultLayer` needs `CodegraphRepo`, place the repo line after the analyzer line, as shown.

**Test.** New file `packages/opencode/test/server/httpapi-codegraph-routes.test.ts`. Use the real composition via `Server.Default().app.request(...)` (pattern: `test/server/httpapi-config.test.ts`), not hand-built layers. For each of `/global/code-find`, `/global/preflight` and `/global/blast-radius`, POST a valid body and assert the status is **not 500** and the body is not `UnknownError`. A 200 with empty results, or a typed 4xx, is acceptable on an empty tmp project.

## F2. Event-log compaction is never run (P0)

**Repro.** `compactSnapshots` (`packages/core/src/event/compaction.ts:131`) has no production caller; only tests call it. The stable DB's `event` table grew from 1.84 GB to 3.07 GB in one day.

**Fix.**
1. Add `runEventCompaction(db)` maintenance. Call `compactSnapshots(db)` with the default config (batched DELETEs, horizon-protected) and log the `CompactionReport` via `Effect.logInfo`, **never to stderr**.
2. Run it in the background, never on the open/startup path. In `packages/opencode/src/effect/app-runtime.ts`, next to the other `AppRuntime.runFork(...)` bridges (~line 320), fork one maintenance fiber:
   - wait 30 s after start;
   - run backfill (F3), then compaction, then the existing bounded `runStartupMaintenance` (incremental_vacuum);
   - repeat every 6 h;
   - catch and log all failures with `Effect.catchCause`.
3. Cross-process guard: before running, read a `migration`-table marker `maintenance:last_run` and skip if it is less than 6 h old; write it after the run. Keep it a single row, `INSERT … ON CONFLICT DO UPDATE`.
4. Opt-out: `BANYANCODE_DB_MAINTENANCE=0` (already honored by `runStartupMaintenance`) disables the whole fiber. Set it in `packages/opencode/test/preload.ts`.

**Test.** `packages/core/test/event/compaction-scheduling.test.ts`: seed a tmp DB with more than `maxRowsPerAggregateType` superseded `message.updated.1` rows for one session, run the maintenance effect once, and assert that the rows deleted are > 0, the latest row per entity is kept, and the marker is written. A second immediate run is a no-op.

## F3. Startup blocks for minutes on large DBs (P0)

**Repro.** First open of the user's 1.65 GB `-dev` DB took 56 s, and the 3.8 GB stable DB will take several minutes. Cause, in `packages/core/src/database/database.ts` `open()`:
- line 48: `DatabaseMigration.apply(db)` runs `applyCodeBackfills` (`packages/core/src/database/migration.ts:22,35-49`, the multi-GB patch-body rewrite) synchronously.
- lines 58-65: then a **full `VACUUM`** whenever `freelist_count > 5000`.

Both run before the server can answer, and `process.stderr.write` at line 61 garbles the TUI. This also contradicts the comment at `compaction.ts:32-35,357-362` ("never a full VACUUM here").

**Fix.**
1. `migration.ts`: remove `applyCodeBackfills(db)` from `apply()`. Export it as `applyCodeBackfills` so the F2 maintenance fiber calls it first. It is already idempotent, batched and marker-guarded. New writes are already counts-only (Q0), so running it later is safe.
2. `database.ts:52-65`: delete the freelist-triggered full `VACUUM` and its `stderr` write. Keep `wal_checkpoint(TRUNCATE)` and `runStartupMaintenance`.
3. Full VACUUM becomes explicit only. Add `banyancode db compact` (new file `packages/opencode/src/cli/cmd/db-compact.ts`, registered beside `DbGcCommand` in `db.ts`). It:
   - runs backfill + compaction;
   - then runs `VACUUM`, printing before/after size;
   - refuses with a clear message if another BanyanCode process holds the DB: try `BEGIN IMMEDIATE` with a short busy_timeout, and on failure tell the user to close other sessions.

**Test.** Extend `packages/core/test/database/*` (or create `database-open-fast.test.ts`): opening a DB with a large freelist and an unapplied backfill marker must **not** run VACUUM or the backfill. Assert the marker is still absent after `open`, and that open completes in under 2 s on the fixture.

## F4. `banyan_task_status` / `banyan_task_result` omit the failure reason (P1)

**Repro.** A task with an unknown model reaches `status: "failed"`, but the status and result payloads have no reason. Only `notifications/tasks.statusMessage` carries it.

**Root cause.** `statusView` (`packages/opencode/src/mcp-server/tools-task.ts:264-289`) copies `record.errorCode` but not `record.error`. The engine sets `error` on `session.error` (`task-engine.ts:955`) and on budget abort (`:1067`).

**Fix.**
- Add `error?: string` to `StatusView` and its zod output schema, and set `if (record.error !== undefined) view.error = record.error`.
- In the `banyan_task_result` handler, include `error` in the compact result when `status === "failed"`, and in `result.ts`'s result type. Cap it at 2,000 chars.

**Test.** `test/mcp-server/tools-task.test.ts`: after a `session.error` event, `banyan_task_status` and `banyan_task_result` both contain the error text.

## F5. `banyancode db gc --yes` never deletes (P1)

**Root cause.** `packages/opencode/src/cli/cmd/db-gc.ts:206` deletes only when `args.yes && !args["dry-run"]`, but `--dry-run` defaults to `true` (line 181). The help text says `--yes` overrides; the code does not.

**Fix.**
- Remove the `default: true` from `dry-run`.
- Condition: `const dryRun = args["dry-run"] === true || !args.yes`.
- Hint text at line 208: ``Re-run with `--yes` to delete the orphans above.``

**Test.** Add to the existing db-gc test (or create `test/cli/db-gc.test.ts`), using `tmpdir()` with fake orphan files:
- `--yes` deletes;
- no flags deletes nothing;
- `--yes --dry-run` deletes nothing;
- current-worktree DBs are never deleted.

## F6. Stale tests that fail on `dev` and on 26.10.1 (P2, tests only, no product change)

| Test | Cause | Fix |
|---|---|---|
| `test/tool/task.test.ts` (14 failures) | Uses subagent `"general"`, removed in `81eb89c0cf` | Replace `"general"` with `"coder"` (18 occurrences); keep assertions |
| `test/tool/parameters.test.ts` › JSON Schema › task | Snapshot predates the intentional `plan` field | `bun test test/tool/parameters.test.ts -u`, then review that the only diff is `plan` |
| `test/tool/read.test.ts` › env file permissions (8 failures) | `.env` reads are intentionally auto-allowed for all agents since `2ecb67212f` (`src/agent/agent.ts:190-195`) | Flip the expectations for `.env`, `.env.local`, `.env.production` and `.env.development.local` to `asks=false`, with a comment citing `2ecb67212f`. **Do not change agent policy.** |
| `test/tool/external-directory.test.ts` › "normalizes Windows path variants to one glob"; `test/tool/read.test.ts` › "normalizes read permission paths on Windows" | Environment-dependent: the test strips the drive letter, and Windows resolves drive-less paths against the **cwd's drive** (`D:` repo vs `C:` temp) | In both tests, early-return or `skipIf` when `path.parse(process.cwd()).root.toLowerCase() !== path.parse(outerTmp).root.toLowerCase()`, with a comment explaining why |

## F1b. `/preflight` and `/blast-radius` still 500 after F1: permission bridge (P0, DONE by lead)

**Root cause.** `PermissionBridge.assert`/`ask` (`packages/opencode/src/effect/permission-bridge.ts:64-71,82-89`) exempt read-only actions like `code_find`. `preflight` and `blast_radius` weren't exempted, so they reach `v1.ask`, which needs an `InstanceRef` that `/global/*` routes don't have (`permission-bridge.ts:73`).

**Fix (applied).** Add `input.action === "preflight"` and `input.action === "blast_radius"` to both exemption lists. Both are read-only graph queries, so this matches the `code_find` treatment. Owner-approved.

**Test.** Extend `test/server/httpapi-codegraph-routes.test.ts` so `/global/preflight` and `/global/blast-radius` both return non-500.

## F7. `code_find` from a folder outside any project indexes the user's home directory and hangs (P0)

**Repro.** Start `serve` (or `mcp serve`) with cwd = a fresh `%TEMP%\tmp.*` folder that has no `.git` or `package.json`, then `POST /global/code-find`. The request never returns, the server burns about 1.5 cores, and `/global/health` times out. The same thing happens in `test/mcp-server/stdio-e2e.test.ts`.

**Root cause (two parts).**
1. `findRepoRoot` (`packages/core/src/banyancode/workspace-identity.ts:108-130`): the second loop walks up looking for `package.json` and stops at `C:\Users\<user>\package.json`. `resolveEffectiveRoot` (`:132-157`) then returns the **home directory** as the workspace root. `packages/core/src/tool/preflight.ts:125` has a duplicate `findRepoRoot` with the same flaw.
2. `code_find`'s `ensureGraphReady` (`packages/core/src/tool/code-find.ts:115-126`) does `yield* deps.readiness.ensureReady(...)` with no time limit. `ensureReady` (`codegraph-readiness.ts:237-289`) awaits a synchronous full build, so the HTTP request blocks for the whole index.

**Fix.**
1. `workspace-identity.ts`:
   - `findRepoRoot` stops walking at `os.homedir()` (compare case-insensitively on win32 after `resolve`). It never returns the home directory or any ancestor of it, in either loop.
   - `resolveEffectiveRoot` returns `invalid("workspace root '<p>' is the user home directory; open a project directory instead")` when the resolved root equals `os.homedir()`.
   - Export `findRepoRoot`.
2. `preflight.ts`: delete the local `findRepoRoot` (`:125`) and use the exported one (`:265`).
3. Bound the readiness wait in `code-find.ts` `ensureGraphReady`, and in the equivalent spots in `blast-radius.ts:~220` and `preflight.ts:~521` if they await `ensureReady`:
   - Wrap with `Effect.timeoutOption("10 seconds")`.
   - On timeout, return `{ reason: "failed", autoBuilt: true, error: "codegraph build in progress for <root>; results may be incomplete — retry shortly" }`. The build keeps running in its `forkDetach`ed fiber.
   - Make the constant overridable by `BANYANCODE_CODEGRAPH_READY_WAIT_MS`.
4. Revert the `package.json` writes the previous worker added to `test/mcp-server/stdio-e2e.test.ts`, unless they're still needed after this fix.

**Tests.**
- `packages/core/test/banyancode/workspace-identity-home.test.ts`: with `os.homedir()` pointed at a tmp "home" containing `package.json`, and cwd a subfolder with no markers, `resolveEffectiveRoot` must **not** return home. Use an injectable home parameter, not mocks.
- `code_find` against a slow or unbuilt root returns within about `BANYANCODE_CODEGRAPH_READY_WAIT_MS` plus a margin.
- `test/mcp-server/stdio-e2e.test.ts` passes.

## Out of scope (verified not bugs)
- `banyan_task_start` with the Tasks extension already returns `resultType: "task"`. An earlier report said otherwise, but its output was truncated.
- The 40 core codegraph failures and the TUI `SIGHUP` failure seen in the full runs were load/timeouts from running three suites concurrently. They pass in isolation.

## Verification gate (lead agent, before publishing)
1. `bun typecheck` in `packages/core` and `packages/opencode` (or `bunx turbo typecheck --force` from the root) is green.
2. Run from the package dirs, **one suite at a time**:
   - `packages/opencode`: `bun test test/mcp-server test/server/httpapi-codegraph-routes.test.ts test/tool/task.test.ts test/tool/parameters.test.ts test/tool/read.test.ts test/tool/external-directory.test.ts`
   - the new db-gc test
   - `packages/core`: `bun test test/event test/database`
3. Live check from `packages/opencode`: `bun run src/index.ts mcp serve --cwd D:/OpenCode` over stdio. `banyan_code_find {intent:"definition", target:"createMcpServer"}` returns results, not `UPSTREAM_ERROR`.
4. Publish: commit on `dev`, then `git push origin dev`. The pre-push hook typechecks, and `publish.yml` auto-publishes `banyancode@<ver>-dev.<sha7>`. Confirm with `npm view banyancode dist-tags` and `gh run list --repo EkagraAgarwal/BanyanCode --workflow publish.yml --limit 1`.
