# Deep Jev integration implementation plan

Status: verified dev-canary scope; remaining rollout waves deferred. Baseline: existing single-Choice client,
explore/scout routing, judge tool, and V1 read-only explorer.

## Objective

Use Jev for bounded semantic decisions that remove generative-model work.
Code owns execution, permissions, counting, deadlines, and budget enforcement.
Generative models still plan, write code, summarize, and explain novel findings.
The user prefers broad relevant context after secret filtering and maximum
parallel implementation speed. Use built-in BanyanCode agents, at most five
concurrent workers, disjoint file ownership, and serialized heavy verification.

## Corrected design constraints

- Batch independent questions about ONE shared state. Use per-candidate
  requests with bounded concurrency, not default 25-item packing: the reference
  benchmark reports F1 0.723 packed versus 0.966 per-item.
- Keep credentials out of config and logs. Filter secrets in state, question
  instructions, and criteria at the network boundary. Filtering is defense in
  depth, not an authorization or injection-resistance guarantee.
- Preserve no-key and explicit-global-disable behavior. New automatic policies
  require an explicit aggressive profile or explicit per-feature enablement;
  preserve existing explorer/routing enables and all explicit disables.
- Respect pinned agent models and thinking overrides. No model-confidence
  based permission approval and no reviewer bypass based on diff size alone.
- Noul has no confidence field. Choice/Score confidence and Noul thresholds
  are policy-specific; they are not interchangeable correctness probabilities.
- Request limits are configurable and deadline-aware. Do not hardcode the
  reference's 1,200 requests/min as a provider contract. Enforce local payload
  limits conservatively; characters are not tokens.
- Preserve stable wire tools and prompt prefixes. Dynamic context belongs after
  the stable prefix. No unconditional grep before repository intelligence.
- Count each physical request once. Separate actual usage, estimated cost,
  cached results, and counterfactual savings. Never claim product-wide savings
  from fixture replay or per-decision prices.

## Shared contracts for the first parallel wave

Core `jev.ts` retains `decide(DecideInput)` and adds:

```typescript
type Question =
  | { type: "noul"; instructions: string; criteria?: { true?: string; false?: string } }
  | { type: "choice"; instructions: string; criteria: Readonly<Record<string, string | null>> }
  | { type: "score"; instructions: string; criteria: readonly string[] }

// ask takes ONE input object, not positional arguments.
// Common options mirror DecideInput: config, env, backend, model, apiKey,
// fetch, endpoint, timeoutMs, plus signal, sessionID, feature, and scope.
// Success: { ok: true, answers: Record<string, Answer>, backend, model,
//            latencyMs, usage?, cached? }
// Failure: existing structured never-throw error shape, extended for budgets
//          and cancellation where required.
ask({ state, questions, ...options })
feature(config, env, name): boolean
usage(sessionID): bounded ledger snapshot
```

`Answer` is discriminated by `type`; Noul has numeric `noul` in [0, 1] (not a
boolean), Choice has `choice`,
`probabilities`, `confidence`, Score has `score`, `legend`, `probabilities`,
`confidence`. Client redaction precedes network access and cache hashing.
Existing Choice callers remain source-compatible.

Score accepts 2..10 rubric levels. Physical request counts and usage settlement
are separate operations. A caller deadline covers queueing, headers, body
decoding, and retry waits. Retry-After must not be shortened to retry early.

Configuration lives only in `packages/core/src/v1/config/banyan-config.ts`:

- `banyancode_jev_profile`: conservative or aggressive.
- `banyancode_jev_features`: record of boolean per-feature overrides.
- `banyancode_jev_model_tiers`: fast/strong model strings and optional
  fastThinking/strongThinking using the existing thinking-level schema.
- `banyancode_jev_budget`: perTurnCalls and perSessionUsd.
- `banyancode_jev_client`: maxInflight, requestsPerMinute, tokensPerMinute,
  cacheMaxEntries, cacheTtlMs, and retries, all bounded at runtime.

Feature IDs: judge, explorer, subagent-routing, turn-routing, context-rerank,
compaction-routing, review-routing. Unknown automatic features default off
outside the aggressive profile. Review-routing selects a reviewer profile; it
does not grant a pass without independent verification.

Core `jev-turn.ts` provides a runtime-independent Promise-based policy:

```typescript
planTurn({ task, config, env?, fetch?, apiKey?, sessionID?, signal? })
// returns undefined on disabled, failure, or uncertainty;
// otherwise { kind, tier, model?, thinking? }.
// Optional per-request usage/latency/cache metadata may accompany the result
// for activity publication; never derive it from concurrent ledger deltas.
// kind: read_only | small_edit | multi_file_edit | needs_plan | other
// tier: fast | strong
```

V1 and V2 adapters must honor explicit model overrides before applying this
advisory policy. All paid V1 decisions start existing JevActivity rows before
requests; failures and interruption settle those rows.

Do not pay for profile selection when no execution tiers are configured and
the result cannot affect execution. Activity rows are decision observations;
the client ledger counts physical requests, including retries, exactly once.

## Parallel wave 1: foundation and functioning consumers

| Worker         | Owned paths                                                                                                                                                     | Acceptance                                                                                                                                                       |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A: client      | core/src/banyancode/jev.ts, jev-service.ts, jev-ledger.ts, core barrel exports, core/test/banyancode/jev\*.test.ts excluding turn/config tests                  | Three primitives, shared-state questions, abort/deadline propagation, bounded cache/single-flight/concurrency/budgets, redaction, ledger, unchanged Choice API   |
| B: explorer    | opencode/src/session/jev-explorer/\*, opencode/test/session/jev-explorer.test.ts                                                                                | Exact web evidence verification, terminal failure cleanup, bounded no-progress loops, useful verified handoff evidence, cancellation                             |
| C: V1          | opencode/src/session/prompt.ts, new jev-turn.ts/jev-context.ts, opencode/src/tool/task.ts and jev-judge.ts, corresponding routing/judge/turn/context tests      | Shared gating, broader configured subagent routing, safe turn policy adapter, activity and usage, no-key regression, preserved pins and wire tools               |
| D: config/V2   | core/src/v1/config/banyan-config.ts, core/src/banyancode/jev-turn.ts, core/src/session/runner/llm.ts, dedicated config/turn/V2 tests                            | Validated config, batched turn policy, functioning V2 seam, no-key and uncertainty fallback                                                                      |
| E: reliability | opencode/src/session/retry.ts and compaction.ts, core/src/session/compaction.ts, opencode/src/effect/banyancode-review-bridge.ts, corresponding dedicated tests | Deterministic terminal quota classification; explicitly configured Jev compaction/reviewer profile routing without skipping required review or protected context |

Workers do not commit, regenerate the SDK, run package-wide typechecks, edit
another worker's paths, or revert pre-existing changes. They may run narrowly
targeted tests. Lead owns this plan, product docs, integration fixes, SDK regen,
observability/benchmark follow-up, and final serialized verification.

## Subsequent implementation waves

1. Context funnel: repository-first candidates, per-item multi-question gates,
   small adaptive waves, contradiction preservation, source-linked handoff,
   recoverable output filtering and memory reranking. No lossy pruning of
   commitments, errors, acceptance criteria, or required review evidence.
2. Visibility: aggregated Jev usage and feature status in the existing TUI,
   with no edits to pre-existing dirty TUI files. Add a focused status surface
   rather than duplicating cost accounting. Persisted part/schema changes
   require SDK regeneration after integration, not before dependent changes.
3. Credential UX: use existing Auth.Service, env precedence, explicit Jev
   connection, backend-specific credentials; never reuse generic gateway keys.
4. Mesh policy: role/profile selection and duplicate-work triage from concrete
   assignments. Code retains ownership of file conflicts and RAM limits.
5. Context pruning/research filtering: retain full results and recovery paths;
   shadow-test recall before aggressive automatic filtering.
6. Background semantic labels and offline policy learning: content/version
   keyed, bounded and opt-in; never change ignore/skip buckets from a model
   prediction. Exact AST/path roles remain deterministic.

## Verification and rollout

- Review every worker diff and request independent reviewer verdicts.
- Run affected package tests from packages/core, packages/opencode, and
  packages/tui only. Run each package's `bun typecheck` serially.
- Cover all primitive validators, disabled/no-key request equality, explicit
  disables, model pins, invalid answers, deadlines, cancellation, retry-after,
  cache isolation, ledger deduplication, budget races, and citation fidelity.
- Keep protected context and public permission semantics unchanged.
- Regenerate JS SDK only after all public schema/route changes stabilize.
- Benchmark offline schema/policy replay separately from live matched tasks.
  Product metrics: cost per accepted task, success, p50/p95 end-to-end latency,
  generative calls, cache hits, escalation, retrieval recall, missed defects.
- No production Jev calls during implementation verification without explicit
  approval. No commits or pushes unless requested.

## Progress

- [x] Inspected current integration and reference results.
- [x] Recorded merged design, safety corrections, and worker ownership.
- [ ] Wave 1 implementation complete.
- [x] Client review findings corrected (real wire shapes, request accounting,
      cancellation, concurrency permits, conservative bounds, and USD reservations).
      Independent foundation re-review passed after per-attempt settlement fixes;
      the combined client/config/policy suite has 114 passing tests.
- [x] Offline three-primitive wire replay implemented and executed without
      production requests; this does not establish end-to-end savings.
- [x] Activity-derived sidebar implemented; TUI typecheck and 42 targeted
      activity/tree/sidebar/spacing tests pass.
- [x] SDK regenerated after the expanded configuration schema.
- [x] Configured fresh-subagent routing, judge feature disables, and cancellation
  verified by 26 V1 integration tests. Budget scope follows the assistant's
  parent user-turn identity across multiple model steps.
- [x] Memory retrieval rerank helper and service verified by 18 tests; the
  original deterministic no-key scoring remains unchanged.
- [x] Public memory_search reranks only authorized, scope-filtered candidates;
      six real ToolRegistry integration tests cover the production path.
- [ ] V2 automatic tier routing: deferred if the resolved model cannot be
      changed safely while honoring pins and model-dependent request settings.
      Do not pay for advisory-only logging in the meantime.
- [x] Release-scope integration, independent review, targeted tests, and
      typechecks complete; subsequent waves and tier-routing consumers remain
      deferred as described below.
- [ ] Follow-up context/visibility/auth/mesh waves complete.
- [ ] Live quality/cost gates established; no savings claim before this.

Final release checks with Bun 1.4.2: 138 core tests, 74 V1 integration tests,
42 TUI tests, and 40 retry tests pass. The serialized workspace typecheck
completed all 22 tasks. One explorer regression exceeded its five-second test
timeout on an earlier combined run; it passed isolated and in the final full
suite without assertion or timeout changes. No production Jev requests were
used for these checks.

## Release scope

This dev canary delivers the typed bounded client, accounting, configuration,
fresh-subagent routing, judge gates, verified explorer evidence and cancellation,
public memory-search reranking, compact sidebar, and offline replay. It is not
completion of every subsequent implementation wave above.

Automatic main-turn, compaction, and reviewer tier routing remain deferred.
Credential-management UX, mesh profile selection, broad context pruning, and
background semantic labels are also deferred. Existing review requirements,
permissions, protected context, and model pins remain authoritative. No live
quality/cost evaluation or product-wide savings claim is included.
