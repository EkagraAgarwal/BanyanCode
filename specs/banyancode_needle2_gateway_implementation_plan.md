# BanyanCode Repository Intelligence Gateway — Implementation Plan

**Status:** Approved-for-implementation plan (feasibility: VIABLE)
**Source spec:** `specs/banyancode_needle2_universal_repository_intelligence_architecture.md`
**Audit method:** Feasibility audit performed against the actual codebase via repository-intelligence tooling + parallel subagent exploration (2026-08-12). All file:line references verified against `main` at `d12cb198`.

---

## 1. Verdict

All five feasibility gates (spec §113) pass, with two partials and four material caveats:

| Gate | Verdict | Summary |
|---|---|---|
| A — Interception | PASS | Single choke point `ToolRegistry.settleWith → Tool.settle → config.execute`; both V1 and V2 runtimes funnel through it |
| B — Context | PARTIAL | settle input has sessionID but not user request / tool history; both recoverable from session store, needs one additive change |
| C — Backends | PASS (2 gaps) | All intel services are Effect `Context.Service`s, callable without duplication; no structural-query or architecture service exists |
| D — Packaging | PASS w/ caveats | Needle 2 real, Apache-2.0/MIT, 14MB; no darwin-x64, proprietary quant, 256-token window, days-old release |
| E — Fallback | PASS | `serviceOption` + `EventV2.observe` isolation give the exact failure-containment shape |

**Caveats to keep visible (do not silently accept):**
1. Needle 2 has no macOS Intel (darwin-x64) build — wasm fallback only for that target.
2. Proprietary `.cact` quant locks the router to the Cactus engine (no llama.cpp fallback).
3. 256-token sliding window evicts early router context; keep router prompts aggressively bounded.
4. Days-old release, vendor-reported benchmarks only — require an independent benchmark before activation (milestone 2).

---

## 2. Durable Architecture (what we are actually building)

The durable investment is the **RepositoryGateway** (spec §131), not Needle. Needle 2 is one implementation of `ToolRouter`.

```
                 PRIMARY LLM
                      |
           read / grep / glob / native banyan tools
                      |
                      v
   ToolRegistry.settleWith (registry.ts:55-67)   <-- interception slot
                      |
                      v
   RepositoryGateway.execute(RepositoryRequest)
      |                    |                    |
   normalize          fast rules          ToolRouter (Noop/Rules/Needle)
      |                    |                    |
      +---------+----------+---------+----------+
                |                    |
          validate              Banyan validator (freshness, scope,
                |                 permissions, existence)
                v
          BackendSelector -> RepositoryBackend (Content/Search/Symbols/
          Relationships/Structural/Architecture/Ownership)
                |
                v
          format (model-compatible) + emit trace + return
```

### 2.1 Interception point (Gate A)

Wrap at `ToolRegistry.settleWith` (`packages/core/src/tool/registry.ts:55-67`) between name resolution (`:56-57`) and leaf settle (`:67`). The slot is currently empty; precedent hooks already live in `Tool.settle` (`tool.ts:128-144` telemetry, `:240` usage tap).

- Single wrapper covers both runtimes (V1 processor + V2 runner) because both call `settleWith`.
- Sits **upstream** of per-tool permission asserts (`read.ts:37`, `grep.ts:57`) — satisfies spec §32 (Needle never the permission boundary).
- The wrapper must be an `Effect.serviceOption`-style optional service (`Banyan.RepositoryGateway`), so a missing/disabled gateway is a no-op passthrough that never widens `R`.

### 2.2 Context addition (Gate B)

`settleWith` currently receives `sessionID / agent / assistantMessageID / toolCallID` only. Add an `investigation` accessor to the settle input:

- `userRequest: string | undefined` — resolved from `SessionMessage.User.text` (`packages/core/src/session/message.ts:34-43`) via session store at dispatch time.
- `recentToolCalls` — last N `AssistantTool` messages (`message.ts:106-120`).
- `investigationState` — `{ entities, files, concepts, recentQueries }` kept per (session, agent) in a `Ref` (in-memory, spec §22) or session-scoped store.

Scope: per (repository, session, agent) so one subagent's investigation never distorts another's routing (spec §96-98).

### 2.3 Interfaces (adapt spec §132 to repo conventions)

```ts
// packages/core/src/banyancode/gateway/types.ts
interface RepositoryRequest {
  source: "model-tool" | "native-banyan-tool" | "internal";
  originalTool: string;                 // "grep"
  arguments: Record<string, unknown>;   // { pattern, path }
  userRequest?: string;
  recentToolCalls?: RepositoryToolCall[];
  investigationState?: InvestigationState;
  repositoryContext?: RepositoryContext; // { root, graphStatus, supportedLanguages, graphCoverage }
}

type RepositoryOperation =
  | { kind: "content"; path: string; range?: { startLine?: number; endLine?: number } }
  | { kind: "text_search"; pattern: string; paths?: string[] }
  | { kind: "file_discovery"; pattern: string; path?: string }
  | { kind: "symbol"; query: string; path?: string }
  | { kind: "relationship"; relation: "callers"|"callees"|"references"|"dependents"|"imports"|"implementations"|"extensions"; target: string }
  | { kind: "structural"; query: string; language?: string }
  | { kind: "architecture"; query: string }
  | { kind: "ownership"; query: string };

interface RepositoryResult {
  route: "direct" | "augment" | "intelligence";
  operation: RepositoryOperation;
  source: "filesystem" | "text-index" | "codegraph" | "tree-sitter" | "hybrid";
  results: RepositoryResultItem[];
  provenance: { originalTool: string; resolvedOperation: string; router: string; routerVersion: string };
  freshness?: { graph: "fresh" | "stale" | "unavailable" };
}

interface ToolRouter {
  classify(input: RouterInput): Effect<RouteDecision, never, never>; // never-fail, catchAll inside
}
```

### 2.4 Backend registry (Gate C)

New Effect services are NOT needed for existing backends — call them directly:

| Operation | Backend (existing) | Location |
|---|---|---|
| content | Filesystem read | `packages/core/src/tool/read.ts` / `read-filesystem.ts` |
| text_search / file_discovery | `Ripgrep.Service` | `packages/core/src/ripgrep.ts:80-92` |
| symbol | `Banyan.Search.Service` (cascade) + `RepositoryIntelligence.query` | `search/layer.ts:8-12`, `repository-intelligence/service.ts` |
| relationship (callers/callees/dependents/references/impact) | `RepositoryIntelligence` + `CodegraphAnalyzer` | `repository-intelligence/service.ts:4-27` |
| ownership | `RepositoryIntelligence.findOwner` (git blame) | `git-service.ts:1-78` |
| structural | **NEW thin service** wrapping private parsers (`langs/registry.ts:70-79`) — or keep DIRECT until tree-sitter query migration | — |
| architecture | **NOT a callable backend today** — keep DIRECT; revisit with future graph layers | — |

### 2.5 Freshness (spec §30, §101)

Callable today: pure `isStale()` (`graph-staleness.ts:23-55`, 3-way fresh/med/high) + `CodegraphRepo.getMeta/countStaleFiles/listStaleFiles/countFiles` (`codegraph-repo.ts:166-175`, `:248-250`). Policy: FRESH → graph routing; STALE → hybrid/fallback; UNAVAILABLE → direct. `codegraph_staleness` tool output shape reused for traces.

### 2.6 Edit propagation (spec §31, §100)

Already convergent: `edit`/`write`/`apply_patch` publish `Watcher.Event.Updated` (`edit.ts:116`, `write.ts:69`, `apply_patch.ts:262`) and `codegraph-auto-update.ts:396` debounces an incremental re-index. The gateway gains freshness checks for free; **no new invalidation machinery needed**. Caveat: re-index is debounced, not synchronous — never assume post-edit freshness without `isStale()`/staleness check.

### 2.7 Router abstraction (spec §37)

`ToolRouter` with three implementations, feature-flagged:

```
BANYANCODE_ROUTER=off        -> NoopRouter (passthrough, default)
BANYANCODE_ROUTER=rules      -> RulesRouter (deterministic, spec §20 signals)
BANYANCODE_ROUTER=needle     -> NeedleRouter (Needle 2, shadow or active)
```

`NeedleRouter` failure policy: timeout/crash/invalid JSON/low confidence → return `{ route: direct }` (spec §35). Never blocks, never widens `R`.

---

## 3. Needle 2 Integration (Gate D)

### 3.1 Facts (verified)

- 45M params; Apache-2.0 weights / MIT engine; commercial redistribution allowed.
- Artifacts: `needle2.cact` (13.7MB) + per-platform engine binaries, OR `wasm/needle.js` (62.4kB) + `needle.wasm` (315kB).
- Native tool calling with grammar-constrained JSON; confidence score per call.
- No npm package, no hosted API, no darwin-x64 build.

### 3.2 Delivery mechanism — lazy download (ripgrep precedent)

Embedding inflates all 11 platform packages, hits the build presence guard (`build.ts:263-272`), and postinstall is unreliable under npm 11 allow-scripts. Follow `packages/core/src/ripgrep/binary.ts:90-119` exactly:

- Download `.cact` + platform engine (or wasm pair) into `Global.Path.bin` (`packages/core/src/global.ts:10-51`) on first ambiguous routing request.
- `Effect.cached` per-version; integrity hash pinned per version; upgrade path = version bump.
- Process model: **one resident router per Banyan process** (spec §73) — never spawn per request. Native engine via one-shot `--prompt` call or the CLI `--serve` HTTP server on localhost; wasm via loaded `needle.js` module (must tolerate load failure — same failure class as the tree-sitter wasm lesson).

### 3.3 Router context budget (spec §15-17, 43)

Bounded input: current tool call → user task → investigation state → recent operations → repository metadata. **Stay under the 256-token window**; beyond that, evicted history silently degrades routing. Never feed repository file content into the router (spec §69-70: prompt injection — repository text is untrusted).

---

## 4. Feature Flags & Rollout (spec §77-79)

Config: additive fields in `BanyanConfig.Info` (`packages/core/src/v1/config/banyan-config.ts:50-159`):

```
banyancode_router: "off" | "rules" | "needle" | "needle_shadow"   (default "off")
banyancode_route_grep: boolean   (default false)
banyancode_route_read: boolean   (default false)
banyancode_route_glob: boolean   (default false)
banyancode_augment_read: boolean (default false)
banyancode_router_trace: boolean (default false)
```

Env twin via `RuntimeFlags` (`packages/opencode/src/effect/runtime-flags.ts:34-76`): `BANYANCODE_ROUTER`, `BANYANCODE_ROUTE_GREP`, etc. Gate via `enabledByExperimental` pattern (`flag.ts:11-13`) if a flag-only phase is desired.

Rollout sequence (each stage gated, traced, benchmarked):

```
OFF -> RULES_ONLY -> NEEDLE_SHADOW -> NEEDLE_ACTIVE_FOR_GREP -> NEEDLE_ACTIVE_FOR_READ/GLOB
```

Disabled router (default) must be a byte-for-byte behavioral no-op.

---

## 5. Implementation Phases

### Phase 0 — Gateway skeleton (DIRECT only, no behavior change)

- `packages/core/src/banyancode/gateway/`: `types.ts`, `gateway.ts`, `normalizer.ts`, `formatter.ts` per spec §38 layout.
- `RepositoryGateway` Effect service, optional (`serviceOption`), registered in `banyancode/index.ts` + namespace `Banyan.RepositoryGateway`.
- Normalize → route=direct → execute original tool → format unchanged. Emit `repository_route` trace.
- Wire into `settleWith` slot (`registry.ts:56-67`) with NoopRouter default.
- Tests: gateway passthrough equivalence on read/grep/glob (`packages/core/test/banyancode/gateway-direct.test.ts`).

### Phase 1 — Tracing (spec §44-45)

- `repository_route` event via `EventV2.define` + `publish` (pattern: `banyancode-codegraph-bridge.ts:25`) **and/or** JSONL via `record()` (`observability/trace.ts:45-52`). Fields: original_tool, arguments, route, confidence, backend, reason_codes, graph_freshness, latency_ms, router_version.
- Register a bridge if bus delivery is needed (`banyancode-gateway-bridge.ts`, forkDetach drain, sole consumer).
- Shadow-route counters: direct/augment/intelligence rates, low-confidence rate, fallback rate.

### Phase 2 — Deterministic rules router (spec §20, §121)

- `RulesRouter`: strong DIRECT indicators (docs paths, config extensions, exact file/range requests) and INTELLIGENCE indicators (callers/references/dependents/imports/implementations/extends/impact/architecture/ownership/definition). Signals, not laws.
- Fast path: `README.md → direct`, `grep TODO → direct` etc. Cache deterministic decisions keyed by (repo, operation, policy version).
- Policy precedence (spec §135): exact-content > user scope > security/permission > deterministic constraints > repository facts > Needle > heuristic fallback.
- First activation target: **grep only** (spec §116 — highest ambiguity, best demo).

### Phase 3 — Benchmark corpus (spec §47-51)

- 300–1,000 examples: content / lexical / symbol / relationships / structural / architecture / ambiguous + hard negatives ("Search the docs for the phrase 'who calls Foo?'" → DIRECT_SEARCH).
- Golden-test requirement: every real routing bug becomes a regression test.
- Record router_version, policy_version, corpus_version per run (spec §43, §123).

### Phase 4 — Needle 2 shadow (spec §79-80)

- `NeedleRouter` behind `banyancode_router=needle_shadow`: execution unchanged, Needle classifies every ambiguous grep in parallel; log actual vs Needle route + confidence + disagreement.
- Lazy download into `Global.Path.bin`; resident engine; bounded context; catchAll.
- Compare vs RulesRouter on held-out benchmark — **if Needle does not beat rules, do not activate it** (spec §156).

### Phase 5 — Needle active for grep (spec §78)

- `banyancode_route_grep=true` + `banyancode_router=needle`: route only high-confidence semantic greps (≥0.90 placeholder, calibrated on corpus); 0.70-0.90 → hybrid; <0.70 → direct (spec §24).
- Freshness checked before any graph route; STALE → fallback or explicit freshness metadata (spec §101).
- Then Phase 6: investigation-state context (Gate B addition). Phase 7: selective read augmentation (default = exact source + small symbol header, never summaries for content requests — spec §29, §117).

### Phase 6+ — Contextual state & augmentation

1. Investigation state wiring (spec §22): entities/files/concepts per (repo, session, agent).
2. `banyancode_augment_read=true`: read code files → exact source + compact symbol header (Symbol / Imports / References / Callers counts) when graph fresh and symbol exists.
3. Read/glob activation only after grep proves out.

---

## 6. Milestones (spec §155-157)

1. **M1**: A model that only calls read/grep/glob completes repository-semantic tasks via Banyan graph infrastructure without ever calling a codegraph-specific tool. (Gateway + rules + grep routing.)
2. **M2**: Needle route accuracy > deterministic baseline on held-out benchmark. If it loses, rules stay and Needle is dropped.
3. **M3**: Primary LLM + compatibility gateway + Needle approaches primary LLM + native Banyan tools on repository tasks. Architectural proof point.

## 7. Definition of Done (spec §158)

- read/grep/glob still work normally with router disabled (default).
- Graph-suitable semantic greps route without model-specific prompting.
- Documentation/arbitrary text remain searchable/readable (hard negatives enforced).
- Needle failure falls back safely; freshness checked before graph routes; permissions unchanged (Banyan-owned).
- Routing fully traced; router disabled by default; packaging adds no install friction (lazy download only).

---

## 8. Risks & Mitigations (spec §153)

| Risk | Mitigation |
|---|---|
| Needle misroutes | conservative thresholds, policy validation, direct fallback, hard-negative corpus |
| Needle packaging | lazy download (ripgrep precedent), isolated router package, replaceable via `ToolRouter` |
| Graph freshness | `isStale()` before every graph route; hybrid fallback |
| Context inflation | selective augmentation; compact results; progressive disclosure (top N + count + expand) |
| darwin-x64 missing | wasm fallback for Intel Macs only; rules router remains |
| 256-token window | bounded router context; re-benchmark if quality drops on long investigations |
| Cactus engine lock-in | `ToolRouter` abstraction; benchmark vs Qwen2.5-0.5B (491MB, Apache-2.0) if needed |
| False intelligence > missed intelligence | optimize false-intelligence rate first (spec §46) |

## 9. Tests to Extend

- `packages/core/test/session-runner-tool-registry.test.ts` — interception slot behavior
- `packages/opencode/test/tool/registry.test.ts` — settleWith wrapper passthrough
- `packages/core/test/tool-catalog.test.ts` + `packages/opencode/test/effect/tool-catalog.test.ts` — materialize unchanged
- `packages/core/test/banyancode/adapted-catalog.test.ts` — tiering unaffected
- New: `gateway-direct.test.ts`, `router-rules.test.ts`, `router-benchmark.test.ts` (corpus + hard negatives), `router-needle-shadow.test.ts` (fail-closed assertions)

## 10. Open Questions for Implementation

1. `RepositoryGateway` — new `Banyan.*` service or hook inside existing `ToolRegistry` layer? (Recommend new service, wired in `settleWith` via `serviceOption`.)
2. Native engine process model: one-shot `--prompt` vs `--serve` HTTP resident. (Benchmark both; resident preferred per spec §73.)
3. Does Needle's confidence output need calibration to Banyan's route set before M2? (Plan: yes — collect shadow-mode calibration data first.)
