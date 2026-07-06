# BanyanCode — Tool Research & Roadmap

> **Status (2026-07-07):** The "Codegraph Gaps to Fill" section below (lines 504-545) has been **addressed or actively refactored into live code** in the intervening phases. For current implementation details see `packages/core/src/banyancode/codegraph-indexer.ts`, `packages/core/src/banyancode/codegraph-build-service.ts`, and `packages/core/src/banyancode/search/layer.ts`. New follow-up work is tracked in `specs/banyancode/codegraph-hardening.md` (the active engineering contract).
>
> A prior spec at this path — `specs/banyancode/future.md` (8-phase "Semantic Tools Future Improvements") — has been **deleted** because all 8 phases are now implemented in the live code (auto-build on empty graph, staleness hints, output truncation, signal cascade, workflow helpers, real graph/git/workspace signals, etc.). Future phase work lives in `codegraph-hardening.md`.

**Philosophy**: Models are like humans with only a text editor and no plugins — they're "blind" in a real codebase. BanyanCode's job is to be a **heavy IDE** for the agent: every tool a senior engineer reaches for, exposed as a structured tool the agent can call.

---

## Design Constraints (Non-Negotiable)

### Constraint 1: No Terminal Wrappers
A tool must do work the agent would have a hard time doing itself. If `bash "command --json" | jq` solves it, don't build a tool. Build a tool when bash is **broken, slow, or impossible**:
- AST-level analysis (correctness matters)
- Multi-source synthesis (4+ tool calls + reasoning)
- Real-time streaming (events, not polls)

### Constraint 2: Language Independence
BanyanCode repos contain TypeScript, Python, Go, Rust, Java, Ruby, Markdown, Docker, JSON/YAML — anything the codegraph can index. **No tool should be TypeScript-only.** No `ts-morph` dependency in the tool layer.

### Constraint 3: Codegraph as Foundation
Every new tool should **leverage the existing codegraph** where possible. The codegraph already provides:
- Symbol nodes (kind, name, signature, file, lines)
- Edges (calls, imports, references)
- File metadata (path, language, content hash)
- Search/structural queries (TS, Python, Docker, Markdown parsers)

Adding tools means **adding queries/operations on top of the graph**, not building parallel infrastructure. If a tool needs data the graph doesn't have, **extend the graph first**, then build the tool.

---

## What BanyanCode Has Today (Sanity Check)

Existing tool surface:
- File ops: `read`, `write`, `edit`, `edit_plan`, `glob`, `grep`
- Semantic: `codegraph_build/query/search/callers/dependents/impact`, `repository_query/explain/trace/tests`, `code_find`
- Process: `bash`, `task` (subagents), `todowrite`
- Web: `webfetch`, `websearch_free`
- Other: `question`, `skill`, `systeminfo`

Codegraph data model (`packages/core/src/banyancode/codegraph.sql.ts`):
- `codegraph_files`: file metadata, content hash, language
- `codegraph_nodes`: symbols (kind, name, signature, start_line, end_line, code)
- `codegraph_edges`: relationships (from_node_id, to_node_id, kind)

Supported parsers: TypeScript, Python, Docker, Markdown (regex-based).

**Gap**: No AST-level mutation tools, no multi-source synthesis tools, no real-time streams. Most of the proposed tools below are net-new categories that should compose with the existing graph.

---

## What the Industry Has Today

Surveyed: **Devin**, **Cursor**, **Claude Code**, **Aider**, **Cline**, **Continue**, **Factory.ai**.

| Agent | Tools Exposed | Notable |
|-------|---------------|---------|
| Claude Code | Bash, Glob, Grep, LS, Read, Edit, MultiEdit, Write, WebFetch, WebSearch | Minimal — relies on subagent delegation |
| Devin | Shell, IDE, Browser, PR Review | Cloud sandbox, full IDE in browser |
| Cursor | Code editing + semantic embeddings + agent orchestration | 12.5% accuracy boost from semantic search |
| Factory.ai | "Agent Readiness" framework | Linters, type checkers, formatters as first-class tools |

**Common pattern**: Every mature agent ships **deterministic feedback loops** and **codebase awareness**. The gap is **structured tools**, not "smarter" prompts.

---

## REJECTED — Just Terminal Wrappers

| Tool | Why rejected |
|------|-------------|
| `lint` | `bash "eslint --format json"` already works |
| `typecheck` | `bash "tsc --noEmit --pretty false"` already works |
| `test` | `bash "bun test --reporter=json"` already works |
| `format` | `bash "prettier --check"` already works |
| `git_blame` | `bash "git blame file.ts"` already works |
| `git_log` | `bash "git log --oneline"` already works |
| `dep_audit` | `bash "npm audit --json"` already works |
| `version_check` | `bash "npm outdated --json"` already works |
| `package_info` | `bash "npm view pkg versions"` already works |
| `dep_tree` | `bash "npm list --all"` already works |
| `port_check` | `bash "lsof -i :3000"` already works |
| `process_list` | `bash "ps aux"` already works |
| `coverage_report` | `bash "vitest run --coverage"` already works |

**Verdict**: Don't build. Ship a `bash` cookbook / preset commands skill instead.

---

## PROPOSED — Tools That Do Real Work

### 🔴 TIER 1 — Graph-Aware Refactoring (the agent literally cannot do this)

These leverage the codegraph's symbol + edge data to make safe, cross-file refactors. They are not "edit and hope" — they are graph-driven.

**Codegraph leverage**: Each tool queries `codegraph_nodes` for symbols by name across **all languages**, then uses the graph edges to find references. The existing parser infrastructure (TS, Python, Docker, Markdown) already extracts the symbols and references.

**Language-independence strategy**: Tools operate on **graph data**, not raw ASTs. Any language the parser supports (TS today, more tomorrow) gets refactoring for free.

#### `rename_symbol`
```ts
rename_symbol({
  symbol: string,
  newName: string,
  scope?: { file?: string, language?: string },
  dryRun?: boolean
})
// Returns:
// {
//   found: { symbol, file, line, kind, language },
//   references: [{ file, line, kind, context }],  // from graph edges
//   filesToEdit: [...],
//   renamePlan: [{ file, oldString, newString }],
//   conflicts: [{ file, reason }],  // e.g. name collision
//   applied: boolean
// }
```

**How it works**:
1. `codegraph_query(function: symbol)` → find target nodes
2. For each node, traverse incoming edges (`calls`, `imports`, `references`) → find all references
3. For each file in references, generate `old_string → new_string` edits using **the symbol's exact signature** from the graph (avoids false matches)
4. Apply edits atomically; if any fails, rollback
5. Verify by re-querying graph; if symbol still exists, report partial success

**Why language-independent**: Graph has `language` column. We rename in any language the graph understands. TS regex parser finds `import { oldName } from ...`, Python parser finds `from module import oldName`, etc.

**Why agent can't do this safely**: `grep -l "\\boldName\\b"` + sed across files would:
- Match local variables with same name in unrelated scopes
- Match string literals containing the name
- Break imports (just replaces the imported name, not the import statement)
- Miss qualified references (`module.oldName`)

The graph avoids all of these by knowing what's a real reference vs. coincidence.

#### `move_symbol`
```ts
move_symbol({
  symbol: string,
  toFile: string,
  updateReferences?: boolean,
  dryRun?: boolean
})
// Returns:
// {
//   moved: true,
//   fromFile: string,
//   toFile: string,
//   referencesUpdated: number,
//   importsRewritten: [{ file, oldImport, newImport }],
//   conflicts: [...]
// }
```

**How it works**:
1. Locate symbol node via codegraph
2. Find all incoming `imports`/`references` edges
3. For each referencing file, generate new import path
4. Apply moves + edit references atomically

**Why language-independent**: Path-resolution differs by language, but the graph nodes already encode the file + symbol. New importers are added per-language via the parser's existing reference detection.

#### `extract_function`
```ts
extract_function({
  file: string,
  startLine: number,
  endLine: number,
  newName: string,
  destination?: string
})
// Returns: { extracted: true, parameters: [...], referencesUpdated: number }
```

**How it works**:
1. Read the file content from graph's `code` field for the target node
2. Identify local variables used in the range (graph knows each node's scope via... well, not yet — see "Graph Gaps" below)
3. Generate parameter list
4. Create new function node in codegraph
5. Replace original block with a call site
6. Add edge from call site to new function

**Graph gap**: BanyanCode's graph doesn't currently track scope-local variables. Either:
- Extend the graph with `local_variable` nodes, or
- Use a lightweight per-language parser pass at extract time (still language-independent via pluggable parsers)

#### `inline_symbol`
```ts
inline_symbol({ symbol: string, file: string })
// Returns: { inlined: number, removed: true }
```

Reverse of extract. Find all call sites via graph edges, replace with function body, delete the function node.

#### `change_signature`
```ts
change_signature({
  symbol: string,
  newParams: { name: string, type?: string, default?: string }[],
  dryRun?: boolean
})
// Returns:
// {
//   found: { symbol, oldSignature },
//   callSites: [{ file, line, currentArgs }],
//   updatePlan: [{ file, oldString, newString }],
//   conflicts: [...]  // call sites that need explicit args
// }
```

**How it works**: Use graph edges to find call sites. Generate per-call-site rewrites (add defaults, reorder args).

---

### 🟠 TIER 2 — Graph-Enhanced Static Analysis

These compute metrics that **require graph connectivity** to be correct.

#### `find_dead_code`
```ts
find_dead_code({
  scope?: { language?: string, file?: string },
  includeExported?: boolean,
  includeTests?: boolean
})
// Returns:
// {
//   unusedSymbols: [{
//     symbol, file, line, kind, language,
//     reason: "no-references" | "exported-but-unused" | "test-only"
//   }],
//   unreachableFiles: [{ file, reason }],
//   summary: { total: number, byLanguage: {...}, byKind: {...} }
// }
```

**Codegraph leverage**: This is **purely graph-derived**.
- "Unused" = no incoming edges (except self-loops)
- "Exported but unused" = node has kind=`export` AND no incoming `imports` edges from outside its own file
- "Unreachable file" = no incoming edges from `imports` AND no `entry-point` marker

**Why language-independent**: Graph is the source of truth. Works for any language with edges. Today: TS, Python, Docker, Markdown. Tomorrow: Go, Rust, etc. for free.

**Why agent can't do this easily**: Agent could `grep` for exports + `grep` for usages, but cross-file imports in TS/Python/Go all use different syntax. The graph abstracts this.

#### `complexity_report`
```ts
complexity_report({
  file?: string,
  thresholds?: { cyclomatic?: number, cognitive?: number, lines?: number }
})
// Returns:
// {
//   functions: [{
//     symbol, file, startLine, endLine, language,
//     cyclomatic,    // from graph: branches in code
//     cognitive,     // nested complexity
//     lines,
//     parameters: number,
//     overThreshold: string[]
//   }],
//   summary: { overThreshold: number, avgCyclomatic: number }
// }
```

**Codegraph leverage**: Each function node has `start_line`/`end_line`/`code`. For complexity:
- `cyclomatic` = count of branching tokens in `code` field (`if`, `for`, `while`, `case`, `&&`, `||`, `catch`, `?`)
- `cognitive` = cyclomatic + nesting penalty (count brace depth at each branch)
- `lines` = `end_line - start_line`
- `parameters` = parsed from `signature` field (already extracted by parsers)

**Why language-independent**: Branching keywords differ slightly per language but the regex patterns are well-known. The graph's `code` field is already populated for every symbol node.

**Why agent can't do this**: Counting branches in a function body requires parsing the function body. Agent could `grep -c` but doesn't track nesting depth.

#### `code_smells`
```ts
code_smells({
  scope?: { language?: string, file?: string },
  kinds?: ("long-method"|"long-params"|"feature-envy"|"shotgun-surgery"|"data-clump"|"primitive-obsession")[]
})
// Returns: { smells: [{ kind, severity, file, line, message, suggestion }] }
```

Detection strategies (all graph-derived or graph-assisted):
- **long-method**: `lines > 50` per function node
- **long-params**: parameter count > 5 (from `signature` field)
- **feature-envy**: function uses more symbols from another file than its own (count `references` edges by target file)
- **shotgun-surgery**: small change to one symbol causes many edits (inverse — when a symbol has many callers AND the change touches many unrelated areas; this is a `diff_summary` signal really)
- **data-clump**: same parameter groups appearing in many function signatures (group by signature prefix)
- **primitive-obsession**: parameters/returns with primitive types where a domain type would be clearer (heuristic on signature strings)

**Why language-independent**: All based on graph data + signature strings.

---

### 🟡 TIER 3 — Multi-Source Synthesis (combine codegraph + git + filesystem)

These tools answer questions that require **2+ sources** synthesized. Agent could call 4+ tools and synthesize manually, but the synthesis is the value.

#### `diff_summary`
```ts
diff_summary({ base?: string, head?: string })
// Returns:
// {
//   files: [{ path, language, additions, deletions, status, riskScore }],
//   changedSymbols: [{ symbol, kind, file, language }],
//   rippleEffects: [{ symbol, callers, testCoverage }],
//   affectedTests: [...],
//   uncoveredChanges: [...],   // changed code with no test
//   totalRisk: number,          // 0-100
//   recommendation: "low-risk" | "review-needed" | "high-risk"
// }
```

**Codegraph leverage**: For each changed file:
1. `git diff --name-only base head` → changed files
2. For each file, `codegraph_query(file: ...)` → changed symbols
3. For each symbol, `codegraph_callers(nodeID)` → ripple effects
4. `codegraph_tests(symbol)` → affected tests
5. Cross-reference test results — uncovered = changed symbol with no test

**Why language-independent**: Works on any language in the graph.

#### `pr_review`
```ts
pr_review({ base: string, head: string, focus?: string[] })
// Returns:
// {
//   summary: string,
//   issues: [
//     { severity, file, line, kind, message, suggestion }
//   ],
//   approved: [{ area, reason }],
//   concerns: [{ kind, file, message }],
//   testsRecommended: [...]
// }
```

**Multi-source synthesis**: `diff_summary` + `codegraph_impact` + style/convention heuristics + test coverage gaps.

**Why language-independent**: All sources are language-neutral.

#### `explain_decision`
```ts
explain_decision({ symbol: string })
// Returns:
// {
//   target: { symbol, file, line, kind, signature },
//   history: [{ commit, author, date, message }],
//   authorship: { primary, contributors: [...], age },
//   callers: [...],          // from codegraph
//   tests: [...],            // from codegraph_tests
//   docs: [...],             // from grep across *.md
//   related: [...],          // git log --follow
//   rationale: string        // synthesized
// }
```

**Codegraph leverage**: `codegraph_query` + `codegraph_callers` + `codegraph_tests`. Combine with `git log` and `git blame` (bash is fine for those).

**Why language-independent**: Symbol resolution is via graph.

#### `env_audit`
```ts
env_audit()
// Returns:
// {
//   referenced: [{ key, usedIn: [{ file, line, language }] }],   // from grep across codegraph files
//   defined: [...],         // from .env, .env.example
//   missing: [...],         // referenced but not defined
//   unused: [...],          // defined but never referenced
//   inconsistent: [...]     // .env vs .env.example differences
// }
```

**Codegraph leverage**: Iterate `codegraph_files` (knows language) and scan each file's content for env-var references. Language-specific patterns:
- TS/JS: `process.env.X`, `import.meta.env.X`
- Python: `os.environ["X"]`, `os.getenv("X")`
- Go: `os.Getenv("X")`
- Rust: `env::var("X")`
- Ruby: `ENV["X"]`

The patterns are simple regexes — language independence via pattern table, not AST.

**Why agent can't do this**: Needs to scan every file with the right pattern per language, then diff against `.env`. ~10 tool calls of grep with different patterns + synthesis.

#### `project_conventions`
```ts
project_conventions({ file?: string })
// Returns: { conventions: [{ source: string, rule: string, scope?: string }] }
```

**Reads**: AGENTS.md, CONTRIBUTING.md, README.md, .editorconfig, biome.json, eslint, tsconfig, package.json scripts.

**Codegraph leverage**: For conventions found in `AGENTS.md`, link them to relevant codegraph nodes (e.g. a rule "use Context.Service pattern" → list all classes extending Context.Service).

**Why language-independent**: All sources are config/docs.

---

### 🟢 TIER 4 — Real-Time Awareness (streaming, agent can't poll)

#### `file_changes` (stream)
```ts
file_changes({ since?: string, subscribe?: boolean })
// Returns: { events: [{ path, type, language, timestamp, hash, author? }] }
// Or stream: subscribe=true → continuous delivery via @parcel/watcher
```

**Codegraph leverage**: When a file event arrives, **invalidate cached graph entries** for that file. Optionally trigger incremental re-index.

**Why language-independent**: Just file paths. Language comes from the existing graph's `language` column.

#### `lsp_diagnostics` (stream)
```ts
lsp_diagnostics({ file?: string, subscribe?: boolean })
// Returns: { diagnostics: [{ file, line, column, severity, source, message, code }] }
```

LSP integration. Streams errors as files save. LSP already exists in repo per AGENTS.md.

**Why language-independent**: LSP servers exist for many languages. BanyanCode picks the right one based on file extension (graph already has `language`).

#### `process_events` (stream)
```ts
process_events({ pattern: string, subscribe?: boolean })
// Returns: { events: [{ pid, event, timestamp, data }] }
```

Watch dev server, build process, get crash events.

---

### 🔵 TIER 5 — Domain Tools

#### `gen_docs`
```ts
gen_docs({ file?: string, format?: "tsdoc" | "jsdoc", onlyMissing?: boolean })
// Returns: { generated: number, existing: number, files: [...] }
```

**Codegraph leverage**: For each symbol node without a doc comment:
- Use `signature` field (already extracted by parsers)
- Generate doc from parameter names + return type
- Insert doc comment in the file

**Why language-independent**: Doc-comment syntax differs (`/** */` for TS/JS/Python/Go/Rust vs `#:` for Python), but the **content** is language-neutral. Pattern table per language.

#### `find_todos` (cross-file aggregation)
```ts
find_todos({
  scope?: { file?: string, language?: string },
  kinds?: ("TODO"|"FIXME"|"HACK"|"XXX"|"NOTE")[]
})
// Returns:
// {
//   items: [{
//     file, line, language, kind, message,
//     author,    // git blame
//     age,       // days since
//     status     // "fresh" | "stale" | "ancient"
//   }]
// }
```

**Codegraph leverage**: Iterate `codegraph_files` (knows language) and grep for TODO/FIXME/etc. Annotate with git metadata.

**Why language-independent**: Same comment syntax (`// TODO`, `# TODO`, `-- TODO`) works across languages via regex.

#### `flaky_tests`
```ts
flaky_tests({ pattern?: string, runs?: number })
// Returns: { flaky: [{ test, file, failureRate, lastFailure, lastSuccess }] }
```

Run tests N times, correlate results. **This one IS a bash wrapper** — but the value is in the **correlation logic**, not the run itself. Acceptable because:
- Multi-run correlation is non-trivial bash
- Result is structured (failure rate per test)
- Otherwise agent would have to write its own correlation loop

**Why language-independent**: Test framework agnostic. Whatever `bash "test runner"` returns, this tool parses + correlates.

#### `explain_diff`
```ts
explain_diff({ base: string, head: string })
// Returns:
// {
//   changes: [{ symbol, file, kind, before, after, language }],
//   semanticDiff: string,        // human-readable narrative
//   breakingChanges: [{ symbol, kind, reason }],
//   newSymbols: [...],
//   removedSymbols: [...]
// }
```

**Codegraph leverage**: For each changed file, diff the symbol set (graph nodes) between commits:
- Symbols present in head but not base = added
- Symbols present in base but not head = removed
- Symbols in both with different signatures = modified

Generate a semantic narrative ("Added `MemoryRepo.update`, removed `MemoryRepo.legacy`, changed `MemoryRepo.list` signature").

**Why language-independent**: Pure graph diff.

---

## Codegraph Gaps to Fill (Prerequisites)

Some proposed tools need graph extensions. Build these **before** the corresponding tool:

### Gap 1: Scope-local variable tracking
For `extract_function` to infer parameters correctly, the graph needs to know which local variables are used in a code range.

**Schema addition**:
```ts
// New node kind: "local-variable"
{ kind: "local-variable", name, scope: nodeID, file, line }
```

### Gap 2: Scope/containment edges
The graph needs to know "function A is inside class B" and "class B is inside module C".

**Edge addition**:
```ts
{ kind: "contains", from: parentNodeID, to: childNodeID }
```

### Gap 3: Reference kinds
Today edges have a generic `kind`. Need:
- `imports` (file-level: A imports B)
- `calls` (function-level: A calls B)
- `references` (variable/type usage)
- `extends` / `implements` (class hierarchy)
- `contains` (scope nesting)

**Currently**: Most parsers only emit `calls` and `imports`. Adding the others is a parser extension, not a schema change.

### Gap 4: File-level metadata
Already have `codegraph_files` but missing:
- `last_modified` (git)
- `last_author` (git blame)
- `test_file` boolean (derived from path pattern)
- `entry_point` boolean (referenced by `package.json` `main`/`bin`)

### Gap 5: Cross-reference deduplication
Multiple edges between the same node pair with the same kind. Add unique constraint: `(from, to, kind)`.

---

## Implementation Priority

| Phase | Tools | Codegraph prerequisites | Effort |
|-------|-------|-------------------------|--------|
| **1** | `find_dead_code`, `explain_diff`, `diff_summary` | Gap 4 (file metadata), Gap 5 | Low |
| **2** | `rename_symbol`, `move_symbol` | Gap 3 (reference kinds), Gap 5 | Medium |
| **3** | `complexity_report`, `code_smells` | None (uses existing `code` field) | Medium |
| **4** | `explain_decision`, `pr_review`, `env_audit`, `project_conventions` | None | Medium |
| **5** | `extract_function`, `inline_symbol`, `change_signature` | Gap 1, Gap 2 | High |
| **6** | `gen_docs`, `find_todos`, `flaky_tests` | None | Medium |
| **7** | `file_changes`, `lsp_diagnostics`, `process_events` (streaming) | Gap 4 (last_modified) | High |

---

## Workflow After Implementation

```
1. understand    codegraph({intent: "explain", target})
2. impact        codegraph_impact({symbol})
3. refactor      rename_symbol({symbol, newName})        ← GRAPH-DRIVEN
4. dead-code     find_dead_code({scope})                 ← GRAPH-DERIVED
5. validate      bash "bun typecheck --json"             ← JSON output, no wrapper
6. test          bash "bun test --reporter=json"
7. review        pr_review({head, base})                 ← MULTI-SOURCE SYNTHESIS
```

The agent's bash usage doesn't go away — it stays where bash is the right tool. New tools are reserved for **things bash can't do correctly**.

---

## The Three Reframings

> **No tool is a terminal wrapper.** If `bash "command --json"` works, teach the agent the flag. Don't build a tool.

> **No tool is TypeScript-only.** The graph is the source of truth. New languages get new tools for free when parsers are added.

> **No tool bypasses the codegraph.** If a tool needs data the graph doesn't have, **extend the graph first**, then build the tool. Tools compose on top of the graph; they don't replace it.

That filter cuts 30+ tool ideas down to ~15 — each one language-independent, graph-backed, and earning its place by doing work the agent gets wrong today.