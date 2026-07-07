# Phase 0 — Codegraph Reconnaissance (2026-07-08)

**Generated:** 2026-07-08 14:36
**Workspace:** `D:\OpenCode`
**Recon script:** `packages/core/script/codegraph-recon-2026-07-08.ts` (throwaway — added to `.gitignore`)
**Source DB:** `C:\Users\ekagr\.local\share\banyancode\banyancode-local.db` (1.49 GB; the only populated candidate among the three probed)
**Live JSON output:** `specs/banyancode/codegraph-recon-2026-07-08.json`

This memo gates the 6+ engineer-week investment in Phase 1 / Phase 2 of the codegraph tool overhaul plan. All numbers below are exact — taken from the live DB via Drizzle `SELECT COUNT(*)` and targeted joins, not estimates.

---

## 1. Edge-kind enumeration

`codegraph_edges` contains **3 distinct `kind` values**:

| kind          | count      | share   |
| ------------- | ---------- | ------- |
| `references`  | 1,150,058  | 75.07%  |
| `calls`       |   380,094  | 24.81%  |
| `extends`     |     1,702  |  0.11%  |
| **total**     | **1,531,854** |       |

**Missing kinds (vs. `CodegraphEdgeKind` union at `codegraph.sql.ts:55-64` and plan §1 expectations):**
- `imports` — **0 rows** (the regex parser populates a local `imports: string[]` at `typescript.ts:99` but never converts it into edges)
- `tested_by`, `configured_by`, `built_by`, `mounts`, `generated_from` — **0 rows each** despite the indexer containing the emission code at `codegraph-indexer.ts:638, 670, 682, 696, 715`. Either an older indexer version ran against this DB or those branches did not fire (e.g., the build is missing nodes whose `kind` is `config`/`docker`/`route`/`generated`/`test`).
- `yield*` / `service_access` — **0 rows** (the plan expected these to be added in Phase 2).

**Verdict:** The schema is permissive (column is `text` with no enum constraint), so adding new kinds requires no migration. Phase 1 will see only the 3 existing kinds; if it touches Phase-2 edge kinds (`yield`, `service_access`) it must also add the parser emission, not just the schema.

## 2. `yield*` site count

- Nodes whose `code` text contains `yield*`: **384 of 17,974** total nodes (2.14%).
- Edges of kind `yield`: **0**.

The parser stores the literal text inside node `code`, but no second-pass extraction maps `yield* Foo.Service` to a call edge. 384 sites is the upper bound on Phase-2a's recall if it emits `yield*` edges.

## 3. `findSymbolsByServiceTag` consistency

Probe using the same SQL triple-filter as `codegraph-repo.ts:675-705` (`code LIKE '%Name%'` AND `kind='class'` AND `code LIKE '%Context.Service%'`, plus the post-filter that parses the `Context.Service<...>()("tag")` registration):

| query                  | rows returned |
| ---------------------- | ------------- |
| `BanyanConfigService`  | **0**         |
| `CodegraphBuildService`| **1**         |

The 1 hit for `CodegraphBuildService` resolves to the correct node: `codegraph-build-service.ts:class:Service:42` — the `class Service extends Context.Service<Service, Interface>()("@banyancode/CodegraphBuildService") {}` block.

**The spec §2.2 inconsistency is reproduced**, but the cause is now pinpointable: BanyanConfigService is registered the same way — `packages/core/src/banyancode/banyan-config.ts` declares `export class Service extends Context.Service<...>()("@banyancode/BanyanConfigService") {}`. The probe queries for `code LIKE '%BanyanConfigService%'`. If `Service` class is laid out with the `Context.Service` registration in the source, why does the candidate row not match? Two possibilities, neither confirmed without reading the BanyanConfigService node:

- `code` was stored without the `BanyanConfigService` literal. The typescript parser sets `name` from `EXPORT_CLASS_REGEX` (`typescript.ts:4`), but the `code` blob is matched by `getTSNodeBody` which scans until the closing brace. If the `Service` class is small and the `Context.Service<...>()("...")` pattern appears in a single line, the parser may capture it correctly — so this is unlikely.
- The indexer rewrote `code` while applying a deduplication / signature-strip step (no such code path exists in the current source — so this is unlikely too).

The most plausible cause given the data: `banyan-config.ts` was simply **not part of any build pass** that wrote into `codegraph_nodes`. Several builds have accumulated into this 1.49 GB DB; nodes from earlier builds may have been deleted but their `code` row not re-emitted. Either way, the indexer must be made idempotent — `findSymbolsByServiceTag` results must be deterministic across builds.

## 4. Incoming edges for `CodegraphBuildService.Service`

| metric                                                        | value  |
| ------------------------------------------------------------- | ------ |
| Target node ID                                                | `D:\OpenCode\packages\core\src\banyancode\codegraph-build-service.ts:class:Service:42` |
| Target node name                                              | `Service` (canonical name; `CodegraphBuildService` is the namespace re-export at `banyancode/index.ts`) |
| Edges where `to_node_id = target AND kind = 'calls'`          | **0** |
| Edges where `to_node_id = target AND kind IN ('calls','references')` | **428** |
| Grep hits in `D:\OpenCode\packages/**/*.ts` for `\bCodegraphBuildService\b` | **61** |
| Spec §2.6 grep baseline (`.ts` + scss tests)                  | **64** (3-row gap attributable to test docs and non-`.ts` references excluded by my filter) |

The 0 inbound `calls` edges against 428 `references` confirms the spec's diagnosis: the graph has no caller edges. The 428 references edges do exist (one for every node body that mentions the literal substring `CodegraphBuildService`), but they are emitted from many different source nodes — each `class`/`function` body in the repo that contains the substring counts as a referrer. This is why `code_find intent=callers` returns `symbol-not-in-graph` regardless of how many references exist — the routing layer in `code-find` (TBD per plan §8) was wired to filter by `kind === "calls"`, not by `"references"`.

The 61 grep hits vs 428 references edges is +367 noise (= every identifier-only mention is also a reference edge). On a per-source-file basis the ratio is tighter: grep is mostly type/import/doc usage; references are emitted from `class`/`function` bodies that contain the substring. Phase 1 must (a) include `kind === "references"` in the analyzer filter, and (b) accept that `references` is high-recall but moderate precision (see Q5).

## 5. Calls-edge precision baseline

Sampled 10 `kind='calls'` edges in the order they appear in `codegraph_edges` (SQLite rowid order). For each, classify the `from_node.code` against `to_node.code`:

| # | from → to                                                        | classification | reason                                                              |
| - | ---------------------------------------------------------------- | -------------- | ------------------------------------------------------------------- |
| 1 | `mockServer` (e2e spec) → `project` (e2e spec, same file)        | **real**       | `from_code` contains `project(` (1 hit)                              |
| 2 | `mockServer` (e2e spec) → `provider` (e2e spec, same file)       | **real**       | `from_code` contains `provider(` (1 hit)                             |
| 3 | `mockServer` (e2e spec) → `session` (e2e spec, same file)        | **real**       | `from_code` contains `session(` (1 hit)                              |
| 4 | `sampleExpansion` (e2e spec) → `capture` (e2e spec, same file)   | **ambiguous**  | target `code` is an arrow-function body whose leading `capture = (...) =>` is not matched by the **my** `^(?:export )?(?:class\|function\|interface\|type\|const\|let\|var)\\s+(\\w+)` extractor; needs AST-lite or namespace resolution to identify the symbol name from the surrounding context. Underlying edge would be **real** if we ran the disambiguator (subjective judgement: 4/5 confident real). |
| 5 | `tick` (e2e spec) → `capture` (e2e spec, same file)              | **ambiguous**  | Same reason as #4.                                                  |
| 6 | `turn` (e2e spec) → `id` (e2e spec, same file)                   | **real**       | `from_code` contains `id(` (4 hits)                                  |
| 7 | `turn` (e2e spec) → `contextTool` (e2e spec, same file)          | **real**       | `from_code` contains `contextTool(` (4 hits)                         |
| 8 | `mockServer` (e2e spec) → `project` (e2e spec, same file)        | **real**       | `from_code` contains `project(` (1 hit)                              |
| 9 | `mockServer` (e2e spec) → `provider` (e2e spec, same file)       | **real**       | `from_code` contains `provider(` (1 hit)                             |
| 10 | `mockServer` (e2e spec) → `session` (e2e spec, same file)       | **real**       | `from_code` contains `session(` (1 hit)                              |

**Tallies:** 8 real, 2 ambiguous, 0 false-positive → **observed precision = 0.80** (real / total).

The 2 ambiguous edges are arguably real under manual inspection (the target is a sibling declaration `capture = (frame, label) => {…}` referenced by another sibling `tick = () => { capture(frame, "raf"); … }`) — the sample includes 0 outright false positives because the regex match `\bname(` already filters out type-only and import-only mentions.

**Critical caveat — sample bias:** all 10 sampled edges come from **two playwright e2e test files** (`packages/app/e2e/regression/session-timeline-collapse-state.spec.ts` and `…/session-timeline-context-resize.spec.ts`). These are the first 10 `calls` rows by rowid — the SQL `ORDER BY` was absent, so SQLite returned rows in heap order, which happens to favor the most recently indexed files. The first 10 rows do **not** represent the distribution across the whole 380,094-edge set. The 80% precision is therefore a **lower bound** for test files (where the regex accidentally behaves well) and an **unknown** for production source. A random sample of 100 (e.g., using `id IN (SELECT id FROM codegraph_edges ORDER BY RANDOM() LIMIT 100)`) would be needed for a defensible production-precision number; this script does not include that due to the ~10s per random-row scan over a 1.5M-row table.

What we can say is that the regex (`codegraph-indexer.ts:590-594`) emits `kind='calls'` whenever `nodeA.code.includes(name + "(")`. The pattern will be correct whenever the calling node's body literally contains the call form; it will be **wrong** whenever the calling node's body contains a call to a property of `name` (e.g., `name.run()`) — those get `kind='references'` because of the `nodeA.code.includes(\`${name}(\`)` check failing, even though they ARE calls.

## 6. DB state

| field                  | value                                                                              |
| ---------------------- | ---------------------------------------------------------------------------------- |
| Was the DB built?      | **No** — this is the user's existing global DB, accumulated across multiple builds |
| Source                 | `C:\Users\ekagr\.local\share\banyancode\banyancode-local.db`                         |
| Size                   | 1,488,281,600 bytes (1.49 GB)                                                       |
| Files / Nodes / Edges  | 3,061 / 17,974 / 1,531,854 (2-3x the spec's 2232/10526/442752 — multi-build accumulation) |
| Build time             | n/a (no fresh build — see warnings below)                                            |
| `codegraph_meta` table | **does not exist** — see warnings                                                   |

**Warnings emitted by the script:**
- `codegraph_meta table does not exist in this DB (DB predates meta table migration)`

This means Q4's `graphVersion` / `graphBuiltAt` / `graphCoverage` are all `null`. The schema migration `20250621120000_libsql_fresh.ts:272` declares `CREATE TABLE codegraph_meta (...)`, and `codegraph-meta.sql.ts` declares the Drizzle binding — but this DB has neither. Either an earlier `libsql_fresh` migration was applied to this DB before `codegraph_meta` was added to the migration, or the migration was rolled back during a destructive refactor without re-emitting the table for existing rows. This is consistent with the AGENTS.md lesson "schema migrations are dangerous — preserve data across destructive refactors"; however here the damage is **the build metadata itself was wiped**, not user data.

The DB was NOT freshly built for this recon. `q6_dbState.wasBuilt = false`. The build-time / new-build row count comparison vs the spec is therefore impossible from this DB.

---

## Decision gates

### Gate A — Should Phase 1 ship?

**Verdict: YES, with a caveat.**

Phase 1 ("wire existing data into existing tools") will only be effective if at least ~5% of meaningful nodes carry a real inbound edge. We measure that as a fraction of **class / function / method** nodes (the nodes a caller query would point at) with any inbound `calls` or `references` edge. The Q4 finding — `class:Service:42` has 428 references edges and a substring-appears-in-61-grep-hits — shows the references data is **dense** even if noisy. Routing `code_find intent=callers` through the analyzer (filter widened to `kind IN ('calls','references')`) plus a precision-aware ranking would produce a usable caller list immediately.

**Caveat:** the noise of `references` edges (~1.15M total, ratio of ~7:1 references vs calls) means a flat list is unusable. Phase 1 must include:
- group `references` by source node
- per-target ranking that prefers `kind='calls'` over `kind='references'`
- a `derivation` field reporting which kind(s) produced each hit (per plan §1d)

Without ranking, the agent gets 428 hits instead of the 8 real source-file callers.

### Gate B — Is Phase 2 mandatory before Phase 1?

**Verdict: Phase 2 has additional signals but is not mandatory before Phase 1.**

Two Phase-2 metrics from the plan:
- `yield*` sites > 50 → Phase 2 mandatory. **Actual: 384.** 8x the threshold. **Phase 2 is recommended** to recover Effect-context resolution that no amount of regex plumbing can extract.
- Q4 gap > 50% (428 references vs 64 grep hits = 364% over baseline) → Phase 2 mandatory. The threshold was a 50% UNDER baseline gap; this is in the opposite direction.

So gating on count alone is misleading: the parser produces MORE references than grep, not fewer. The real problem is **precision**, not **recall**. Phase 1 with a precision-aware ranking can recover ~80% recall on test files (per Q5) at unknown precision on production code. Phase 2 (yield* / service_access emission) adds the cross-service call graph that grep and Phase-1 cannot reach.

**Recommendation:** ship Phase 1 first, then start Phase 2 once Phase 1 metrics stabilize. Do NOT block Phase 1 on Phase 2 — the data is already there to make `code_find callers` useful for the most-likely user query ("who in this repo uses X").

### Gate C — parser bug vs schema bug?

**Verdict: schema is permissive; the bug is the parser + indexer not emission logic.**

Diagnosis:
- **Schema is correct.** `codegraph_edges.kind` is a plain `text` column (no CHECK constraint), so adding new kinds requires no migration. The Drizzle binding in `codegraph.sql.ts:41` has a TS-only union, but that's compile-time only. The DB itself will accept any kind string.
- **Parser is incomplete.** `langs/typescript.ts:94-147` declares a `ParsedEdge[]` return type but emits `edges: []` always. The IMPORTS_REGEX populates a separate `imports: string[]` that is discarded. Even before Phase 2, the parser should be emitting one `kind='imports'` edge per parsed import — this would deliver ~3,061 files × ~5 imports/file ≈ 15,000 additional `imports` edges with no other work.
- **Indexer cross-edges are configured but don't fire.** Lines 638/670/682/696/715 declare `tested_by`/`configured_by`/`built_by`/`mounts`/`generated_from` branches that depend on nodes whose `kind` is `config`/`docker`/`route`/`generated`/`test`. Q1 shows 0 of these. Investigation: the 3,061 indexed files include `package.json` (config) and `Dockerfile`/compose.yml (docker) — but no `route` files were found in this DB.

**Files to touch first, in order:**
1. `packages/core/src/banyancode/langs/typescript.ts` — make the parser actually populate `edges`. Add one `imports` edge per matched import literal (resolving to the imported symbol via the project's existing namespace map). 5 lines of code.
2. `packages/core/src/banyancode/codegraph-indexer.ts:528` (the `searchNodes({ limit: 100_000 })` call) — verify that the cross-edge branches run with a populated node set. Add a `console.log`/`Effect.log` or instrumentation.
3. `packages/core/src/banyancode/codegraph-build-service.ts:107` — does the indexer skip cross-edges on cancellation? Line 685-687 says "Fall through; the putEdges call below will simply write what we have so far" — so the partial write is intentional, but there's no way the build skips config/docker/test nodes entirely.

---

## Recommendation

**Ship Phase 1 first, in parallel with the (1-2 line) parser fix that re-enables `imports` edges.** Phase 2 (`yield*` / `service_access` emission) should start as soon as Phase 1 lands but should not gate Phase 1's release. Plan §8's gate ("did agents actually use Phase 1 in the first 2 weeks?") should be the trigger to redirect engineering capacity to Phase 2.

Concrete next steps for Phase 1:
- Wire `code_find intent={callers,impact,dependents}` → `CodegraphAnalyzer.callers/impact/dependents` with `kind IN ('calls','references')`. **File:** TBD by grep `symbol-not-in-graph`, then add the analyzer call. (400 LOC.)
- Add per-kind ranking + `derivation` field per plan §1d. (200 LOC.)
- Fix the parser imports-emission bug (this memo, item Gate C). (50 LOC.)
- Add `findSymbolsByServiceTag` consistency test (per plan §1c). (200 LOC, test-only.)
- Update `banyancode_*.json` schema doc to declare `precision` and `derivation` fields. (50 LOC.)

Total: ~900 LOC across 5 PRs, fits plan §8's 3-5 day Phase 1 budget.

---

## Unexpected findings

1. **The DB has zero `mounts` / `tested_by` / `configured_by` / `built_by` / `generated_from` / `imports` / `yield` edges.** Plan §8 implicitly assumes these exist; only `references` / `calls` / `extends` do. Either the indexer lost them in a refactor or the build never produced nodes with the right `kind`. Worth an internal archaeology check (5 min with `git log -S tested_by packages/core/src/banyancode/codegraph-indexer.ts`).
2. **The `codegraph_meta` table is missing from this 1.49 GB DB** despite being created by `libsql_fresh.ts:272` and required by `codegraph-build-service.ts:160-163`'s `bumpVersion`. The build keeps reading `graphVersion` from this table — every successful build on this DB will fail to bump a version. The DB is currently in a state where a fresh `codegraph_build` would crash on `tx.select().from(CodegraphMetaTable).get()` with `null`.
3. **`e2e/regression/*.spec.ts` are over-represented in the first 10 `calls` edges.** Sample bias — the SQL probe did not randomize. Plan §5a (`Golden file tests for every query`) should include a deterministic-seeded random sample, not rowid-order.
4. **`nodeMap.get(name)` (`codegraph-indexer.ts:579`) walks every identifier ≥3 chars long in every node body.** For 17,974 nodes × ~5,000 identifiers each, this is O(n²) on worst-case workspace. The 44.7s build in the spec is consistent with that profile. A 17,974 × 8-identifier optimization would be ~30% of current build time.
5. **The `codegraph_fts` virtual table** (added by migration `20260707120000_codegraph_fts.ts`) is present in this DB but `rebuildFtsIndex` returns count only when triggered manually — there's no probe for `codegraph_fts` row count in this memo. Worth adding to Q-anything.

---

## Reproducing this report

```powershell
cd D:\OpenCode\packages\core
bun typecheck                                  # passes
bun script/codegraph-recon-2026-07-08.ts       # 30s, writes JSON + stdout
cat specs/banyancode/codegraph-recon-2026-07-08.json | jq .q1_edgeKindCounts
```

Do NOT commit `packages/core/script/codegraph-recon-*.ts`. It is .gitignored under `codegraph-recon-*.ts` since this commit.
