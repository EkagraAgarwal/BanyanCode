# BanyanCode Memory (Phase 1a / 1b)

## Goal

Build a memory system that is:

- persistent across sessions
- useful for coding workflows
- explainable and inspectable
- low-noise by default
- independent of embeddings
- tightly integrated with repository intelligence

Memory should behave as a curated, versioned knowledge layer that stores only durable, high-signal facts and project decisions — not a dump of chat logs.

## Core design principle

Memory is not a single store. It is a pipeline:

1. observe what happened
2. extract candidate facts
3. filter low-value data
4. normalize into structured memory objects
5. version or merge into canonical memory
6. index for retrieval
7. retrieve only when relevant

This keeps memory compact and prevents the system from accumulating junk.

## Memory architecture

### A. Session layer

Temporary context for the current run. Lifetime: current session only.

### B. Event layer

Append-only log of important things that happened (user preference learned, architecture decision, bug discovered, file ownership inferred, feature completed, etc.). Source of truth for later projections.

### C. Canonical memory layer (the real store)

Curated, durable, structured objects: user preferences, project conventions, architectural decisions, warnings, implementation patterns, known failures, active constraints, long-lived repository facts. Editable only through controlled merge/update rules.

### D. Projection layer

Regenerable derived views: project summary, active decisions, open risks, recent changes, command cheatsheet.

### E. Repository intelligence layer (separate source of truth)

`Banyan.Search` / `Banyan.RepositoryIntelligence` already answers code-centric questions. Memory answers why / should-questions.

## Memory object model

```ts
type MemoryEnvelopeV1 = { _v: 1; data: MemoryPayloadV1 }

type MemoryPayloadV1 = {
  kind: "preference" | "identity" | "convention" | "decision" | "architecture"
       | "pattern" | "warning" | "failure" | "todo" | "observation"
       | "summary" | "ownership" | "constraint" | "environment"
  title: string
  body: string
  source: { type: "user" | "agent" | "system" | "import"; ref?: string }
  confidence: "low" | "medium" | "high"
  importance: "low" | "medium" | "high"
  status: "pending" | "active" | "superseded" | "rejected" | "expired"
  tags?: string[]
  fileRefs?: string[]
  symbolRefs?: string[]
  supersedes?: string
  supersededBy?: string
  lastReferencedAt?: number
  retrievalCount?: number
}
```

The envelope (`{ _v, data }`) lives inside the existing `memory_entries.value` JSONB column. id, key, scope, version, createdAt, updatedAt, expiresAt, agentID, sessionID stay as columns so FTS triggers and filters can read them without re-parsing JSON.

Denormalized payload columns `kind`, `title`, `body`, `status` mirror the envelope so FTS content-sync sees real columns. Legacy rows (pre-Phase-1a) get a synthesized observation on read.

## Reuse map

| Concern | Existing | File |
|---|---|---|
| Table + JSONB + versioning | `memory_entries` with optimistic `version`, derived `namespace` | `packages/core/src/banyancode/memory.sql.ts` |
| Repo CRUD | `put` / `get` / `list` / `forget` / `forgetByKey` / `search` / `update` (transactional CAS) / `vacuum` | `packages/core/src/banyancode/memory-repo.ts` |
| Tools | `memory_store/recall/list/forget/search` + `shared_memory` | `packages/core/src/tool/memory.ts`, `packages/core/src/tool/shared-memory.ts` |
| Tool wiring | Merged into `BanyanTools.locationLayer` | `packages/core/src/banyancode/tools-layer.ts` |
| FTS precedent | Incremental migration + triggers + backfill | `packages/core/src/database/migration/20260707120000_codegraph_fts.ts` |
| HTTP group pattern | Separate group/handler files under `/global/*` | `packages/opencode/src/server/routes/instance/httpapi/groups/repository-intel.ts` |
| TUI tab stub | `session_tab_memory` | `packages/tui/src/feature-plugins/tabs/tab-memory.tsx` |

## Phase 1a — Storage foundation

### 1a.1 MemoryPayloadV1 envelope + denormalized columns

- `packages/core/src/banyancode/memory-payload.ts` (`encodeMemoryValue`, `unwrapMemoryValue`, `normalizeMemoryValue`, `looksLikeMemoryPayload`, Schemas).
- New migration `20260711120000_memory_payload_columns.ts`: `ALTER TABLE memory_entries ADD COLUMN kind text, title text, body text, status text NOT NULL DEFAULT 'active'` + indexes `(status, updated_at)` and `(kind, status)`.
- `MemoryRepo.put` / `update` write denormalized columns from the unwrapped payload so FTS triggers see real columns.
- Legacy raw values get wrapped as an observation; legacy rows on read are synthesized as observations.

### 1a.2 FTS5 (new migration, not fresh-libsql edit)

New migration `20260711130000_memory_entries_fts.ts` model:

```sql
CREATE VIRTUAL TABLE memory_entries_fts USING fts5(
  key, title, body, kind,
  content='memory_entries',
  content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2'
);
-- insert/delete/update triggers mirroring codegraph_fts
-- backfill: INSERT INTO memory_entries_fts(rowid, key, title, body, kind) SELECT ...
```

`MemoryRepo.searchRanked({ query, limit?, scope?, sessionID?, status?, kind? })`:

- `memory_entries_fts MATCH ?` + ORDER BY `bm25(memory_entries_fts)`
- Join to `memory_entries` for filter predicates (scope/session/status/kind)
- Returns `{ entries, totalHits }`
- Falls back to JS keyword scan if the FTS table is missing

`memory_search` tool now calls `searchRanked` and stays honest about `degraded: true` only when the FTS table is missing.

### 1a.3 HTTP + SDK + unbreak the MEMORY tab

New files:

- `packages/opencode/src/server/routes/instance/httpapi/groups/memory.ts`
- `packages/opencode/src/server/routes/instance/httpapi/handlers/memory.ts`

Endpoints under `/global/memory/*`:

| Method | Path | Purpose |
|---|---|---|
| POST | `/global/memory/list` | list with scope/prefix/tags/kind/status/limit |
| POST | `/global/memory/get` | by id |
| POST | `/global/memory/recall` | by key |
| POST | `/global/memory/search` | FTS BM25 |
| POST | `/global/memory/store` | write |
| POST | `/global/memory/forget` | delete by id or key |

Schema boundaries enforce `id` pattern `^[a-z0-9-]{4,63}$`, `key` pattern `^[a-z0-9:._-]{2,128}$`, `scope` regex, `query` `maxLength(512)`. No path-join inputs.

Regenerate SDK: `./packages/sdk/js/script/build.ts`.

Minimal TUI fix in 1a (not full rebuild): replace `(api.client as any).memory?.list` with typed `client.memory.list({ banyanMemoryListInput: { scope: "global" } })`. Keep current flat list UI until 1b.

### 1a.4 Idempotency fix

`subagent-consumer.ts` `case "plan"` reuses `id: msg.id` instead of `crypto.randomUUID()`. With `memory_entries.id` as PRIMARY KEY + `onConflictDoUpdate`, redelivery becomes a version bump (no duplicate row).

### 1a.5 Phase 1a tests

`packages/core/test/banyancode/memory-payload.test.ts`
`packages/core/test/banyancode/memory-fts.test.ts`
`packages/core/test/banyancode/subagent-consumer-idempotency.test.ts`
`packages/opencode/test/banyancode/memory-http.test.ts`

## Phase 1b — Agent gate + UX (follow-up)

### 1b.1 Candidate lifecycle on `memory_entries`

`Banyan.MemoryService` wrapping `MemoryRepo`:

- `emitCandidate(...)` → put with `status: "pending"`
- `promote({ id, expectedVersion })` → transaction: mark conflicting active superseded, set this row active
- `reject({ id, expectedVersion })` → `status: "rejected"`
- `listCandidates({ status?, limit? })`

HTTP additions: `POST /global/memory/candidates`, `POST /global/memory/promote`, `POST /global/memory/reject`.

### 1b.2 Tools + write gates

- New tool `memory_candidate_emit` in `packages/core/src/tool/memory-candidate.ts`, registered in `tools-layer.ts`.
- `memory_store` + `shared_memory` write with `scope: "global"`: allow only if `context.agent` is `build` or `orchestrator`; otherwise `ToolFailure` pointing at `memory_candidate_emit`.
- Permission asserts use real `context.sessionID` / `context.agent` (drop `"" as any`).
- Wrap tool bodies in `traced(...)`.
- Prompt one-liner in subagent agent defs: use `memory_candidate_emit` for durable facts.

### 1b.3 Events + bridge

`packages/core/src/banyancode/memory-events.ts`:

- `banyancode.memory.committed`
- `banyancode.memory.candidate_emitted`
- `banyancode.memory.promoted`
- `banyancode.memory.rejected`

Published from `MemoryService` only. Bridge `banyancode-memory-bridge.ts` mirrors codegraph-bridge (bounded queue, single `forkDetach` drain, no second consumer in the service layer).

### 1b.4 TUI rebuild

Rebuild `tab-memory.tsx`:

- Scope / kind / status filters
- Accordion sections by kind + Pending candidates section
- Rows: key, version, status glyph, 80-char body, age
- Detail via `DialogAlert` (pretty JSON + metadata)
- Forget via `DialogConfirm` → `memory.forget`
- Promote/Reject on pending rows
- `createResource` + `event.on("banyancode.memory.*")` + `onCleanup`
- `EmptyState` for empty/loading/error

### 1b.5 Slash + CLI

Slash: `/memory-recall`, `/memory-add`, `/memory-search`, `/memory-pending`, `/memory-forget`.

CLI `opencode memory` (`instance: false`):

- `list`, `get`, `search`, `recall`, `store`, `forget`, `candidates list|approve|reject`, `vacuum`

No `export` yet (Phase 6).

### 1b.6 Tests

Candidate service, tool permission gates, events (drain like bridge), tab-memory, CLI/slash smoke.

## Phases 2–6 (later)

- **Phase 2 — Extraction:** significance scoring, dedupe via `Hash.fast`, Levenshtein merge, per-kind confidence gates.
- **Phase 3 — Retrieval:** `MemoryRetrievalService` intent routing (code → codegraph first; history/preference/continuation → memory), BM25 + tag overlap + recency + importance + agent role ranking.
- **Phase 4 — Projections:** regenerable session/project summaries, warning digests, decision digests.
- **Phase 5 — Agent integration:** allowlist in `BanyanConfig` (widen beyond build/orchestrator), session-start system prompt injection.
- **Phase 6 — Hygiene:** `compact`, `reconcile`, `prune`, `export`, retrieval usefulness counters.

## Out of scope for Phase 1a/1b

- Embeddings / vector search
- Automatic extraction from chat transcripts
- Projections / session summaries
- `memory_export` / compact / reconcile / prune
- Changing codegraph or repository-intelligence APIs
- Plugin-SDK "memory hook" (memory stays Banyan-native services + tools)