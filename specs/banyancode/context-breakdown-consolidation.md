# Context breakdown consolidation (14 rows → 6 categories)

Status: approved for build. Supersedes the "labeled context sources" rows added in `7496a1c` / `3a0c29f`.

## Problem

The TUI CONTEXT widget (`packages/tui/src/feature-plugins/sidebar/context.tsx`) renders 14
segment rows plus a Cache legend row. The largest bucket, "Overhead" (`context.tsx:237`),
is a residual: `max(0, basis - heuristicBuckets - breakdownTotal)`. Its biggest unmeasured
component is **tool definitions/schemas** — the `tools` object is passed to the request
(`prompt.ts:1448`) but never token-estimated. Users see a giant unlabeled bucket (observed:
206.5k / 64.2% of context). Legend percentages can sum past 100% because `total` includes
cache tokens that are also inside the input-side rows (`context.tsx:255`, `:485`).

## Target: 6 categories, honest attribution

| Row | Contents | Source |
|---|---|---|
| System | base + agent + user-system + environment + instructions + skills + structuredOutput | provider breakdown keys merged |
| Codegraph & Orchestration | codegraph + orchestration | provider breakdown keys merged |
| Tool Definitions | new provider `systemBreakdown.tools` key | NEW provider estimate |
| Tool Calls | tool-part tokens (args/results) | TUI heuristic `sumToolTokens` (`context.tsx:50-89`) |
| Files | file-content tool parts | TUI heuristic |
| Conversation | user messages + thinking + output | TUI heuristics |
| Subagents | task spawn prompt tokens | TUI heuristic `taskSpawnPromptTokens` |

Naming deliberately distinguishes **Tool Definitions** from **Tool Calls** so users don't
interpret "Tools" as all tool-related context.

## Provider change (`packages/opencode/src/session/prompt.ts`)

In the `systemBreakdown` block (`prompt.ts:1425-1451`), add:

```ts
if (tools.length) systemBreakdown.tools = estimateTokens(JSON.stringify(tools.map((t) => t.definition)))
```

- `tools` is the assembled defs array already passed to `handle.process` at `prompt.ts:1448`.
- Verify the schema field name (`definition`) against `Tool.Def`; use it if present.
- Schema stays free-form `Record<string, number>` (`packages/core/src/v1/session.ts:246`) —
  no SDK regen, no migration.

## TUI change (`packages/tui/src/feature-plugins/sidebar/context.tsx`)

1. Replace `BREAKDOWN_LABELS` (`:271-281`) with a merge map: which provider keys fold into
   System vs Codegraph & Orchestration; `tools` gets its own row.
2. Row assembly (`:333-367`): the 7 rows above (6 categories, Tools split into two named rows).
3. Residual logic — show "Other" ONLY when it is genuinely unaccounted, never negative:

```ts
const accounted = segments.reduce((sum, s) => sum + s.tokens, 0)
const residual = Math.max(0, basis - accounted)
if (residual / basis > 0.05) {
  segments.push({ label: "Other", tokens: residual })
}
```

4. Denominator invariant: `total` (`:255`) = exactly `input + output + reasoning` — no cache.
   Legend % = `seg.tokens / total`. This is the non-overlapping denominator; rows must
   approximately sum to it.
5. Cache: legend-only chip `128k cached · included in input` (replaces the `:474-489`
   percentage legend row). Cache is not a prompt component; it must never be a % segment.
   `cacheRead`/`cacheWrite` stay zeroed; `cache` carries the sum for the chip.

## Tests

- `packages/tui/test/feature-plugins/sidebar/context.test.tsx`:
  - consolidated rows render (System merges all 9 keys; Codegraph & Orchestration separate)
  - Tool Definitions vs Tool Calls are distinct rows
  - residual: shown when > 5% of basis, hidden when ≤ 5%, never negative
  - cache chip string, no cache % row
  - legend denominator is input + output + reasoning (assert no cache token in denominator)
- `packages/opencode/test/session/prompt.test.ts:541-569`: `tools` key present with expected
  chars/4 estimate.
- `packages/opencode/test/session/processor-effect.test.ts:290-352`: JSONB round-trip now
  carries 10 keys (9 + tools).

## Verification

- `bun typecheck` and `bun test` from `packages/opencode` and `packages/tui` (never from repo root).
- Manual: run TUI against a session with tool-heavy steps; Overhead/Other should shrink to
  ≤5% of basis or vanish.
