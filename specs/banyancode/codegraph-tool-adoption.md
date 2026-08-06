# Codegraph Tool Adoption — Plan

## Status

Draft. Complementary to `codegraph-tools-v2.md` (pipeline quality: staleness,
full-graph loads, batched traversal — that work makes the tools *correct and
fast*). This plan addresses the separate problem that surfaced in
benchmark telemetry: the tools are **almost never called** by the model, so
pipeline quality improvements have no surface to act on. Adoption is the
bottleneck; this is the usage-side plan.

Motivating data: TerminalBench runs (95 trials, 40 with BanyanCode enabled,
model `opencode-go/deepseek-v4-flash` @ variant=max, banyancode 26.8.14):

- **8 codegraph/repository tool calls out of 2,370 total tool calls (0.34%)**.
- Only **2 of the 16** graph-family tools were ever invoked:
  `banyan_repo_map` (5 calls, one per trial, never repeated) and
  `codegraph_build` (2 calls). `code_find`, `repository_query`,
  `repository_explain`, `repository_trace`, `repository_tests`,
  `repository_impact`, `preflight`, `blast_radius`, `safe_rename`,
  `edit_plan`, `banyan_tool_search`, `banyan_test`: **0 calls**.
- The graph was built in **2 of 40** BanyanCode trials — the cold-start
  never resolves for most sessions.
- Tool mix is bash-dominated: bash 1,857 (78%), read 178, write 148,
  edit 88, grep 44. Only 3.5% of steps are tool-free.
- Directional (n=6, not proof): trials that used a graph tool passed 5/6
  (mean reward 0.833) vs 22/34 (0.647) for those that did not; cost
  identical ($0.0143 vs $0.0134).

## Goal

Raise codegraph + repository tool adoption from ~0.3% of tool calls to a
measurable, defensible share, by (a) removing the cold-start cost, (b)
making the policy actionable for small/fast models, and (c) making adoption
observable in-product so future changes can be measured. Success is a
defined metric, not a vibe: **adoption rate** (graph-family calls / total
tool calls per session, median across sessions) and **graph bootstrap rate**
(fraction of sessions that end with a built graph).

Targets (to be re-baselined after this plan lands, then tuned):

- Graph bootstrap rate: 2/40 → ≥ 90% of sessions.
- Adoption rate: 0.34% → ≥ 5% median across sessions (5x headroom below
  "graph-first" ideal; realistic for a small model).
- No regression: same or better pass rate / cost in the TerminalBench
  harness, and no cold-start latency added to interactive sessions
  (build happens in background or is capped).

## Non-goals

- No changes to the tool contracts, HTTP/SDK/LLM surfaces, or
  `Codegraph-first search policy (ALWAYS)` header text (tests pin these:
  `codegraph-system-source.test.ts:39-48,105`, `policy-background-subagents.test.ts:73-74`,
  `banyan-tool-catalog-e2e.test.ts:107`, `orchestrator.test.ts:75`).
- No vector/embedding search; FTS5 trigram + BM25 stays the substrate.
- No per-tool "nagging" or error-injection (e.g. failing bash `grep` to
  force graph tools) — fragile, hostile, and defeats the fallback contract
  in `codegraph-system-source.ts:91-94`.
- This plan does not redesign the codegraph schema or indexer (see
  `codegraph-tools-v2.md` P8 for that track).

## Root Causes (grounded in repo + telemetry)

| ID | Cause | Evidence |
|---|---|---|
| R1 | **Cold start**: the graph is built lazily, only when the model first calls a graph tool. Most sessions never make that first call, so the graph stays missing all session. | 2 `codegraph_build` calls in 40 trials; policy says "auto-trigger a build ONLY when the graph is missing" (`codegraph-system-source.ts:59-63`) but the trigger requires a graph-tool call that never happens. No session-start bootstrap exists anywhere in `packages/opencode/src/session/`. |
| R2 | **No runtime assist**: nothing in the runtime pre-warms or signals graph readiness to the model. The policy block is static text; the model cannot tell "graph ready, 1.2k symbols" from "graph absent". | `codegraph-system-source.ts` `POLICY_TEXT` is a constant; `loadImpl` only appends the per-session tool guide (`:202-208`). |
| R3 | **Salience for small models**: `deepseek-v4-flash`-class models default to the bash habit loop (grep/read/write). The policy is a wall of text at the end of the system prompt; no cost/benefit framing ("graph tool ≈ 1 call vs 3-5 bash calls"), no decision table, no "first action" instruction. | Telemetry: bash 78% of calls; `banyan_repo_map` used once per trial then abandoned — the model samples the tool, gets no reinforcing signal, and reverts. |
| R4 | **Discovery gap**: `banyan_tool_search` was never called. Cold tools stay invisible; the model only ever sees the hot catalog and its own habits. | 0 `banyan_tool_search` calls in 40 BanyanCode trials. |
| R5 | **No feedback loop**: `codegraph_tool_usage` (the table driving hot-tier promotion in `adapted-catalog.ts:65-68`) is surfaced only as a lifetime top-50 read (`global.ts:466`, tested at `tool-usage-http.test.ts`); there is no per-session adoption view (first-use latency, calls by family, bootstrap state), no TUI widget, no session metadata (also P9 in `codegraph-tools-v2.md`). The product cannot see adoption, so it cannot adapt (e.g. promote/demote tiers per model family). | `tool-usage-http.test.ts` covers only aggregate rows; no session-scoped counters anywhere. |
| R6 | **Measurement gap outside the product**: adoption is only visible through the TerminalBench telemetry pipeline (`telemetry_export.py`). No in-product counter exists, so a fix cannot be validated in CI/e2e. | No adoption metric in session metadata or `trajectory.json`. |

## Design

### Phase A — Session-start graph bootstrap (primary lever for R1)

Auto-ensure a code graph exists when a BanyanCode session starts, without
blocking first user input and without indexing giant workspaces.

1. New `ensureGraph` service in `packages/core/src/banyancode/`
   (`codegraph-bootstrap.ts`), consumed by the session-start path in
   `packages/opencode/src/session/` (alongside `session/tools.ts` and
   `session/system.ts`):
   - If a valid graph exists (readiness check via
     `codegraph-readiness.ts`, reuse the exact criteria the tools use:
     meta row, non-empty file table, root/schema match) → no-op, record
     `ready` + symbol count.
   - Else, build **in the background** with a bounded budget: cap by
     file count / size (env-tunable, e.g. `BANYANCODEGRAPH_MAX_FILES`, default
     ~10k) and a wall-clock cap (default ~60 s). On timeout or overflow:
     leave a `pending` marker and let the normal lazy auto-trigger take over
     when a graph tool is called.
   - Failures are non-fatal: log, clear the marker, session proceeds
     exactly as today.
2. Surface readiness to the model: extend `CodegraphSystemInput` with
   `graph?: { state: "ready" | "building" | "missing"; symbols?: number }`
   and have `loadImpl` append one line to the policy block, e.g.
   `Graph state: ready (1,204 symbols) — use code_find/repository_* now.`
   or `Graph state: building in background — first graph call will wait.`
   Keeps the header stable (non-goal above).
3. Guard rails: only when `BANYANCODE_ENABLE !== "0"`; no-op in read-only /
   non-workspace sessions; respect existing `codegraph_auto_update`
   disable semantics; skip when the workspace root is `/` (as in the
   benchmark harness) — the harness keeps its own explicit bootstrap
   (see Phase E).

Acceptance: in a fresh workspace, `banyancode run` + first prompt shows
`Graph state: ready` within ~30 s while the session is interactive; a
garbage workspace shows `building` and still answers; existing
readiness/policy tests pass unchanged.

### Phase B — Actionable policy for small models (R3, R4)

Rewrite the *body* of the policy block (header and routing ladder stay —
tests pin the header; the ladder is good). Changes:

1. **First-action instruction**: one explicit line at the top:
   "Session start: if Graph state is ready, call `banyan_repo_map` once to
   load the workspace outline, then `code_find` before touching files."
   (Mirrors what `banyan_repo_map`'s own description already claims:
   "Use this before reading files".)
2. **Cost framing**: add a two-line "why": one graph call replaces a
   grep+read loop; repository tools return file:line answers the model can
   edit directly. Small models respond to concrete savings.
3. **Tier disclosure**: state explicitly which tools are hot (mounted)
   vs cold (discover via `banyan_tool_search`) — currently only the hot
   tool catalog section exists; add one sentence that `code_find`,
   `repository_query`, `preflight`, `blast_radius` are hot and preferred,
   and that `banyan_tool_search` is the way to find anything else.
4. Keep the exact `## Codegraph-first search policy (ALWAYS)` header and
   the Background subagents section byte-identical.

Acceptance: `policy-background-subagents.test.ts`, `codegraph-system-source.test.ts`,
`banyan-tool-catalog-e2e.test.ts`, `orchestrator.test.ts` pass with no edits
to assertions (only fixture text updates where the body is asserted
loosely); a prompt-smoke test asserts the new first-action sentence is
present when `graph.state === "ready"` and absent when missing.

### Phase C — In-product observability (R5, R6)

1. Emit per-session adoption counters into session metadata
   (`trajectory.json` extension, additive): `graph_calls`,
   `graph_first_use_ms`, `graph_bootstrap_ms`, `build_state`. One source of
   truth: the `codegraph_tool_usage` table already records every call —
   add the session id to the row (migration, additive) and derive counters
   from it.
2. HTTP surface: extend the existing usage route (complements `global.ts:466`,
   keep the aggregate response contract; add a session-scoped variant
   `GET /tools/usage?session=<id>`) — per-session adoption: calls by family,
   first-use latency, bootstrap state. Drives the TUI widget and the
   benchmark harness.
3. TUI: one line in the BanyanCode tab — `graph 1.2k sym · 3 calls · first
   use 12s` — enough to see adoption live (this is also the live-dashboard
   data source on the TerminalBench side).
4. CI: an e2e that asserts a session with an empty workspace ends with
   `build_state=ready` and at least one `graph_calls` when the prompt asks
   a code question (mirrors `auto-codegraph.test.ts` style).

Acceptance: after a short interactive session, trajectory metadata contains
all five counters; `GET /tools/usage?session=<id>` returns the session's
family counts; the aggregate endpoint contract is unchanged (additive only).

### Phase D — Benchmark harness side (immediate, independent)

Independent of Phases A-C, ship the harness-side nudge now:

1. In `D:\TerminalBench\agents\banyancode_agent.py` (`BanyanCodeAgent.run`),
   prepend a fixed preamble to the instruction (all tasks, arm-A only):
   step 1 = run `codegraph_build` (explicit, in-container workspace);
   then prefer `code_find` / `repository_query` / `repository_trace`;
   `preflight`/`blast_radius` before risky edits. Add a `--preamble
   on|off` knob so an ablation arm can toggle it.
2. Chess task (`chess-engine-optimize` instruction.md) gets the same
   preamble automatically via the agent class — no task-prompt edits.
3. Telemetry: `telemetry_export.py` gains adoption columns (graph-family
   calls per trial, `codegraph_used` already exists) and a `--preamble`
   column so arm splits are analyzable.

Acceptance: one Harbor run of the existing 34-task subset with preamble on
vs off shows a statistically separable adoption rate and no pass-rate
regression; chess smoke keeps working.

## Rollout

1. Phase D lands first (harness-only, zero product risk) and produces the
   adoption baseline for Phases A-C.
2. Phase A behind a feature flag (`BANYANCODEGRAPH_BOOTSTRAP`, default on)
   with the caps conservative; measure interactive latency impact.
3. Phase B ships with A (policy text references Graph state).
4. Phase C additive; no migrations beyond the additive `session_id` column.
5. Benchmarks: the 34-task subset (arm-big-c vs arm-big) after A+B; chess
   A/B already scheduled — run it with the preamble as the sole delta from
   the current state, then re-run once A+B are in.

## Acceptance Summary

- Median adoption rate ≥ 5% and bootstrap rate ≥ 90% on the 34-task subset
  with A+B+C+D all on (baseline: 0.34% / 5%).
- Zero regressions in pinned policy tests; header text unchanged.
- Interactive session latency: no user-visible block from bootstrap
  (background + caps).
- Pass rate and cost per task on the subset do not regress vs
  arm-big/arm-big-b (22/34, ~$0.36 per arm).

## Files Touched

Product (`D:\opencode`):

- `packages/core/src/banyancode/codegraph-bootstrap.ts` (new, Phase A)
- `packages/core/src/banyancode/codegraph-system-source.ts` (Phase A/B:
  graph-state line, policy body, `CodegraphSystemInput.graph`)
- `packages/opencode/src/session/system.ts` (Phase A: call `ensureGraph` on
  session start; note the V1 `legacyCodegraphPolicy()` fallback must stay
  byte-compatible)
- `packages/opencode/src/session/tools.ts` (Phase A: readiness wiring)
- `packages/core/src/banyancode/adapted-catalog.ts` (Phase C: usage rows
  keyed by session)
- `packages/opencode/src/server/routes/instance/httpapi/groups/global.ts`
  (Phase C: `GET /tools/usage`)
- `packages/tui/...` (Phase C: one-line graph widget)
- migrations (Phase C: additive `session_id` on `codegraph_tool_usage`)
- tests: `packages/opencode/test/banyancode/auto-codegraph.test.ts`
  (extend), `codegraph-system-source.test.ts`, `policy-background-subagents.test.ts`,
  new `codegraph-bootstrap.test.ts`

Harness (`D:\TerminalBench`):

- `agents/banyancode_agent.py` (Phase D preamble + flag)
- `telemetry_export.py` (adoption columns, preamble column)
- `run.sh` (arm-big-c target for the ablation)

## Risks / Open Questions

- Background build vs container CPU limits (benchmark containers are
  2-cpu): the build must yield to the agent; the wall-clock cap handles it.
- `banyan_repo_map` on huge monorepos can be slow — the readiness symbol
  count lets the model decide; cap stays env-tunable.
- Small-model ceiling: even with all levers, flash-class models may cap at
  ~5-10% adoption; the metric targets are deliberately conservative and
  re-baselined.
- Policy body rewrites risk drift against the pinned tests — keep header +
  ladder untouched and assert that in CI.
- Does the build-on-start break `codegraph_auto_update` watcher semantics?
  No: bootstrap is one-shot ensure; the watcher remains the drift
  mechanism (`codegraph-auto-update.ts:112`).
