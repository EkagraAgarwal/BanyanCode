# BanyanCode Codegraph Hardening — Active Engineering Contract

**Status:** **PARTIALLY REVERTED 2026-07-07.** PRs 1-4 (Phase B + A + 4 of C+D) are at `main` HEAD. PRs 5-9 (TS/JS tree-sitter, Python tree-sitter, structural edges, 12 new languages, cleanup) have been **reverted** pending a `TreeSitter.layer` runtime tolerance fix (see `specs/banyancode/tool-visibility-bisect.md` for the bisect result and root cause). Re-port PRs 5-9 individually once the runtime fix lands and a CI guard (`BanyanTools.locationLayer` tool-count assertion) is in place.
**Owner:** Lead Architect (reviewer) + `@coder` subagents (implementers).
**Last updated:** 2026-07-07.

This document is the **strict contract** handed to `@coder` for execution PR by PR. It replaces the deleted `specs/banyancode/future.md` (all 8 phases of which are now live code).

---

## Background

`/codegraph-build` builds a polyglot code graph backed by Turso/libSQL. Today the indexer in `packages/core/src/banyancode/codegraph-indexer.ts` uses **4 regex parsers** (TypeScript, Python, Markdown, Docker) plus a `regex-fallback.ts` that only catches generic `function/fn/func` + `class` keywords. The hard-won lesson in `AGENTS.md:102` documents the result:

> *"Regex parsers do not throw — `parseFailure` counters stay at zero forever. The codegraph typescript/python parsers in `packages/core/src/banyancode/langs/` are pure regex. They silently produce empty node lists for malformed input... Real parse-error visibility requires migrating to a real tree-sitter (or other grammar) backend."*

Four issues need fixing:

1. **More languages and clearer relations** — the indexer advertises 21 languages in `codeExtensions` at `codegraph-indexer.ts:240-256` but 16 of them route to `parseGeneric`, which produces 0-2 nodes per file. Edges are inferred by post-walk string-scanning at `codegraph-indexer.ts:534-700` (no `implements`, no scope-aware `contains`).
2. **Number of symbols is too low** — TypeScript regex misses object methods, getters/setters, decorators, class field arrows, enums, interfaces as proper kinds, etc. Code bodies and signatures are not captured for non-class nodes.
3. **`codegraph_remove` is missing as an agent tool** — the slash command exists at `packages/opencode/src/command/index.ts:199-223` and the TUI wires it (`packages/tui/src/app.tsx:867`), but no tool is registered in `packages/core/src/tool/codegraph.ts`. Grep confirms zero hits for `codegraph_remove` in `packages/core/src/tool/`.
4. **Performance is bad** — 3,067-file workspaces take >5 min (self-acknowledged at `codegraph-indexer.ts:606`). The post-walk edge-resolution phase loads all nodes into JS, runs `code.matchAll(/\b[A-Za-z_][A-Za-z0-9_]*\b/g)` on every non-skip node, then does three more O(N×M) passes for tests/configs/routes.

---

## Architectural Decisions (locked, do not revisit without re-approval)

| # | Decision | Reason |
|---|---|---|
| AD-1 | **web-tree-sitter WASM (Option A)** for all language parsing | Consistency with existing `packages/opencode/src/tool/shell.ts:318-331` and `packages/tui/src/parsers-config.ts:1-378`; no native build step; cross-platform portability for CLI agent harnesses. |
| AD-2 | **16 MB initial / 256 MB max WASM heap** | With `maxFileSizeBytes = 1_048_576` cap, no file's AST will approach even 100 MB. Allocating larger reserves unnecessary memory boundaries across concurrent worker fibers. |
| AD-3 | **No streaming parse / no chunking** | The 1 MB hard cap excludes jumbo files. The heap config + `ALLOW_MEMORY_GROWTH=1` (default in modern web-tree-sitter prebuilts) handles 100KB-500KB source files natively. Revisit only if profiling reveals memory pressure on ~800KB files. |
| AD-4 | **Keep `regex-fallback.ts` as permanent last-resort** | Agents encounter unsupported extensions (`.nim`, custom DSLs) and malformed files. The fallback at `langs/registry.ts:55-57` ensures graceful degradation rather than pipeline exceptions. |
| AD-5 | **FTS5 sidecar table** (not denormalized per-row join) | Per the "non-destructive migrations" lesson in `AGENTS.md`, add `codegraph_fts` virtual table alongside existing tables. Avoids schema locks on `codegraph_nodes`. When tree-sitter gives us exact `calls`/`imports` edges, the FTS5 `references` path becomes a fallback for unresolved identifiers only. |
| AD-6 | **`codegraph_remove` tool defaults `dropFile: false`** | `banyancode.db` is shared with sessions, memory, and projects. Defaulting `dropFile: true` would be a catastrophic trap for an autonomous agent. Matches the slash command at `command/index.ts:213-215`. |
| AD-7 | **YOLO mode short-circuits the destructive prompt** | Per `packages/opencode/src/permission/index.ts:83`, YOLO mode skips ALL permission prompts. The `codegraph_remove` tool's permission action respects this automatically. |
| AD-8 | **Bundle `.wasm` grammar files in node_modules** | Lazy-download from GitHub releases at runtime introduces air-gapped failures, rate-limiting, and cache invalidation. 5-10 MB footprint is negligible. |
| AD-9 | **First language batch: TS + JS + Python only (PRs 5-6)** | Smaller, reviewable PRs. Proves the new structural edges and symbol extraction work end-to-end before investing in Go/Rust/Java/C-family grammars. |
| AD-10 | **Atomic doc updates in PR 4** | `README.md:11` and `ARCHITECTURE.md:101,124` claim tree-sitter today. The moment the WASM scaffold lands, architecture has formally changed. Update in the same PR as the code change. |
| AD-11 | **PR 1 scope: Core Tool + CLI + Tests only** | Decouple backend from frontend. TUI quick-action wiring is a separate UI polish task. |
| AD-12 | **No `codegraph_remove` TUI changes in PR 1** | TUI surface lives at `packages/tui/src/app.tsx:867` and `packages/tui/src/component/prompt/index.tsx:1234`. Already wired for the slash command; the new tool is the agent's path, not the user's. |

---

## Sequenced Phases

### Pre-work (PR 0 — LEAD agent executes)

- Delete `specs/banyancode/future.md` ✅ (done 2026-07-07)
- Add redirect header to `specs/banyancode/tool-research.md` ✅ (done 2026-07-07)
- Create this spec (`specs/banyancode/codegraph-hardening.md`) ✅ (done 2026-07-07)

### Phase B — `codegraph_remove` tool (PR 1)

**Fixes issue #3.** ~1 day, single PR.

See `PR 1` section below for the full `@coder` contract.

### Phase A — Performance (PRs 2-3, pruned)

**Fixes issue #4.** ~2-3 days, 2 PRs.

- **PR 2 — perf core:** A1 (parallel directory walk via work-stealing queue), A2 (stream edge resolution via cursor-paginated batches of 500), A4 (delete the redundant second regex at `codegraph-indexer.ts:560-562`), A5 (lift cache check before minified scan at line 354), A7 (skip-reason counter regression test).
- **PR 3 — FTS5 + WAL:** A3 (new migration adding `codegraph_fts` virtual table + triggers), A6 (change `CHECKPOINT_EVERY` 200→1000, switch final checkpoint to `PRAGMA wal_checkpoint(TRUNCATE)`).

**Out of scope (deferred to C):** the post-walk string-scan at `codegraph-indexer.ts:534-700`. With tree-sitter giving us exact edges at parse time, this whole phase shrinks dramatically. Don't over-optimize SQL token-joining now.

### Phase C+D Combined — Tree-sitter migration, comprehensive symbols + edges (PRs 4-9)

**Fixes issues #1, #2.** ~2 weeks, 6 PRs.

- **PR 4 — WASM scaffold + atomic docs:** Add `web-tree-sitter` + first 3 grammars to `packages/core/package.json`. Create `packages/core/src/banyancode/langs/tree-sitter.ts` with the heap config + grammar cache. Update `README.md` and `ARCHITECTURE.md` in the same PR. (Per AD-10.)
- **PR 5 — TypeScript + JavaScript:** Replace `langs/typescript.ts` regex with tree-sitter queries capturing `class`, `function`, `method`, `interface` (NEW), `type`, `enum` (NEW), `getter`/`setter`/`constructor` (NEW), `decorator`. Add `tree-sitter-javascript` for `.js`/`.jsx`/`.mjs`/`.cjs`. Capture `signature` and `code` body for every kind.
- **PR 6 — Python:** Replace `langs/python.py` (file is `.py` extension but contents are TS at `python.ts:1`) with `tree-sitter-python`. Capture decorators, dunder methods, base classes.
- **PR 7 — Structural edges:** Add `implements` and `contains` to `ParsedEdge.kind` in `langs/types.ts:30-40` (additive — `kind` column is `text` at `codegraph.sql.ts:41`, no migration). Extract edges at parse time via tree-sitter queries, not post-walk string scan. Split test files into per-`it`/`describe` blocks.
- **PR 8 — More languages:** Add grammars per AD-9 and the user-confirmed scope (SQL, HTML, CSS yes; `.sh`/`.bat`/`.ps1`/`.zig`/`.kt`/`.swift` deferred).
- **PR 9 — Cleanup + `regex-fallback` retention:** Remove the 21-language claim from `codeExtensions` for languages we don't have parsers for. Verify `README.md`/`ARCHITECTURE.md` still match.

---

## PR 1 — `codegraph_remove` tool (full @coder contract)

**Goal:** Register `codegraph_remove` as a tool the agent can call. Mirror the existing slash command at `packages/opencode/src/command/index.ts:199-223`.

**Files to modify (no others):**

1. `packages/core/src/tool/codegraph.ts` — add the tool registration
2. `packages/opencode/src/cli/cmd/codegraph.ts` — add the `remove` subcommand
3. `packages/core/test/banyancode/codegraph-remove-tool.test.ts` — new test file (mirror the pattern at `packages/core/test/banyancode/codegraph-remove.test.ts:8-123`)
4. `packages/opencode/test/banyancode/codegraph-tool-remove-http.test.ts` — new HTTP test
5. `packages/sdk/js/src/v2/gen/` (regenerated) — via `./packages/sdk/js/script/build.ts`

**Out of scope for PR 1:** TUI quick-action wiring (per AD-12). TUI slash command continues to work via `packages/opencode/src/command/index.ts:199-223` unchanged.

**Detailed instructions:**

### 1. `packages/core/src/tool/codegraph.ts`

Add to the `name_*` constants at lines 81-84:
```ts
export const name_remove = "codegraph_remove"
```

Add the input/output schemas near the other `Input*`/`Output*` definitions (e.g. after `OutputBuild` at line 117 and before `InputCodegraph` at line 119):
```ts
export const InputRemove = Schema.Struct({
  dropFile: optionalBoolean,  // default false; banyancode.db is shared
})
export const OutputRemove = Schema.Struct({
  status: Schema.Literals(["removed", "empty"]),
  sizeBefore: Schema.Number,
  sizeAfter: Schema.Number,
  freedBytes: Schema.Number,
})
```

In the `tools.register({...})` call (line 243), add `[name_remove]: Tool.make({...})` as a new entry after `[name_build]` (which ends at line 383). Mirror the structure:

```ts
[name_remove]: Tool.make({
  description:
    "Remove the current codegraph index. Use to recover from a corrupt or stale graph. " +
    "Does not delete the database file by default (banyancode.db is shared with sessions and memory).",
  contract: { visibility: "public" },
  input: InputRemove,
  output: OutputRemove,
  toModelOutput: ({ output }) => [{
    type: "text",
    text: output.status === "empty"
      ? "Codegraph index was already empty."
      : `Codegraph index removed. Freed ${output.freedBytes} bytes (${output.sizeBefore} -> ${output.sizeAfter}).`,
  }],
  execute: (input, context) =>
    traced(
      process.cwd(),
      context.sessionID,
      name_remove,
      input,
      (output) => `status=${output.status} freedBytes=${output.freedBytes}`,
      Effect.gen(function* () {
        yield* permission.assert({
          action: name_remove,
          resources: ["*"],
          save: ["*"],
          metadata: input,
          sessionID: context.sessionID,
          agent: context.agent,
          source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
        })

        const { sizeBefore, sizeAfter } = yield* repo.clearAll({ dropFile: input.dropFile ?? false })
        const freedBytes = Math.max(0, sizeBefore - sizeAfter)
        return {
          status: (sizeBefore === 0 ? "empty" : "removed") as "empty" | "removed",
          sizeBefore,
          sizeAfter,
          freedBytes,
        }
      }),
    ).pipe(
      Effect.mapError((err) => err instanceof ToolFailure ? err : new ToolFailure({ message: "codegraph_remove failed" })),
    ),
}),
```

**Critical:** The tool is registered through `tools.register(...)` like the other codegraph tools. Per `AGENTS.md` "Tool registration" rule, the executor captures the services. Do NOT add a new `tools.register` call outside the existing one at line 243.

**Note on visibility:** Make it `public` so the agent can reach it.

### 2. `packages/opencode/src/cli/cmd/codegraph.ts`

Add a `RemoveCommand` to the `.command(...)` chain at line 354-361 (where `BuildCommand`, `StatusCommand`, `CancelCommand`, `ForceKillCommand`, `PathCommand`, `TraceCommand` are wired). Mirror the existing `CancelCommand` at line 187-206:

```ts
const RemoveCommand = effectCmd({
  command: "remove",
  describe: "remove the codegraph index (preserves banyancode.db by default; pass --drop-file to also delete the file)",
  instance: false,
  builder: (yargs: Argv) =>
    yargs.option("drop-file", {
      type: "boolean",
      default: false,
      describe: "also delete the banyancode.db file (DANGEROUS: shared with sessions and memory)",
    }),
  handler: Effect.fn("Cli.codegraph.remove")(function* (args: { dropFile: boolean }) {
    const repoOpt = yield* Effect.serviceOption(Banyan.CodegraphRepo)
    if (Option.isNone(repoOpt)) {
      return yield* fail("CodegraphRepo is not registered in AppRuntime.")
    }
    const { sizeBefore, sizeAfter } = yield* repoOpt.value.clearAll({ dropFile: args.dropFile })
    if (sizeBefore === 0) {
      UI.println("Codegraph index was already empty.")
      return
    }
    const freedBytes = Math.max(0, sizeBefore - sizeAfter)
    UI.println(
      UI.Style.TEXT_SUCCESS +
        `✓ Codegraph index removed. Freed ${freedBytes} bytes (${sizeBefore} -> ${sizeAfter}).` +
        UI.Style.TEXT_NORMAL,
    )
  }),
})
```

Add `.command(RemoveCommand)` to the `CodegraphCommand.builder` yargs chain (line 353-361).

### 3. `packages/core/test/banyancode/codegraph-remove-tool.test.ts` (new file)

Mirror the structure of `packages/core/test/banyancode/codegraph-remove.test.ts:8-123`. The new test exercises the **tool** layer (not just the repo primitive):

- Set `process.env.BANYANCODE_ENABLE = "1"` at the top
- Set `process.env.OPENCODE_DB` to a tmp path
- Import `codegraph.ts` (or just the tool registration block), seed the repo with one file + one node + one edge + one meta row
- Invoke the tool's `execute` via a fake `context` shape (see how `codegraph-build` tests do this in `packages/opencode/test/banyancode/codegraph-manual-build.test.ts`)
- Assert the output schema: `status`, `sizeBefore`, `sizeAfter`, `freedBytes`
- Assert `countNodes/Edges/Files` all return 0 after the call
- Test both `dropFile: false` (file remains) and `dropFile: true` (file is removed) paths

**Per AGENTS.md "avoid mocks, test actual implementation":** Use real `Database.layerFromPath` against a tmpdir. Do not mock the Drizzle layer.

### 4. `packages/opencode/test/banyancode/codegraph-tool-remove-http.test.ts` (new file)

POST to the tool's HTTP route (the tool is registered globally; check `packages/opencode/src/server/routes/instance/httpapi/groups/global.ts` for the existing `codegraphBuild` route at line 106-118 to find the pattern). Assert:
- The POST succeeds with the expected OutputRemove shape
- After the call, the DB still exists (default `dropFile: false`)
- A second call returns `status: "empty"`

**Use `process.env.OPENCODE_DB = tmpPath` and `process.env.BANYANCODE_ENABLE = "1"`.**

### 5. SDK regeneration

After the tool schema and route are in place, run from `packages/sdk/js/`:
```bash
bun run build
```
Or per AGENTS.md: `./packages/sdk/js/script/build.ts`. Commit the regenerated SDK files.

**Do not** edit the SDK by hand.

---

## Hard-Won Lessons to Enforce (per `AGENTS.md` and `packages/core/src/banyancode/AGENTS.md`)

The `@coder` subagent MUST follow these:

1. **Read-modify-write in `db.transaction()`** — not relevant to PR 1 (no DB writes outside the existing `clearAll` repo method, which is already transactional at `codegraph-repo.ts:443-452`).
2. **`tools.register` once per registration block** — add the new tool to the existing block at `codegraph.ts:243`, not as a separate `tools.register` call.
3. **`Effect.forkScoped` requires Scope in context** — not relevant to PR 1 (no forked fibers).
4. **Use `Effect.fn` for named/traced effects** — the existing tools use the inline `Effect.gen` style; match it for consistency.
5. **Schema validation: `Schema.Literals` takes an array** — `Schema.Literals(["removed", "empty"])`, not `Schema.Literals("removed", "empty")`.
6. **YOLO mode short-circuits destructive prompts** — the new `name_remove` permission action respects the existing YOLO logic at `permission/index.ts:83`. Do NOT narrow the check.
7. **Test real implementation, not mocks** — use real `Database.layerFromPath` against a tmpdir.
8. **Run `bun typecheck` from `packages/core` or `packages/opencode`, never root** — there is a "do-not-run-tests-from-root" guard in `AGENTS.md`.
9. **Per-package test commands:** `cd packages/core && bun test` and `cd packages/opencode && bun test`. Run only the new test files in fast iteration; run the full suite before declaring done.
10. **No `export * as` for new namespaces inside multi-sibling directories** — not relevant to PR 1; matches existing pattern at `codegraph.ts:1`.
11. **TUI quick-action wiring is OUT of scope for PR 1** — do not edit `packages/tui/`. The slash command at `command/index.ts:199-223` already covers the user-facing path.

---

## Lead Agent Review Checklist (post-`@coder`)

Before accepting the PR, the lead agent verifies:

- [ ] `git diff --stat` shows ONLY the 5 expected file groups modified (no scope creep into other tools, no unrelated refactors)
- [ ] `bun typecheck` passes in `packages/core` AND `packages/opencode`
- [ ] New test files pass: `cd packages/core && bun test test/banyancode/codegraph-remove-tool.test.ts` and `cd packages/opencode && bun test test/banyancode/codegraph-tool-remove-http.test.ts`
- [ ] No regressions in adjacent test files: `codegraph-remove.test.ts` (existing repo-level test) still passes
- [ ] Tool description text does NOT contain the deleted `future.md` 8-phase language
- [ ] CLI's `--drop-file` flag default is `false` (matches AD-6 and the slash command)
- [ ] Permission action registered as `name_remove` (separate from `name_build`)
- [ ] SDK regenerated via `./packages/sdk/js/script/build.ts`
- [ ] No new `tools.register` calls outside the existing block at `codegraph.ts:243`
- [ ] Commit message follows `type(scope): summary` (e.g. `feat(codegraph): add codegraph_remove tool`)

---

## Open Items (resolved before subsequent PRs)

- **PR 2 scope confirmation:** when A1 + A2 land, the `codegraph-indexer.ts:534-700` post-walk string-scan still runs but is much smaller. Decide in PR 7 whether to delete it entirely or keep as a fallback.
- **PR 4 dep selection:** confirm exact `web-tree-sitter` version + `tree-sitter-typescript` / `tree-sitter-javascript` / `tree-sitter-python` versions. Use the same versions pinned at `packages/tui/src/parsers-config.ts:9,25,37,...` for consistency.
- **PR 8 language list:** user-confirmed scope is SQL + HTML + CSS yes; `.sh`/`.bat`/`.ps1`/`.zig`/`.kt`/`.swift` deferred. Add Go + Rust + JSON + YAML + TOML + Java + C/C++ + Ruby + PHP in PR 8 (the high-value additions).
- **Test fixture for `this repo as benchmark`:** declare the integration smoke test in PR 2 (run index on `D:\OpenCode`, assert >5,000 symbols, <30s wall time). This serves as a regression guard for the whole plan.

---

**End of contract. Ready for `@coder` dispatch on PR 1.**
