# Jev integration

Jev is a typed decision model, not a replacement for a coding LLM. BanyanCode's first integration uses a bounded Choice decision to select a user-configured alternate generative model for fresh `explore` and `scout` tasks. Explicit per-agent model and variant overrides take precedence. If Jev is unavailable, rejects its response, or is uncertain, the existing model is used.

## Configuration

The initial release supports environment-based credentials. Set `BANYANCODE_JEV_API_KEY` outside source control. A TypeSafe-specific `TYPESAFE_API_KEY` can also be used for the direct backend. For OpenRouter or Vercel, put a key intended for Jev in `BANYANCODE_JEV_API_KEY`; generic gateway environment keys are never reused, even if project config enables Jev.

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

This is an initial vertical slice. API-key connection UX, per-session budgets, caching, repository/memory reranking, and broader goal/verification integration are separate phases; the detailed local plan is `.banyancode/plans/jev-integration.md`. Do not claim product-wide cost savings until matched end-to-end coding workloads show lower **total** model cost without quality regression. Viral per-decision 80-90% savings graphs do not establish that result for BanyanCode.

Automatic subagent routing and `jev_judge` are wired into the default V1/opencode tool runtime. The experimental native V2/core tool registry does not expose these integrations yet; enabling that runtime should not be interpreted as Jev support.

## Run ledger

The exploration coordinator publishes its run as a single `jev_run` message part, updated in place (one part id per run, delivered generically via `message.part.updated`). The TUI renders the part as an indented node tree beneath the assistant message: header row `Jev · explore-tree · <status>` with the node count, a latency/usage summary line, then each node's `actionID`, status glyph, sanitized target, confidence, and evidence paths with line refs. Child nodes indent under their parent via `parentID`; orphans and parentless chains start at the root, and cycles never hide a node. Implementation: `packages/tui/src/component/jev-tree.tsx`, wired through `PART_MAPPING` in `packages/tui/src/routes/session/index.tsx`; regression coverage in `packages/tui/test/component/jev-tree.test.tsx`.

**Statuses.** Run status is one of `running`, `completed`, `handoff`, `failed`, `cancelled`. Node status is one of `done`, `failed`, `skipped`. A `failed` run may still show `done` children — the ledger records what happened, not a single verdict.

**Handoff semantics.** `handoff` means the run stopped intentionally and the model continues from the recorded tree; the TUI renders a `continued by model` note next to the run's `stopReason`. Handoff is not failure and does not retry the run.

**Render budgets (display clamps, defense in depth for stored rows).** Displayed text is sanitized at the TUI boundary (ANSI and control characters stripped, collapsed to one line) and clamped: node target ≤ 120 chars, actionID ≤ 64, evidence path ≤ 200, evidence excerpt ≤ 200, `stopReason` ≤ 200. Trees with more than 8 nodes collapse to the first 8 rows plus a `+N more` line (click to expand). Node evidence, confidence, latency, and run-level usage render only when present and finite; engine-side run budgets (node/evidence counts, token caps) are owned by the coordinator implementation, not the renderer.

**Boundary validation.** The SDK regen for the `jev_run` schema lands separately, so the TUI validates the wire shape itself: a local mirror type plus an `isJevRunPart` runtime guard, gated by `<Show when={data()}>`. A malformed part (wrong status enum, non-array or invalid nodes, invalid usage numbers) renders nothing rather than a partially trusted tree. User messages never render the ledger.

**V1-only scope.** The run ledger is wired into the V1/opencode session route only (`PART_MAPPING`), matching the V1-only scope of automatic subagent routing above. The experimental V2/core runtime does not render it.

Official contracts: [TypeSafe API](https://docs.typesafe.ai/api), [OpenRouter Jev](https://openrouter.ai/docs/guides/community/jev), [Vercel TypeSafe API](https://vercel.com/docs/ai-gateway/sdks-and-apis/typesafe). Reference implementations: [jev-use](https://github.com/shitianfang/jev-use) and [jev-ultrafast](https://github.com/browser-use/jev-ultrafast).
