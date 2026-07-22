# Repository Intelligence — Follow-up Remediation Plan

This plan captures the verified gaps, latent regressions, and one user-reported uninstall bug discovered after the five-PR remediation pass. It does not re-derive work that is already complete; it sequences the remaining fixes into three deliverable PRs.

## Status of the Prior PRs (Verified)

| PR | Phase | Verdict |
|---|---|---|
| PR 1 | Phase 0 + 1 | Complete. `outside-focus-dirs` diagnostic wired, batched `filesByIDs`, focus-dirs normalization, scope-selection contract enforced. |
| PR 2 | Phase 3 + 4 | Substantially complete. BFS primitive (`bfs.ts`), frontier batching, de-dup, maxDepth boundary, evidence-based test discovery. **Two follow-up bugs remain** (see Follow-up A). |
| PR 3 | Phase 2 | Partially complete. SQL `codegraph_node_name_idx` migration exists but is **not registered**; `search.ts` per-mode functions still call `listAllNodes` (only the combined cascade uses the bounded candidate set); BM25 → FTS5 routing deferred (see Follow-up B). |
| PR 4 | Phase 5 | Substantially complete. 129-file deadlock fixed, grammar cache, TREE_CACHE_CAP with FIFO eviction, `removeFiles` drops cached trees. **Two follow-up bugs remain** (see Follow-up A). |
| PR 5 | Phase 6 | Mostly complete. Dead stub deleted, duplicate layer removed, `/global/codegraph-remove` HTTP route wired. **Three follow-up gaps remain** (see Follow-up C). |

Test baseline: `bun typecheck` clean in `packages/core` and `packages/opencode`. `bun test test/banyancode/` in `packages/core` reports `625 pass / 2 skip / 2 fail`; both failures (`BanyanConfigService.updateAgentPrompt`) are pre-existing and reproduce on a clean tree. The new phase tests (`phase1-`, `phase3-`, `phase5-`) all pass.

## Non-Goals

- Do not re-derive the BFS primitive or the indexer concurrency fix; only fix the bugs called out below.
- Do not re-key the entire `RepositoryIntelligence.Service` interface; only patch the surface that blocks an acceptance criterion.
- Do not unify regex + tree-sitter parsing paths in this work; that is a separate tree-sitter migration tracked outside this plan.
- Do not address the pre-existing `BanyanConfigService.updateAgentPrompt` flake or the pre-existing `codegraph-manual-build.test.ts` "events queue" regression; both reproduce on a clean tree and require their own investigation.

## Confirmed Gaps

### A. Audit findings from the four parallel reviews (PR 2 / PR 4 surface area)

| ID | File:Line | Severity | Issue |
|---|---|---|---|
| A1 | `repository-intelligence/layer.ts:826-849` | HIGH | `impact(path)` resolves the file but then calls `findEntrypoints({ feature: file.path.split("/").pop() })` which does filename-substring matching. Spec Phase 4 #5 explicitly requires file-first graph traversal. |
| A2 | `repository-intelligence/layer.ts:617-628` | MEDIUM | `query()` builds graph edges by looping over `symbols + relatedNodes` and calling `edgesFrom` / `edgesTo` per node — the exact N+1 the BFS primitive was added to avoid. |
| A3 | `repository-intelligence/layer.ts:895-897` | MEDIUM | `trace()` loops over `fileIDs` and calls `getFile(id)` per file. `filesByIDs` exists. |
| A4 | `codegraph-indexer.ts:1065` (indexFiles entry) | HIGH | `indexFiles` does not reset the `cancelled` ref on entry; a follow-up `indexFiles` after a prior `cancel()` sees `cancelled === true` immediately and indexes nothing. |
| A5 | `codegraph-indexer.ts:1180-1206` | MEDIUM | Drain fiber orphaned on producer-side exception: if any parse fiber throws outside the local `catchCause`, `Effect.all` propagates and `Queue.shutdown` is never called, leaking the drain fiber. |
| A6 | `codegraph-indexer.ts:155-166` | LOW | `pruneTreeCache` evicts in insertion order (FIFO), not LRU. Spec only requires a cap so this is compliant, but the comment at `bfs.ts:6-7` and the `tree-sitter` cleanup are sloppy. |
| A7 | `repository-intelligence/bfs.ts:6-7` | LOW | Comment claims "head-index queue" but the implementation uses frontier-swap (correct, but the comment misleads readers). |
| A8 | `langs/query-executor.ts:1` | LOW | `Layer, Ref` imported but unused (Phase 5 diff artifact). |
| A9 | `repository-intelligence/layer.ts` slice / relationships / tests | MEDIUM | Spec Phase 2 #6 — `query.limit` is not consistently bound on `relationships`, `tests`, `docs`, `configs`. Only `slice()` and `trace()` cap output. SDK callers can receive unbounded arrays. |
| A10 | `search/search.ts:309-348` | MEDIUM | Per-mode functions (`searchExact`, `searchPrefix`, `searchCamelCase`, `searchSnakeCase`, `searchQualified`, `searchFuzzy`) still call `listAllNodes()`. Only the combined cascade (`searchAuto` / `mode: "auto"`) goes through `searchNodesLight`. Per-mode SDK consumers bypass the bounded candidate set. |

### B. Audit findings on the SQL/FTS pushdown

| ID | File:Line | Severity | Issue |
|---|---|---|---|
| B1 | `database/migration/20260719000000_codegraph_node_name_idx.ts` + `database/migration.gen.ts:1-20` | BLOCKER | The migration file exists in `src/database/migration/` but is **not imported** by `migration.gen.ts`. Existing `banyancode.db` instances do not gain the new `codegraph_node_name_idx`; only fresh DBs pick it up via `codegraph.sql.ts:34`. |
| B2 | `search/search.ts:339-348` (`searchBM25`) | MEDIUM | The Phase 2 comment defers FTS5 routing because `repo.putNode` (UPSERT) does not fire the FTS5 `codegraph_fts_insert` trigger. The trigger should also fire on UPDATE (or `rebuildFtsIndex` should run at seed time). |
| B3 | `codegraph-repo.ts:1040-1086` `writeFileGraph` | LOW | Service-tag inserts loop over `serviceTagEntries` with one upsert per entry inside a transaction; should batch into one multi-row upsert. |

### C. Audit findings on the cleanup + HTTP route work

| ID | File:Line | Severity | Issue |
|---|---|---|---|
| C1 | `global.ts:350-360` + `sdk/js/src/v2/gen/sdk.gen.ts` | BLOCKER | `/global/codegraph-remove` is wired but `GlobalCodegraphRemove` / `GlobalCodegraphRemoveResponses` are absent from the generated SDK. AGENTS.md "Endpoints that depend on new services" step 3 is violated. |
| C2 | `command/index.ts:201-225`, `app.tsx:874-895`, `prompt/index.tsx:1214-1220` | MEDIUM | TUI slash command + command palette + prompt input still call `session.command` (legacy LLM-driven path), not `sdk.client.global.codegraph.remove`. The "now wired" ARCHITECTURE.md claim is misleading until the consumers migrate. |
| C3 | `codegraph-repo.ts:725-743` `clearAll` | HIGH | `dropFile:true` unlinks the DB file while `Banyan.CodegraphRepo.defaultLayer` still holds an open `better-sqlite3` / Drizzle connection. On POSIX the inode stays alive until the FD closes; on Windows `EBUSY` is swallowed and the operation silently no-ops. Future writes go to the unlinked inode or a phantom file. |
| C4 | `tests/` | MEDIUM | No HTTP-layer test for `POST /global/codegraph-remove`. Pattern to follow: `mesh-status-http.test.ts`. |
| C5 | `global.ts:350-360` | LOW | Endpoint declares no `error: HttpApiError.*` so failures (e.g., BanyanCode disabled) defect instead of returning 503. |
| C6 | `codegraph-repo.ts:697-702` `clearAll` | LOW | Hard-codes six tables; a new `codegraph_*` table added later could leak rows on remove. |

### D. User-reported uninstall regression (new)

The user's transcript shows:

```
$ bun install banyancode        → installs banyancode@26.7.6 (bun-managed binary in ~/.bun/...)
$ banyancode -v                  → 26.7.6
$ banyancode uninstall           → detects method=curl (because $PATH resolves to ~/.banyancode/bin/banyancode)
                                   removes ~/.local/share/banyancode, ~/.cache/banyancode,
                                   ~/.config/banyancode, ~/.local/state/banyancode
                                   prints "To finish removing the binary, run: rm ~/.banyancode/bin/banyancode"
                                   does NOT execute that rm
$ banyancode -v                  → 26.07.5  (the bun-installed copy is still on PATH and unaffected)
$ npm uninstall banyancode       → removed 5 packages (npm-side cleanup only)
$ banyancode -v                  → 26.07.5  (still there)
$ opencode -v                    → command not found
```

The user's hypothesis was "uninstall is uninstalling opencode". The actual root causes are different:

| ID | File:Line | Severity | Issue |
|---|---|---|---|
| D1 | `cli/cmd/uninstall.ts:212-219` | HIGH | The curl-method uninstall path does not actually remove the binary — it only prints the `rm` command and stops. The summary spinner at line 123 reports `✓ Binary: ~/.banyancode/bin/banyancode` which implies the binary was removed when it was not. UX bug, not a security bug (the user can run the printed command), but the spinner is misleading. |
| D2 | `installation/index.ts:189` + `cli/cmd/uninstall.ts:90-101` | HIGH | `Installation.method()` only inspects `process.execPath`. When the user has **multiple installs** (e.g., bun + curl, npm + curl, or three methods at once), `uninstall` only cleans the one whose path `process.execPath` matches. The other binaries are never detected or removed. The user's bun-managed copy survived because `process.execPath` pointed at the curl path. |
| D3 | `cli/cmd/upgrade.ts:48-50` | MEDIUM | `banyancode upgrade` says "26.07.5 is already installed" — but the user just installed 26.7.6 via bun. The `target` being compared is the local binary's `InstallationVersion`, not the latest published version on the relevant channel. The user-visible message conflates "I am 26.07.5" with "26.07.5 is the latest". |
| D4 | `cli/cmd/uninstall.ts:181-210` | MEDIUM | Only one package manager is invoked (e.g. `bun remove -g banyancode`). The command trusts `Installation.method()` as the source of truth and does not probe PATH for additional installs. A user who installed via both bun and npm will see one succeed and the other silent-leak. |
| D5 | (no file) | MEDIUM | The uninstall handler does not probe the npm / pnpm / yarn / bun global `node_modules/.bin/banyancode` paths or the snap / brew prefixes before declaring success. The user's `bun install` placed a binary at `~/.bun/install/global/node_modules/.bin/banyancode` that was never enumerated. |
| D6 | `cli/cmd/uninstall.ts:99` | LOW | `binary = method === "curl" ? process.execPath : null` — for the bun method, no `targets.binary` is collected, so the bun-managed binary is never even listed in the removal summary, let alone removed. |

The "opencode" confusion in the user's report is a symptom, not the cause: BanyanCode's CLI is named `banyancode` and never names `opencode` as a package; the user-facing product identity is correct. The real bug is **silent partial uninstall** — the spinner shows success while a parallel install path remains functional.

## Delivery Principles

1. Ship each finding behind a regression test that reproduces it on the current tree.
2. Preserve the public HTTP, CLI, SDK, and LLM-tool contracts. The `banyancode uninstall` UX must keep its existing flags (`--keep-config`, `--keep-data`, `--dry-run`, `--force`).
3. For unsafe filesystem operations, prefer explicit user-visible "Remaining installs:" output over silent best-effort cleanup.
4. Run `bun typecheck` and `bun test` after each PR from the relevant package directory.
5. Regenerate `packages/sdk/js` when an HTTP route or schema changes (`./packages/sdk/js/script/build.ts`).

## Phase A — Correctness fixes (PR A)

**Primary files:**
- `packages/core/src/banyancode/repository-intelligence/layer.ts`
- `packages/core/src/banyancode/repository-intelligence/bfs.ts`
- `packages/core/src/banyancode/codegraph-indexer.ts`
- `packages/core/src/banyancode/langs/query-executor.ts`

1. Replace `impact(path)`'s filename-substring match with a real graph traversal. After resolving the file, fetch `repo.listNodesByFile(file.id)`, then run `bfsPure` over those node IDs in `direction: "incoming"` with `CALLER_EDGE_KINDS` to get dependents, and `direction: "outgoing"` with `DEPENDENCY_EDGE_KINDS` for dependencies. Cap each side with `resultLimit` (default 25). Remove the call to `findEntrypoints`.
2. Replace `query()`'s per-symbol edge loop with `edgesFromBatch` + `edgesToBatch` against the joined `[...symbols, ...relatedNodes]` ID set, then partition by node in memory. Update existing tests that assert exact edge order if needed (the new order is `outgoing by fromNodeID, then incoming by toNodeID` — same as the previous per-node order).
3. Replace `trace()`'s per-file `getFile` loop with `filesByIDs`. Update `bfs.ts:6-7` comment to describe the frontier-swap pattern.
4. Fix `indexFiles` to reset `cancelled = false` on entry (`yield* Ref.set(cancelled, false)` at the same place `index()` already does this at line 859).
5. Guard `indexFiles`'s drain so it shuts down the queue even on producer-side exception: wrap the `Effect.all` in `Effect.ensuring(Queue.shutdown(parsedQueue))`. The same guard applies to `index()`'s drain if it is structurally similar — verify and apply.
6. Strip unused `Layer, Ref` imports in `langs/query-executor.ts:1`.
7. Add `resultLimit` to all `slice`-returning methods (`relationships`, `tests`, `docs`, `configs`) on the `query` boundary. Default = `input.limit ?? 25`. Surface truncation in `ArchitecturalSlice` via a new `truncated?: { files?: number; docs?: number; configs?: number; tests?: number; relationships?: number }`. Backward compatible — missing field means no truncation.
8. Add a regression test for A1 (impact by basename does not match unrelated file) and a 200-node fixture test that asserts per-depth query count is bounded.

**Acceptance:**
- `impact("packages/core/src/banyancode/indexer.ts")` returns graph-derived nodes from that file, not every file containing "indexer" in its basename.
- `trace({symbol: "x"})` and `query({query: "x"})` issue O(1) edge queries per depth, not O(N) per visited node.
- `indexFiles` after `cancel()` indexes files normally.
- Producer-side exceptions do not leak the drain fiber.

## Phase B — Search / SQL pushdown (PR B)

**Primary files:**
- `packages/core/src/banyancode/search/search.ts`
- `packages/core/src/banyancode/codegraph-repo.ts`
- `packages/core/src/database/migration/20260719000000_codegraph_node_name_idx.ts`
- `packages/core/src/database/migration.gen.ts`
- `packages/core/src/banyancode/codegraph.sql.ts`

1. Register the existing migration by adding `import("./migration/20260719000000_codegraph_node_name_idx")` to `migration.gen.ts:5-15`. Remove the duplicate DDL in `codegraph.sql.ts:34` (the `index("codegraph_node_name_idx").on(table.name)` declaration) — the migration is the single source of truth.
2. Fix the FTS5 trigger so it fires on UPSERT. Two viable paths:
   - (a) Adjust `codegraph_fts_update` to capture both `OLD` and `NEW` for `ON CONFLICT DO UPDATE`. SQLite `INSERT ... ON CONFLICT DO UPDATE` does fire the `UPDATE` trigger for the conflict side; verify the existing update trigger deletes the old row from `codegraph_fts` first then inserts the new one. Confirm with a regression test that `putNode` followed by `ftsSearchNodes` returns the row.
   - (b) If the trigger path is fragile, run `rebuildFtsIndex()` in the test fixture setup at `fixtures/tmpdir.ts` (or wherever the test DB is bootstrapped) so `ftsSearchNodes` is populated for `repo.putNode`-based tests.
   Land whichever path proves reliable. Then route `searchBM25` through `ftsSearchNodes` and remove the in-JS BM25 computation.
3. Route per-mode `searchExact` / `searchPrefix` / `searchCamelCase` / `searchSnakeCase` / `searchQualified` / `searchFuzzy` through `searchNodesLight` with a per-mode `limit` (`FUZZY_CANDIDATE_CAP = 1000` already exists). Document the per-mode contract: search modes never load every graph node; the combined cascade and per-mode functions share the same `limit` semantics.
4. Batch service-tag inserts in `writeFileGraph` (`codegraph-repo.ts:1040-1086`) into a single multi-row upsert when more than one entry is present.
5. Add a 1,000-node fixture test that asserts exact lookup is O(log N) (use the new `codegraph_node_name_idx`) — measured as a count of DB statements, not wall-clock.

**Acceptance:**
- Existing `banyancode.db` files gain the `codegraph_node_name_idx` on first open after upgrade.
- `repo.putNode` + `ftsSearchNodes` returns the inserted row.
- `searchExact("Foo")` issues at most one SQL query (plus result-fetch).
- A 1,000-node fixture's `searchExact` for a known name completes in < 50ms on a developer laptop.

## Phase C — HTTP route + SDK + uninstall (PR C)

**Primary files:**
- `packages/opencode/src/cli/cmd/uninstall.ts`
- `packages/opencode/src/installation/index.ts`
- `packages/opencode/src/server/routes/instance/httpapi/groups/global.ts`
- `packages/opencode/src/server/routes/instance/httpapi/handlers/global.ts`
- `packages/opencode/src/cli/upgrade.ts`
- `packages/opencode/src/command/index.ts`
- `packages/opencode/src/command/index.ts` TUI consumers (`app.tsx`, `prompt/index.tsx`)
- `packages/opencode/src/cli/cmd/codegraph.ts` (`codegraph remove`)
- `packages/sdk/js/src/v2/gen/sdk.gen.ts` (regenerated)
- `packages/core/src/banyancode/codegraph-repo.ts` (`clearAll`)
- `packages/core/test/banyancode/codegraph-remove.test.ts` (extend)

1. **SDK regeneration (BLOCKER for Phase 6 acceptance):** run `cd D:\OpenCode/packages/sdk/js && bun script/build.ts`, commit the regenerated `sdk.gen.ts` and `types.gen.ts`.
2. **`dropFile:true` safety:** refactor `Banyan.CodegraphRepo.clearAll` to not own the file lifecycle. Move the unlink to a separate `Banyan.DatabaseService.reset({ dropFile: boolean })` that:
   - Closes the running `Database.Service` scope.
   - Calls the row-delete transaction + `PRAGMA wal_checkpoint(TRUNCATE)` + `VACUUM`.
   - Unlinks `banyancode.db`, `banyancode.db-wal`, `banyancode.db-shm` from disk.
   - Rebuilds the layer with a fresh `layerFromPath` so subsequent writes go to the new file.
   Or, in the simpler "manual" path: in `codegraph-remove-http.test.ts`, when `dropFile: true` on Windows, assert `droppedFile: false` and emit a warning instead of silently claiming success.
3. **HTTP layer test:** add `packages/opencode/test/banyancode/codegraph-remove-http.test.ts` modeled on `mesh-status-http.test.ts`. Three assertions:
   - `POST /global/codegraph-remove { dropFile: false }` returns 200 with `droppedFile: false`, DB rows empty, DB file still on disk.
   - `POST /global/codegraph-remove { dropFile: true }` returns 200 with `droppedFile: true`, DB rows empty, DB file gone (POSIX) or `droppedFile: false` (Windows).
   - `POST /global/codegraph-remove { dropFile: "yes" }` returns 400 (Schema rejection).
4. **TUI migration to global endpoint:** replace `session.command` calls in `app.tsx:874-895` and `prompt/index.tsx:1214-1220` with `sdk.client.global.codegraph.remove({ dropFile: false })`. Drop the `if (route.data.type !== "session")` guard so the command works without an active session. Remove the redundant `CODEGRAPH_REMOVE` server command at `command/index.ts:201-225`.
5. **Endpoint error contract:** add `error: HttpApiError.ServiceUnavailable` to the `codegraphRemove` endpoint declaration. Wrap the handler in `Effect.serviceOption(Banyan.CodegraphRepo)` to fail cleanly when BanyanCode is disabled, matching the pattern at `handlers/global.ts:241-255` for `codegraphCancel`.
6. **`clearAll` schema maintenance:** replace the hard-coded table list at `codegraph-repo.ts:697-702` with `Object.values(Codegraph*Table)` derived from the schema, so any future `codegraph_*` table is picked up automatically.

**Acceptance:**
- SDK consumers can call `sdk.client.global.codegraph.remove({ dropFile: false })` with typed payload.
- `dropFile: true` does not silently no-op on Windows.
- `/codegraph-remove` slash command works in a workspace with no active session.
- Removing a table in the schema does not orphan rows on `clearAll`.

## Phase D — Uninstall regression (PR D)

**Primary files:**
- `packages/opencode/src/cli/cmd/uninstall.ts`
- `packages/opencode/src/installation/index.ts`
- `packages/opencode/src/cli/upgrade.ts`
- New helper: `packages/opencode/src/installation/probe.ts`

This phase addresses the user-reported "uninstall might be uninstalling opencode instead of banyancode" finding (D1–D6). The plan is to convert uninstall from a single-method best-effort into a multi-install scanner that detects and removes every `banyancode` install it can find on disk and via package managers, with an honest summary of what was and was not removed.

1. **New `installation/probe.ts`** — multi-method probe. Probes each known install location and returns every detected install with its method, version, and path:
   - **Curl installs:** scan `~/.banyancode/bin/banyancode`, `~/.local/bin/banyancode`, `/usr/local/bin/banyancode`, plus any path returned by `which -a banyancode` that resolves into `~/.banyancode/`.
   - **Bun installs:** scan `~/.bun/install/global/node_modules/.bin/banyancode` and the symlink chain back to the package directory. Optionally run `bun pm ls -g` and parse the output.
   - **npm installs:** scan `npm root -g` for `node_modules/banyancode`; read its `package.json` `version`.
   - **pnpm installs:** `pnpm root -g` then `node_modules/banyancode/package.json`.
   - **yarn / corepack:** `yarn global dir` then `node_modules/banyancode/package.json`.
   - **Homebrew / choco / scoop / snap:** existing `Installation.method()` covers these. Combine results.
2. **Refactor `cli/cmd/uninstall.ts`:**
   - Replace `const method = await Installation.method()` with `const installs = await Probe.findAll()`.
   - The new `executeUninstall` iterates `installs` and removes each in turn:
     - For curl installs, **actually execute** `rm "$binaryPath"` (drop the "print but don't run" pattern at line 215). Wrap in a try/catch so the loop continues on a single failure.
     - For package-manager installs, invoke the matching `remove -g banyancode` command. Run all of them (not just one) since the user may have multiple.
     - Always remove the data dirs (`~/.local/share/banyancode`, `~/.cache/banyancode`, `~/.config/banyancode`, `~/.local/state/banyancode`) exactly once, after the binaries are gone.
   - Print a final summary that lists each detected install with its removal status: `✓ Removed ~/.bun/install/.../banyancode (bun, v26.7.6)`, `✓ Removed ~/.banyancode/bin/banyancode (curl, v26.07.5)`, `⚠ Skipped /usr/local/bin/banyancode — owned by another package manager (apt)`. If `which -a banyancode` still resolves to anything after uninstall, print a `⚠ Remaining: /path/to/binary` warning.
3. **Remove the `process.execPath.includes(".banyancode")` shortcut** at `installation/index.ts:189`. `Installation.method()` should still detect the primary method for `upgrade` (which only targets one install), but `uninstall` should not rely on it.
4. **Fix `banyancode upgrade` message (D3):** change `upgrade.ts:48-50` so that the `target` is `latest published version on the channel`, not `local InstallationVersion`. The existing version-readout `▲ banyancode upgrade skipped: 26.07.5 is already installed` is misleading; rephrase to `▲ You are on 26.07.5; latest on this channel is also 26.07.5` or, when the local version is older, `▲ Upgrade available: 26.07.5 → 26.07.6`. Confirm with the network probe that the local version is actually equal to latest before declaring "skipped".
5. **Tests:** add `packages/opencode/test/cli/uninstall.test.ts` that:
   - Creates a temp directory with two fake `banyancode` binaries (a fake `~/.banyancode/bin/banyancode` and a fake `~/.bun/install/global/node_modules/.bin/banyancode`).
   - Creates the data dirs with sample files.
   - Invokes the uninstall flow (the probe + removal, mocked or with `process.execPath` redirected).
   - Asserts: both binaries removed, data dirs removed, summary lists both removals.
   - Asserts no `⚠ Remaining` warning is printed when both installs were removed cleanly.

**Acceptance:**
- After `banyancode uninstall`, `which -a banyancode` returns no matches on POSIX, or only paths the user explicitly chose to keep.
- The summary spinner never shows `✓ Binary: …` for a path that has not actually been removed.
- `banyancode upgrade` no longer falsely reports a stale local version as "already installed" when a newer published version is available.

## Regression Coverage

Add or extend tests for:
- `impact(path)` filename-substring does not match unrelated files (Phase A A1).
- `query()` / `trace()` issue O(1) DB queries per depth over a 100-node fixture (Phase A A2, A3).
- `indexFiles` after `cancel()` indexes files normally (Phase A A4).
- `indexFiles` with a producer exception still shuts down the queue (Phase A A5).
- `searchExact` per-mode uses the bounded candidate set (Phase B B1).
- `ftsSearchNodes` returns rows inserted via `repo.putNode` (Phase B B2).
- `/global/codegraph-remove` HTTP end-to-end (Phase C C4).
- TUI slash command works without an active session (Phase C C4).
- `clearAll` removes every `codegraph_*` table after a new table is added (Phase C C6).
- `uninstall` removes every detected install across `curl + bun + npm + pnpm` (Phase D D2, D5).
- `uninstall` summary is honest when a binary removal fails (Phase D D1).
- `upgrade` distinguishes "local version equals latest" from "newer available" (Phase D D3).

## Recommended Delivery

1. PR A: Phase A. Correctness fixes (impact, query/trace N+1, indexFiles reset + drain guard). Single PR; touches `layer.ts`, `bfs.ts`, `codegraph-indexer.ts`, `langs/query-executor.ts`. Run `bun typecheck` + targeted tests.
2. PR B: Phase B. SQL migration registration + FTS5 trigger fix + per-mode pushdown. Single PR; touches `migration.gen.ts`, `codegraph-repo.ts`, `search.ts`. Run `bun typecheck` + targeted tests.
3. PR C: Phase C. SDK regen + `dropFile:true` safety + HTTP test + TUI migration to `/global/codegraph-remove`. Single PR; touches `global.ts`, `handlers/global.ts`, `codegraph-repo.ts`, `clearAll`, plus SDK regen commit. Run `bun typecheck` + opencode test suite.
4. PR D: Phase D. Multi-method uninstall probe + honest summary + upgrade message fix. Single PR; introduces `installation/probe.ts`, refactors `cli/cmd/uninstall.ts`, fixes `cli/upgrade.ts`. Run `bun typecheck` + new `uninstall.test.ts` + CLI smoke test.

Order rationale: PR D is independent of the others but is user-visible and shipping-ready today; it can land in parallel with PRs A–C. PR C must land after PR D if PR D changes the `codegraph-remove` flow. PRs A and B are independent of each other.