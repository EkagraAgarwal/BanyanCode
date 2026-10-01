# Jev integration

Jev is a typed decision model, not a replacement for a coding LLM. The core client supports shared-state batches of Noul, Choice, and Score questions. The `jev_judge` tool remains a bounded single-Choice interface. Fresh subagents can use explicitly configured alternate generative profiles; pinned models, variants, and resumed tasks take precedence. Unavailable, invalid, or uncertain decisions preserve the existing execution path.

## Configuration

The initial release supports environment-based credentials. Set `BANYANCODE_JEV_API_KEY` outside source control. A TypeSafe-specific `TYPESAFE_API_KEY` can also be used for the direct backend. For OpenRouter or Vercel, put a key intended for Jev in `BANYANCODE_JEV_API_KEY`; generic gateway environment keys are never reused, even if project config enables Jev.

### Expanded controls

- `banyancode_jev_profile`: `conservative` (default) or `aggressive`. Existing explicit enables keep working; new automatic policies require the aggressive profile or a per-feature enable.
- `banyancode_jev_features`: per-feature boolean overrides, including `judge`, `explorer`, `subagent-routing`, and `context-rerank`. `turn-routing`, `compaction-routing`, and `review-routing` are reserved for deferred consumers, not automatic execution in this release. A global `banyancode_jev_enabled: false` always wins.
- `banyancode_jev_client`: bounded concurrency, request/token rate limits, cache size/TTL, and retries. Retries respect the request deadline and `Retry-After`.
- `banyancode_jev_budget`: `perTurnCalls` and `perSessionUsd`. Budget accounting is process-local and bounded; dollar figures without provider-reported cost are conservative estimates, not invoice totals. Unknown model pricing fails safe when a dollar cap is configured.
- `banyancode_jev_model_tiers`: explicitly configured fast/strong models and optional thinking levels for supported profile-selection consumers. Configuring tiers does not authorize overriding a pinned message model.

The client filters common secret patterns in state, question instructions, and criteria before sending or hashing them. This is defense in depth, not a guarantee that arbitrary source is safe to disclose. Broad relevant context still remains untrusted data; model decisions never grant permissions.

Shared-state batching means several questions about one candidate. Unrelated candidates are not packed into one state by default. Noul is a probability in `[0, 1]`; Score uses numbered rubric levels and can exceed 1. Thresholds are policy-specific.

```json
{
  "banyancode_jev_enabled": true,
  "banyancode_jev_backend": "typesafe",
  "banyancode_jev_subagent_models": {
    "explore": { "model": "your-provider/your-fast-model", "thinking": "low" },
    "scout": { "model": "your-provider/your-fast-model", "thinking": "low" }
  }
}
```

`banyancode_jev_backend` accepts `typesafe`, `openrouter`, or `vercel`; `banyancode_jev_model` overrides the backend's Jev model alias. `banyancode_jev_enabled: false` prevents requests even if a key exists. Without an alternate model configured for an eligible subagent, there is no automatic routing request. The alternate must resolve to a configured provider model.

Jev receives a bounded excerpt of an eligible task's prompt and description. This may contain repository or user data; only enable it if the selected backend's privacy and retention terms are acceptable. Do not put the API key in `banyancode.json` or check it into a repository.

Decisions appear as persistent `Jev` activity beneath the assistant message. The activity part does not replay into model prompts or grant permissions. The explicit `jev_judge` tool, when enabled for an agent, sends the state provided to that tool to the selected backend.

## Status and evaluation

The expanded integration is tracked in [the deep integration implementation plan](./jev-deep-integration-plan.md), including worker ownership, verification, and remaining rollout gates. Do not claim product-wide cost savings until matched end-to-end coding workloads show lower **total** model cost without quality regression. Per-decision savings do not establish that result for BanyanCode.

Automatic subagent routing and `jev_judge` are wired into the V1/opencode tool runtime. Automatic main-turn model switching is deferred until pin provenance and model-dependent request settings can be preserved. Advisory-only decisions that would pay Jev merely to log a recommendation are not run automatically. The experimental V2 runtime should not be interpreted as full Jev parity.

The public `memory_search` tool can rerank a bounded candidate set when `context-rerank` is enabled. Permission checks and scope filtering run first; uncertainty, cancellation, or unavailable decisions preserve the original ordering. Compaction/reviewer tier routing and credential-management UX remain deferred.

### Visibility and replay

The compact Jev sidebar summarizes recent persisted activity rows for the current session. It labels them as observed decisions, not physical network calls, and shows cost coverage only where a row contains cost data. It never adds the exploration run's aggregate usage a second time or claims measured savings.

Run `bun ./packages/opencode/script/jev-bench.ts` from the repository root for an offline three-primitive wire replay. The harness uses injected responses and makes no production requests. Its estimates and local timings do not establish end-to-end task savings.

## Run ledger

The exploration coordinator publishes its run as a single `jev_run` message part, updated in place (one part id per run, delivered generically via `message.part.updated`). The TUI renders the part as an indented node tree beneath the assistant message: header row `Jev · explore-tree · <status>` with the node count, a latency/usage summary line, then each node's `actionID`, status glyph, sanitized target, confidence, and evidence paths with line refs. Child nodes indent under their parent via `parentID`; orphans and parentless chains start at the root, and cycles never hide a node. Implementation: `packages/tui/src/component/jev-tree.tsx`, wired through `PART_MAPPING` in `packages/tui/src/routes/session/index.tsx`; regression coverage in `packages/tui/test/component/jev-tree.test.tsx`.

**Statuses.** Run status is one of `running`, `completed`, `handoff`, `failed`, `cancelled`. Node status is one of `done`, `failed`, `skipped`. A `failed` run may still show `done` children — the ledger records what happened, not a single verdict.

**Handoff semantics.** `handoff` means the run stopped intentionally and the model continues from the recorded tree; the TUI renders a `continued by model` note next to the run's `stopReason`. Handoff is not failure and does not retry the run.

**Render budgets (display clamps, defense in depth for stored rows).** Displayed text is sanitized at the TUI boundary (ANSI and control characters stripped, collapsed to one line) and clamped: node target ≤ 120 chars, actionID ≤ 64, evidence path ≤ 200, evidence excerpt ≤ 200, `stopReason` ≤ 200. Trees with more than 8 nodes collapse to the first 8 rows plus a `+N more` line (click to expand). Node evidence, confidence, latency, and run-level usage render only when present and finite; engine-side run budgets (node/evidence counts, token caps) are owned by the coordinator implementation, not the renderer.

**Boundary validation.** The SDK includes the `jev_run` schema. The TUI additionally validates the wire shape with an `isJevRunPart` runtime guard, gated by `<Show when={data()}>`. A malformed part (wrong status enum, non-array or invalid nodes, invalid usage numbers) renders nothing rather than a partially trusted tree. User messages never render the ledger.

**V1-only scope.** The run ledger is wired into the V1/opencode session route only (`PART_MAPPING`), matching the V1-only scope of automatic subagent routing above. The experimental V2/core runtime does not render it.

Official contracts: [TypeSafe API](https://docs.typesafe.ai/api), [OpenRouter Jev](https://openrouter.ai/docs/guides/community/jev), [Vercel TypeSafe API](https://vercel.com/docs/ai-gateway/sdks-and-apis/typesafe). Reference implementations: [jev-use](https://github.com/shitianfang/jev-use) and [jev-ultrafast](https://github.com/browser-use/jev-ultrafast).
