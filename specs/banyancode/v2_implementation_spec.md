# BanyanCode semantic tools v2 — implementation spec

> The working catalog of LLM-callable tools BanyanCode needs to build, adapt, or
> improve on top of the v26.07 source tree. Each entry is grounded in a real
> file in the repo, has an exact JSON contract the harness can mount, and
> maps to a new or existing Effect service.

The motto is still the forcing function: *every time the model reads 500 lines
of code, you failed to build a tool.* The catalog is right in shape but the
first pass oversold the count — of 41 proposed tools, **17 already exist**
under a different name, **12 are partial overlap** with existing services, and
**12 are genuinely new**. This document is the buildable 12 plus the
infrastructure bets they sit on.

Naming convention: `snake_case` to match the existing `repository_*` tool
family mounted via `packages/opencode/src/effect/banyan-tools-mount.ts:81`.
Out of scope: codegraph internals, the 8-method `RepositoryIntelligence`
surface (already exists), Claude Code skills, MCP integration, headless CLI,
incremental codegraph updates (`CodegraphAutoUpdate` is already shipped).

---

## 1. What BanyanCode already ships (don't rebuild)

These services are anti-slop-ready today. New tools should **call** them, not
re-implement them.

| Service | File | Anti-slop role |
|---|---|---|
| `Banyan.RepositoryIntelligence` | `packages/core/src/banyancode/repository-intelligence/` | 8-method public surface (`query`, `explain`, `impact`, `trace`, `tests`, `symbols`, `relationships`, `ownership`). Returns `ArchitecturalSlice`. **This is half the proposed catalog already.** |
| `Banyan.StructuralQueries` | `packages/core/src/banyancode/structural-queries.ts` | Tree-Sitter pattern matcher for routes, interfaces, overrides, imports, exports. **This is `ast_grep` under a different name.** |
| `Banyan.CodegraphReadiness` | `packages/core/src/banyancode/codegraph-readiness.ts` | Compares file mtime to `codegraph_files.indexed_at` with a 7-day threshold. Already gates `repository_intel` queries on staleness. **The pattern for LSP cache invalidation is here.** |
| `Banyan.CodegraphAutoUpdate` | `packages/core/src/banyancode/codegraph-auto-update.ts` | Incremental background graph updating on `BanyanFilesystemService` events. |
| `Banyan.CodegraphAnalyzer` | `packages/core/src/banyancode/codegraph-analyzer.ts` | L0/L1/L2/L3 layer computation, blast radius, `bfsPure` traversal. **This powers `find_referencing_symbols` and `dependency_cone`.** |
| `Banyan.MemoryService` + 6 siblings | `packages/core/src/banyancode/memory-*.ts` | `MemoryRepo`, `MemoryExtractor`, `MemoryRetrieval`, `MemoryProjection`, `MemoryHygiene`, payload versioning. **This is the working-memory layer.** |
| `Banyan.EditPlanner` | `packages/core/src/banyancode/edit-planner.ts` | Computes structural edit plans and blast radius. |
| `/global/preflight` | `packages/opencode/src/server/routes/instance/httpapi/groups/global.ts` | HTTP endpoint already exists. **Wire it as a tool; don't rebuild.** |
| `/global/blast-radius` | same | Same. |
| `/global/safe-rename` | same | Same. |
| `Banyan.Git` | `packages/core/src/banyancode/git.ts` | `Banyan.$` wrapper over bundled `git`. **Powers `git_log_search`, `git_blame_at`, `recent_changes`.** |
| `Banyan.BanyanConfigService` | `packages/core/src/banyancode/banyan-config-service.ts` | Reads/writes `banyancode.json`. The mount point for tool schema caching. |
| `codegraph_fts` (FTS5) | migration `20260707120000_codegraph_fts.ts` | BM25 search over `codegraph_nodes.name` + `code`. **This is `tree_sitter_query` (the search half).** |
| `Banyan.$` | `packages/core/src/banyancode/banyan-dollar.ts` | Child-process runner. **Powers `script_run`.** |
| `BanyanFilesystemService` | `packages/core/src/banyancode/filesystem-service.ts` | File watching. **Wired into 8 event bridges already; the `LSPF`reshness` bridge slots in here.** |
| `AppRuntime` + 8 event bridges | `packages/opencode/src/effect/app-runtime.ts` | `applyCodegraphBuildBridge`, `applyCodegraphAutoUpdateBridge`, `applyCodegraphAutoUpdateProgressBridge`, `applyFilesystemBridge`, `applyMemoryBridge`, `applyMeshBridge`, `applyReviewBridge`, `applySystemMonitorBridge`. **The 9th bridge (`applyLSPFreshnessBridge`) goes here.** |

If a tool in the v1 catalog can be satisfied by exposing one of these
services as a tool, expose it. Do not write a new service.

---

## 2. The 12 tools to build (the real gaps)

Three new services host the 12 genuinely new tools. Service names match the
existing `Banyan.X` namespace. Each tool gets a stable input/output JSON
contract the harness can mount, a `kind` enum (so the model can route), and a
truncation policy (so the response stays inside the per-call token budget).

### 2.1 `Banyan.LSPBridge` — 8 tools

LSP-backed tools. **Foundation for the whole symbol/type layer.** A
`Banyan.LSPBridge` Effect service that:

- Spawns language servers on demand: `typescript-language-server`, `pyright`,
  `gopls`, `rust-analyzer`, `clangd`.
- Keeps **warm** sessions (one per workspace per language). This is the
  latency/cost win that justifies the service: 20 sequential tool calls
  collapse to one session.
- Proxies JSON-RPC. Subscribes to `BanyanFilesystemService` events and
  forwards `workspace/didChangeWatchedFiles` to the relevant server.
- Exposes a typed Effect API: `request<TReq, TRes>(lang, method, params)`.
- Reads `banyancode_lsp` flag (existing `/lsp` slash command) and `langs/tree-sitter.ts` (existing) for startup. The bridge is a long-lived service, not a per-call spawn.

**Effort:** 1–2 weeks. **Risk:** warm-session state management + freshness
(see §4.1).

#### Tool: `hover`

Replaces "let me look at the signature" — type info and docstring at a
position.

```jsonc
// Input
{
  "relative_path": "src/auth.ts",
  "line": 42,
  "character": 18
}

// Output
{
  "contents": "function authenticate(user: User): Promise<Session>",
  "signature": "authenticate(user: User): Promise<Session>",
  "type": "Promise<Session>",
  "language": "typescript",
  "range": { "start": [42, 17], "end": [42, 28] }
}
```

- **LSP method:** `textDocument/hover`.
- **Truncation:** contents capped at 1,500 chars.
- **Reference:** Qwen Code's `lsp` tool exposes this with the same input shape, and
  recommends `workspaceSymbol` or `documentSymbol` first if the caller doesn't
  know the exact position.
- **Service:** `Banyan.LSPBridge`.

#### Tool: `signature_help`

Kills the "did I pass the right args" slop. Argument list and return type at
a call site.

```jsonc
// Input
{ "relative_path": "src/auth.ts", "line": 42, "character": 30 }

// Output
{
  "signatures": [
    {
      "label": "authenticate(user: User, options?: AuthOptions)",
      "parameters": [
        { "name": "user", "type": "User", "documentation": "The authenticated user object" },
        { "name": "options", "type": "AuthOptions?", "documentation": "Optional config" }
      ],
      "active_parameter": 0,
      "return_type": "Promise<Session>"
    }
  ]
}
```

- **LSP method:** `textDocument/signatureHelp`.
- **Truncation:** 3 signatures max, 4 params per signature.
- **Service:** `Banyan.LSPBridge`.

#### Tool: `go_to_definition`

Jump from a use to its definition.

```jsonc
// Input
{ "relative_path": "src/auth.ts", "line": 42, "character": 18 }

// Output
{
  "locations": [
    { "file": "src/auth/service.ts", "line": 88, "character": 17, "kind": "definition" }
  ]
}
```

- **LSP method:** `textDocument/definition`.
- **Service:** `Banyan.LSPBridge`.

#### Tool: `go_to_implementation`

Interface to its concrete implementations.

```jsonc
// Input
{ "relative_path": "src/auth.ts", "line": 88, "character": 17 }

// Output
{
  "locations": [
    { "file": "src/auth/jwt.ts", "line": 12, "character": 17, "kind": "implementation" },
    { "file": "src/auth/oauth.ts", "line": 8, "character": 17, "kind": "implementation" }
  ]
}
```

- **LSP method:** `textDocument/implementation`.
- **Service:** `Banyan.LSPBridge`.

#### Tool: `type_at_position`

Inferred type at an expression. Replaces "let me check the signature" for
variables, return values, and complex expressions.

```jsonc
// Input
{ "relative_path": "src/auth.ts", "line": 42, "character": 18 }

// Output
{
  "type": "Promise<Session>",
  "range": { "start": [42, 17], "end": [42, 28] }
}
```

- **LSP method:** `textDocument/typeDefinition` (returns the type's
  definition location); local inference via tree-sitter for the value side.
- **Service:** `Banyan.LSPBridge`.

#### Tool: `callable_signature`

Full signature of a function/method/constructor by name. **No position
required.** Replaces "find the function then read its declaration."

```jsonc
// Input
{ "name": "authenticate", "overload": 0, "scope": "workspace" }

// Output
{
  "signatures": [
    {
      "label": "authenticate(user: User, options?: AuthOptions): Promise<Session>",
      "parameters": [
        { "name": "user", "type": "User", "default": null, "optional": false },
        { "name": "options", "type": "AuthOptions", "default": null, "optional": true }
      ],
      "return_type": "Promise<Session>",
      "type_parameters": ["T extends User"],
      "throws": ["AuthError"]
    }
  ]
}
```

- **Implementation:** `LSP workspace/symbol` to locate, then
  `textDocument/hover` + `textDocument/signatureHelp` to extract. For
  overloads, iterate until LSP returns the next signature.
- **Service:** `Banyan.LSPBridge`.

#### Tool: `type_definition` / `supertypes` / `subtypes`

For any type, return the inheritance graph.

```jsonc
// Input (type_definition)
{ "type": "UserService", "kind": "class" }
// Output
{ "type_definition": { "file": "src/auth/service.ts", "line": 88 } }

// Input (supertypes)
{ "type": "UserService", "kind": "class" }
// Output
{ "supertypes": [{ "name": "Authenticatable", "file": "src/auth/types.ts", "line": 12 }] }

// Input (subtypes)
{ "type": "UserService", "kind": "class" }
// Output
{ "subtypes": [
  { "name": "AdminUserService", "file": "src/auth/admin.ts", "line": 15 },
  { "name": "GuestUserService", "file": "src/auth/guest.ts", "line": 8 }
] }
```

- **LSP method:** `textDocument/typeDefinition` for the single type,
  `prepareTypeHierarchy` + `supertypes` / `subtypes` for the graph.
- **Service:** `Banyan.LSPBridge`.

#### Tool: `rename_symbol`

LSP-powered rename across the project. One atomic call replaces what would
otherwise be `find_references` + N edits.

```jsonc
// Input
{ "name_path": "authenticate", "new_name": "signIn", "relative_path": "src/auth/service.ts" }

// Output
{
  "workspace_edit": {
    "file_changes": [
      {
        "file": "src/auth/service.ts",
        "edits": [
          { "range": { "start": [88, 9], "end": [88, 20] }, "new_text": "signIn" }
        ]
      },
      {
        "file": "src/auth/index.ts",
        "edits": [
          { "range": { "start": [3, 0], "end": [3, 11] }, "new_text": "signIn" }
        ]
      }
    ]
  },
  "total_edits": 2
}
```

- **LSP method:** `textDocument/rename` returns a `WorkspaceEdit`. The
  harness applies it in a transaction, then runs `preflight` (existing
  `/global/preflight` HTTP endpoint, just wire as a tool) and `typecheck`
  (new, see §2.2) before declaring success.
- **Reference:** agent-lsp's `/lsp-rename` skill does exactly this: blast-radius
  preview, user confirmation, atomic application, then verify.
- **Service:** `Banyan.LSPBridge` + harness-level edit application.

### 2.2 `Banyan.VerifierService` — 3 tools

The LLM's "did I break it" surface. **Non-negotiable rule: every output is
structured, not raw stdout.** Echoes the OpenAI Codex prompt guide and the
Microsoft Agent Framework.

A new `Banyan.VerifierService` Effect service that:
- Discovers the project's language and tooling (`tsc` / `mypy` / `pyright` /
  `cargo check` / `go vet` / `pytest` / `jest` / `vitest` / `mocha` /
  `cargo test` / `go test` / `eslint` / `ruff` / `golangci-lint` / `prettier`
  / `black` / `gofmt`).
- Invokes the right binary with the right flags.
- Parses errors with a small per-language adapter.
- Caches by `(binary_version, file_mtime_hash)`.
- Writes to `verification_runs` table (§4.2) for benchmark scoring.

**Effort:** 1 week. **Risk:** parsing parser-specific output formats (tsc
JSON exists, mypy is `text` by default — needs `--output json` or a wrapper).

#### Tool: `typecheck`

Run the project's type checker, return parsed errors.

```jsonc
// Input
{ "paths": ["src/auth.ts"], "timeout_ms": 30000 }

// Output
{
  "ok": false,
  "errors": [
    {
      "file": "src/auth.ts",
      "line": 42,
      "col": 18,
      "code": "TS2345",
      "severity": "error",
      "message": "Argument of type 'string' is not assignable to parameter of type 'User'.",
      "suggestion": "Did you mean 'user'?"
    }
  ],
  "warnings": 3,
  "duration_ms": 842
}
```

- **Implementation:** `tsc --noEmit --pretty false --project tsconfig.json`
  with JSON formatter; `mypy --output json`; `pyright --outputjson`; `cargo
  check --message-format json`; `go vet -json`. Cache by `(binary_version,
  file_mtime_hash)`.
- **Service:** `Banyan.VerifierService`.

#### Tool: `test`

Run a specific test or test file.

```jsonc
// Input
{ "pattern": "auth", "file": "src/auth.test.ts", "framework_override": "vitest" }

// Output
{
  "passed": 12,
  "failed": 1,
  "skipped": 0,
  "duration_ms": 4218,
  "results": [
    {
      "name": "should reject invalid token",
      "status": "failed",
      "duration_ms": 142,
      "message": "Expected 401, received 200",
      "stack_first_frame": "src/auth.test.ts:42:5"
    }
  ]
}
```

- **Implementation:** `pytest --json-report` (pytest-json-report plugin);
  `vitest --reporter=json`; `jest --json`; `cargo test --message-format
  json`; `go test -json`. Truncate stack traces to 10 frames.
- **Service:** `Banyan.VerifierService`.

#### Tool: `lint`

Run the project's linter.

```jsonc
// Input
{ "paths": ["src/auth.ts"] }

// Output
{
  "ok": false,
  "diagnostics": [
    {
      "file": "src/auth.ts",
      "line": 42,
      "col": 18,
      "rule": "no-unused-vars",
      "severity": "warning",
      "message": "'user' is defined but never used.",
      "fix": { "range": [[42, 0], [42, 35]], "new_text": "" }
    }
  ]
}
```

- **Implementation:** ESLint (`--format json`), Ruff (`--output-format json`),
  golangci-lint (`--out-format json`). All three output JSON. SARIF accepted
  for tools that only emit SARIF.
- **Service:** `Banyan.VerifierService`.

### 2.3 `Banyan.RepoMapService` — 1 tool

Token-budgeted, PageRank-ranked outline of the most structurally central
symbols in the project, re-seeded from any files the agent is currently
working in. The Aider pattern.

**Effort:** 3 days.

#### Tool: `repo_map`

```jsonc
// Input
{
  "chat_files": ["src/auth.ts"],
  "mention_files": [],
  "mention_idents": ["UserService"],
  "token_budget": 1024,
  "lang": "typescript"
}

// Output
{
  "tags": [
    { "name": "UserService", "kind": "class", "file": "src/auth/service.ts", "line": 88, "signature": "class UserService extends Authenticatable" },
    { "name": "authenticate", "kind": "method", "file": "src/auth/service.ts", "line": 92, "signature": "authenticate(user: User): Promise<Session>" }
  ],
  "tokens_used": 987,
  "budget_hit": 1024
}
```

- **Implementation:** extract tags from `codegraph_nodes`, run personalized
  PageRank with `100 / len(chat_files)` per Aider's weighting, binary-search
  the count to fit the budget, render signatures. Edge multipliers: chat-file
  boost ×50, long-identifier boost ×10, private-symbol damp ×0.1.
  Cache by `(chat_files, file_mtime_hash)`.
- **Service:** `Banyan.RepoMapService` (new). Calls `BanyanCodeRepo` and
  reuses the in-memory `CodegraphAnalyzer` graph.

### 2.4 Deferred (not in v2 round)

| Tool | Reason |
|---|---|
| `Banyan.SemanticSearchService` (semantic_search) | `StructuralQueries` + `codegraph_fts` (BM25) cover 80%+ of the surface. Defer until the benchmark proves the gap. |
| `format_check` | Low information density (boolean answer). Build only if the benchmark shows agents skipping it. |
| `build` | High variance, low signal. Same. |
| `coverage_for_symbol` | `RepositoryIntelligence.tests` + `codegraph_edges` `kind = 'tested_by'` already exist. Expose, don't rebuild. |
| `conventions`, `package_info`, `doc_for`, `spec_for_endpoint`, `db_schema`, `summarize_file` | Real, but defer to v3. The 12 above plus the infrastructure bets are enough for a measurable benchmark delta. |

---

## 3. Adapted tools (expose existing services as new tool names)

These already exist. The work is to **mount them via
`banyan-tools-mount.ts`** with a stable contract the LLM can call. No new
service, no new code in the core.

| Tool name | Existing service to expose | Notes |
|---|---|---|
| `find_symbol` | `RepositoryIntelligence.symbols` (exact/prefix lookup) | Rename to match the catalog. |
| `get_symbols_overview` | `CodegraphReadiness` + tree-sitter indexing per file | Per-file outline. Returns `[{name, kind, line, end_line}]`. |
| `find_referencing_symbols` | `CodegraphAnalyzer.bfsPure` over `codegraph_edges` where `kind IN ('calls', 'references')` | Add missing edge kinds (`parameter`, `type`, `throw`) to the codegraph schema first. |
| `dependency_cone` | `CodegraphAnalyzer` blast radius with cycle protection | BFS over `codegraph_edges` with visited set. Reuses `RepositoryIntelligence.trace`. |
| `ast_grep` | `StructuralQueries` | **Already exists under a different name.** Re-mount with a clearer description that mentions `$MATCH` metavars. |
| `tree_sitter_query` | `codegraph_fts` (BM25) for the search half, `StructuralQueries` for the structural half | Two different things in one tool is the overlap risk — see §5.2. |
| `coverage_for_symbol` | `RepositoryIntelligence.tests` + `codegraph_edges` `kind = 'tested_by'` | Parse `coverage.json` / `lcov.info` from the last run. |
| `git_log_search` | `Banyan.Git` (existing) | `git log -S <query>` (pickaxe) or `-G <regex>`. |
| `git_blame_at` | `RepositoryIntelligence.ownership` | `git blame -L <s>,<e> <path>` with porcelain format. |
| `recent_changes` | `Banyan.Git` | `git log --stat -n N [-- path]`. |
| `diff_symbols` | `Banyan.EditPlanner` | Build per-commit codegraph snapshots, diff them. |
| `explain_symbol` | `RepositoryIntelligence.explain` | Already returns `ArchitecturalSlice`. Rename to match the catalog. |
| `preflight` | `/global/preflight` HTTP endpoint | **Already a real tool, not a proposal.** Just add it to `banyan-tools-mount.ts`. |
| `note_set` / `note_get` / `note_search` | `MemoryService` | Full lifecycle already exists: candidates → active / superseded / rejected. |
| `todo_write` / `todo_read` | `subagent_plans` table | Already exists per-subagent. Per-session is a thin wrapper. |
| `project_metadata` | `BanyanConfigService` + new `ProjectMetadataService` for stack detection | Hybrid: config is `BanyanConfigService`, stack is new. |
| `script_run` | `Banyan.$` | Truncation to per-stream token budget. |
| `db_schema` | `Database` service direct | Read-only `information_schema` for PG/MySQL, `pragma table_info` for SQLite. |

The single biggest win in this list is **`preflight`**. The HTTP endpoint
exists, the logic exists, it's just not mounted as a tool. Half a day of
work, immediate agent capability gain.

---

## 4. Infrastructure bets (must land before the 12 tools above)

### 4.1 `lsp_session_invalidation` table + `applyLSPFreshnessBridge`

**Risk:** warm LSP sessions return stale `hover` / `type_at_position` /
`go_to_definition` when files change mid-session.

**Pattern that already solves this for codegraph:** `Banyan.CodegraphReadiness`
compares file mtime to `codegraph_files.indexed_at` with a 7-day threshold
and gates `repository_intel` queries on staleness. The pattern is there. The
LSPBridge just needs to be wired to it.

**New table** (migration `20260801000000_lsp_session_invalidation.ts`):

```sql
CREATE TABLE lsp_session_invalidation (
  session_id TEXT NOT NULL,
  language TEXT NOT NULL,
  file_path TEXT NOT NULL,
  mtime INTEGER NOT NULL,
  invalidated_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, file_path)
);
CREATE INDEX lsp_invalidation_mtime_idx ON lsp_session_invalidation(mtime);
```

**New service** (or extend `CodegraphReadiness`):

```typescript
// packages/core/src/banyancode/lsp-freshness.ts
export class LSPF`reshness` extends Effect.Service<LSPF`reshness`>()(
  "Banyan/LSPF`reshness`",
  {
    effect: Effect.gen(function* () {
      const fs = yield* BanyanFilesystemService;
      const repo = yield* LspInvalidationRepo;
      // Watch fs events; on file change, insert into the table
      // and tell LSPBridge to invalidate that file's buffers.
      yield* fs.changes.pipe(
        Stream.tap(change => repo.record({
          session_id, file_path: change.path, mtime: change.mtime,
          invalidated_at: Date.now()
        })),
        Stream.runFork
      );
      return { isFresh, markInvalidated, lastInvalidation };
    }),
    dependencies: [BanyanFilesystemService.Default, LspInvalidationRepo.Default]
  }
) {}
```

**New bridge** (joins the existing 8 in
`packages/opencode/src/effect/app-runtime.ts`):

```typescript
// packages/opencode/src/effect/banyancode-lsp-freshness-bridge.ts
export const applyLSPFreshnessBridge = (runtime: AppRuntime) =>
  Effect.gen(function* () {
    const fs = yield* BanyanFilesystemService;
    const lsp = yield* BanyanLSPBridge;
    const fresh = yield* LSPF`reshness`;
    yield* fs.changes.pipe(
      Stream.tap(change => lsp.invalidateBuffers(change.path)),
      Stream.runFork
    );
  }).pipe(Effect.provide(runtime));
```

**Effort:** 2–3 days. **Risk:** low — the pattern is established.

### 4.2 `verification_runs` table

The benchmark scores "did the agent verify before claiming done?" The
verifier tools need to log structured runs to a table the benchmark can
query.

**New table** (migration `20260801000001_verification_runs.ts`):

```sql
CREATE TABLE verification_runs (
  run_id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  tool TEXT NOT NULL,           -- 'typecheck' | 'test' | 'lint' | 'preflight' | ...
  paths TEXT NOT NULL,          -- JSON array
  ok INTEGER NOT NULL,          -- 0 | 1
  errors_json TEXT,             -- structured error array
  duration_ms INTEGER NOT NULL,
  ts INTEGER NOT NULL
);
CREATE INDEX verification_runs_agent_idx ON verification_runs(agent_id, ts);
CREATE INDEX verification_runs_tool_idx ON verification_runs(tool, ts);
```

**Writes happen inside `Banyan.VerifierService`** (each tool call records
a row). The benchmark joins `verification_runs` against the final agent
output to score whether the agent verified before emitting "done".

**Effort:** 1 day.

### 4.3 Progressive disclosure infrastructure

41 schemas in the system prompt is a tax. The fix is a 3-tier model that
ships with the tool registry, not the prompt:

- **Hot tier:** ~8 always-loaded. Mounted in the system prompt.
- **Warm tier:** ~12 loaded on demand (e.g. when the agent enters a
  "refactor" mode, the rename/LSP tools become available).
- **Cold tier:** remaining. Discoverable via a single `tool_search`
  meta-tool that returns a list of matching schemas. The agent calls
  `tool_search(query)`, then calls the returned tool.

**Mechanism:** extend `banyan-tools-mount.ts` to accept a `tier` field
per tool, and a `tool_search` meta-tool that filters the cold tier by
keyword. **Effort:** 2 days.

---

## 5. Improved tool descriptions (routing baked in)

The 41-tool catalog's biggest overlap risk is the three "find code" tools:
`ast_grep`, `tree_sitter_query`, `semantic_search`. A model cannot reliably
pick the right one if the descriptions all say "find code like X." The
fix is a decision tree in the description, not the code.

### 5.1 The decision tree

```
Are you searching for STRUCTURE or MEANING?
├── STRUCTURE
│   ├── Can you write it as code? (e.g. "function with $MATCH param")
│   │   └── ast_grep
│   └── No
│       └── codegraph_fts (BM25 on names + code; fallback default)
└── MEANING
    ├── Can you describe it in words?
    │   └── semantic_search
    └── No
        └── codegraph_fts
```

### 5.2 The tool descriptions that follow the tree

```typescript
// ast_grep — STRUCTURE, writeable as code
{
  name: "ast_grep",
  description: "STRUCTURE search. Use when you can write the pattern as code " +
               "with $MATCH or $NAME metavars. Examples: " +
               "'if ($X) { $Y }' finds every if-statement; " +
               "'class $C extends $P' finds every subclass. " +
               "Backed by StructuralQueries (Tree-Sitter). " +
               "If you cannot write the pattern as code, use codegraph_fts instead.",
  input: { pattern: "string (Tree-Sitter metavar pattern)", lang: "string", ... }
}

// codegraph_fts — fallback default
{
  name: "codegraph_fts",
  description: "FALLBACK search. BM25 over symbol names and source code. " +
               "Use when ast_grep is too restrictive (cannot express the pattern) " +
               "or semantic_search is unavailable. " +
               "Backed by codegraph_fts (FTS5 over codegraph_nodes.name + code). " +
               "Examples: 'UserService' finds symbols by name; " +
               "'async function returning Promise' finds by code body.",
  input: { query: "string", scope: "{path_prefix?, exclude?}", limit: "number" }
}

// semantic_search — MEANING, expressible in words
{
  name: "semantic_search",
  description: "MEANING search. Use when you can describe the code in natural " +
               "language but cannot write a pattern. " +
               "Examples: 'authentication middleware', 'database connection pooling'. " +
               "Backed by a vector index over code chunks. " +
               "Less precise than ast_grep; use as a last resort for fuzzy intent. " +
               "v2: this tool is deferred; codegraph_fts is the fallback default.",
  input: { query: "string", scope: "...", k: "number" }
}
```

The model picks; we just make the choice easy. The decision tree in the
description means the model doesn't have to know which tool exists — it
just answers the question and follows the branch.

### 5.3 The 4 anti-slop tests (every tool must pass)

1. **Structured.** Returns a JSON object, never raw text, with stable keys.
2. **Bounded.** Bodies truncated to a per-call token cap; agent gets a
   clear re-call path for the full content (`…N chars truncated; re-call
   with … for full body`).
3. **Composable.** One tool's output is another's input. The catalog is a
   graph, not a list.
4. **Tiered.** The tool is in the right tier (hot / warm / cold). Its
   description is enum-rich, not prose-heavy. The same description is not
   re-sent on every turn — `BanyanConfigService` should let prompt caching
   skip tool schemas like it skips skill descriptors.

The harness is anti-slop iff `find_symbol` returns in one LSP call instead
of twenty. The LLM is anti-slop iff it reaches for `find_symbol` before
`read_file`.

---

## 6. Sequencing and timeline

| Week | What lands | Risk |
|---|---|---|
| 1 | `Banyan.LSPBridge` skeleton + `hover` + `signature_help` + `lsp_session_invalidation` table + `applyLSPFreshnessBridge` | Warm session state. Mitigate with the freshness bridge in week 1. |
| 2 | `go_to_definition` + `go_to_implementation` + `type_at_position` + `callable_signature` + `type_definition` + `rename_symbol` | LSP method coverage. Mitigate by failing soft to `CodegraphAnalyzer` for non-LSP languages. |
| 3 | `Banyan.VerifierService` + `typecheck` + `test` + `lint` + `verification_runs` table | Parser output formats. Mitigate with per-language adapters, JSON where available. |
| 4 | `Banyan.RepoMapService` + `repo_map` + 17 adapted tools mounted (especially `preflight`, `find_symbol`, `ast_grep`, `explain_symbol`) + progressive disclosure tier infrastructure | Description drift. Mitigate with the routing decision tree. |

**Day 1 win:** mount `preflight` (existing HTTP endpoint, half-day work).
**Day 1 infra:** add `lsp_session_invalidation` migration + `BanyanLSPBridge` skeleton so the freshness bridge has something to subscribe to.

**What this catalog does NOT do** (deliberately, in v2):

- A generic `read_file` tool. The whole point is the LLM should not be
  reading files. `read_file` exists in `BanyanFilesystemService` already;
  the catalog above is what the LLM should reach for *instead*, with
  `read_file` as a last resort.
- A new `find_file` tool. The catalog has structural / semantic search
  (faster, more semantic) and `codegraph_fts` (faster, more accurate than
  grep). The agent should not need filename search.
- A vector store service. `Banyan.SemanticSearchService` is deferred
  until the benchmark proves BM25 isn't enough.
- Per-tool permission UI. The 8 bridges in `app-runtime.ts` already
  auto-grant for `codegraph_*`, `repository_*`, `edit_plan`,
  `code_find`, `websearch_free`. The 12 new tools should join that list.

---

## 7. What this catalog is wrong about (open questions)

These are the questions the benchmark should answer before the catalog
moves to v3.

1. **Is 8 hot + 12 warm the right split?** The benchmark will measure
   tool-call hit rate by tier. If agents rarely reach the warm tier, push
   more to cold and reduce hot. If they trip over the 8 hot tools
   calling sequence, push some down to warm.

2. **Does `repo_map` beat `repository_explain` for navigation?** Both
   are workspace-level; `repo_map` is token-budgeted, `repository_explain`
   is per-symbol. The benchmark will show which the agent reaches for
   first on "where is X" questions.

3. **Does `tool_search` actually save tokens?** If the cold tier
   description is 200 tokens and the meta-tool is 50 tokens, the savings
   only kick in past a 4:1 cold:hot ratio. Below that, just ship them
   all hot.

4. **Does the freshness bridge actually keep LSP correct?** If
   `hover` still returns stale results, the fix is shorter cache TTLs
   (1s?) or per-file session restart, not the bridge. Measure
   `lsp_session_invalidation.invalidated_at - file.mtime` distribution
   in the benchmark.

5. **Are the verification tools actually called?** `verification_runs`
   counts per agent. If agents skip `typecheck` before claiming done,
   that's a prompt problem, not a tool problem. The infra has to exist
   first so the benchmark can detect the failure mode.

---

## 8. File-pointing index (where each piece lives)

| Component | File |
|---|---|
| Existing tool mount registry | `packages/opencode/src/effect/banyan-tools-mount.ts` |
| App runtime + 8 bridges | `packages/opencode/src/effect/app-runtime.ts` |
| Existing repo intel CLI | `packages/opencode/src/cli/cmd/repository.ts` |
| Existing codegraph CLI | `packages/opencode/src/cli/cmd/codegraph.ts` |
| Existing memory CLI | `packages/opencode/src/cli/cmd/memory.ts` |
| Codegraph readiness pattern | `packages/core/src/banyancode/codegraph-readiness.ts` |
| Codegraph analyzer (bfsPure) | `packages/core/src/banyancode/codegraph-analyzer.ts` |
| Repository intelligence | `packages/core/src/banyancode/repository-intelligence/` |
| Structural queries | `packages/core/src/banyancode/structural-queries.ts` |
| Memory service (6 siblings) | `packages/core/src/banyancode/memory-*.ts` |
| BanyanConfigService | `packages/core/src/banyancode/banyan-config-service.ts` |
| Filesystem service | `packages/core/src/banyancode/filesystem-service.ts` |
| Schema definitions | `packages/core/src/banyancode/*.sql.ts` |
| Migration files | `packages/core/src/database/migration/2026*.ts` |
| BanyanConfig.Info (banyancode.json) | `packages/core/src/v1/config/banyan-config.ts` |

---

## 9. References

The work above stands on the v1 catalog (`final_turn_001.md` in this
directory), grounded in the BanyanCode v26.07 architecture document
(`packages/core/src/banyancode/` and `banyan-tools-mount.ts`),
`banyancode/src/effect/app-runtime.ts:180-181`, and the existing service
table in §1. The v2 visual deck (`banyan_anti_slop_tools_v2.pdf`) is
the executive-summary version of this document.

For the v1 catalog, see `final_turn_001.md` (37,814 bytes, 357 lines, 26
references). For the executive v2 deck, see
`/workspace/visuals/banyan-anti-slop-tools/banyan_anti_slop_tools_v2.pdf`
and `.pptx`.
