# Native indexer sidecar

Status: implemented and compared on a real tree on Windows x64. Numbers are from
one machine, one tree, three runs per configuration.

## 1. Why, and what was measured first

The codegraph indexer is the slowest thing BanyanCode does to a repository: on
this worktree it is a multi-minute build that holds a large share of the
process heap. Before designing anything, the existing TypeScript indexer was
instrumented (`BANYANCODE_INDEX_PROFILE=<path>`) and run over this worktree's
`packages/` tree — 5.6k files, 15 languages — with a throwaway database so every
run parsed every file (no warm content-hash cache).

Method:

- Harness: `packages/banyancode/native/bench/indexer-profile.ts`.
- Each run: fresh `BANYANCODE_PROJECT_DB_DIR`, `index({ force: true })`.
- Phase times are accumulated across the producer fibers
  (`resolveParseConcurrency()` parses in flight), so with the default fanout the
  parse total exceeds wall time. The median of three runs is reported.
- Peak RSS is sampled at 50 ms by the indexer itself; `baseline` is RSS before
  the build started.
- Machine: Windows 11 x64, 16 logical cores. Same machine, same tree, same
  session for every row below.

### Configurations

| label | parse | SQLite writes |
| --- | --- | --- |
| `before` | TypeScript (wasm tree-sitter) | one transaction per file (`BANYANCODE_INDEX_PERSIST_BATCH=1`) |
| `ts-batched` | TypeScript (wasm tree-sitter) | one transaction per persist batch |
| `native` | `banyan-indexer` sidecar | one transaction per persist batch |

`before` reproduces the original commit-per-file write path exactly: the
original `flushBatch` called `repo.writeFileGraph` once per file, and a
one-element `writeFileGraphs` call is one transaction.

## 2. Before: where the time actually went

Median of three runs (`before` configuration), wall time and peak RSS:

| phase | median |
| --- | --- |
| **wall** | **173.8 s** (152.9 / 173.8 / 190.5) |
| walk + ignore matching | 3.3 s |
| read (accumulated) | 219.8 s |
| parse + extract (accumulated) | 45.0 s |
| SQLite writes | 53.4 s |
| derived-edge resolution | 60.7 s |
| wal_checkpoint | 0.01 s |
| orphan prune | 0.003 s |
| cached-timestamp bump | 0 s |
| **peak RSS** | **500 MB** (467 / 500 / 518) |
| baseline RSS before build | 59 MB |

Files: 5,605 walked / 5,602 indexed.

A fourth independent run of the same configuration (187.6 s, 68.3 s SQLite,
66.0 s edges, 472 MB peak, 5,625 files) confirms the spread.


Reading the table: the tree walk and ignore matching are **not** the problem
(≈2% of wall time). Parsing is not the problem either once you account for the
fanout. Two phases dominate, and both are serialized on the drain side:

- **SQLite writes** — one `BEGIN IMMEDIATE … COMMIT` per file, ~5.6k of them.
- **Derived-edge resolution** — `rebuildDerivedGraph` reads every node and file
  back out of SQLite, builds the scope maps, then deletes and re-inserts every
  derived edge.

Together they were more than half of wall time. That is the honest headline:
**moving parsing to Rust cannot fix a build that spends most of its time in
SQLite.** So this change does both:

1. Moves read + hash + parse + node/edge extraction to Rust (the genuinely
   compute-heavy, per-file work).
2. Fixes the write batching in TypeScript (`repo.writeFileGraphs`), which is the
   single largest win and has nothing to do with Rust.

## 3. After

Same machine and tree (5.6k files), idle apart from the run, median of three.
`before` and `ts-batched` were measured on one run of `D:/OpenCode`; `native`
right after the sidecar fixes below.

| configuration | wall | peak RSS | SQLite writes | derived edges |
| --- | --- | --- | --- | --- |
| `before` | 122.7 s | 511 MB | 39.4 s | 42.7 s |
| `ts-batched` | 115.9 s | 494 MB | 32.9 s | 43.8 s |
| `native` | **87.7 s** | **396 MB** | 40.6 s | 43.9 s |

The sidecar's own run over the tree takes 5.4 s wall (56 s of parsing across 16
workers), and 0 files panic.

## 4. Verdict

28% faster and 22% less peak memory than `before`. Batching alone gives 6%.

The rest of the build is now almost entirely SQLite writes and derived-edge
resolution, about 96% of wall time, which no parser rewrite can touch. That is
the next place to look, not more Rust parsing. Section 4a is that follow-up.

## 4a. SQLite writes and derived edges

Same tree as above, frozen as a copy of `packages/` (5,430 walked, 5,427
indexed), native backend, fresh database per run. `indexer-profile.ts` now also
samples event-loop stalls on the indexer's own thread (a 2 ms timer; a stall is
a gap over 100 ms), which is what a client of the host feels, and splits
`edgeResolveMs` into `derived.*` sub-phases.

### Where the 87.9 s went

Median of three runs on AC power, before any change (96.1 / 87.9 / 86.6 s):

| phase | median |
| --- | --- |
| SQLite writes | 38.2 s |
| derived edges | 45.8 s |
| – `in_degree` recompute | 22.4 s |
| – reference scan | 17.1 s |
| – derived edge insert | 4.8 s |
| – load, scopes, cross edges, delete | 1.6 s |
| longest event-loop stall | 25.8 s (one run) |

Two findings made most of the difference, and neither is about JavaScript:

1. **The FTS update trigger had no column list.** `codegraph_nodes_fts_update`
   fired on any `UPDATE`, so recomputing `in_degree` (not indexed) deleted and
   re-inserted every node's whole body in the trigram index: all 22.4 s of the
   `in_degree` step, and about a third of the database file. Migration
   `20261105000200_fts_update_indexed_columns` scopes it to
   `UPDATE OF name, signature, code`. In a replay the step dropped from 24.6 s to 1.2 s and the file from 347 MB to 233 MB.
   The recompute also ran as one unbroken stretch on the thread that serves the
   host's API, which is the 25.8 s stall.
2. **SQLite's defaults are sized for small writes.** The 2 MB page cache spilled
   mid-transaction, and the 1,000-page WAL threshold checkpointed (and synced)
   every few commits, on top of an explicit `wal_checkpoint(PASSIVE)` every 250
   files. A full build now sets `cache_size` to 16 MB and `wal_autocheckpoint` to
   25,600 pages on its connection, then truncates the WAL and restores SQLite's
   defaults when it ends (`Effect.acquireUseRelease`, so also on failure and
   cancel). Both are per-connection, so a crash leaves nothing to undo. The
   periodic passive checkpoint in the full-build drain is gone; the incremental
   path keeps it.

Plus three smaller changes:

- **Reference scan:** the scope maps (same-file, imported, peer) are built once
  per file instead of once per node, and the `Ns.member` receiver check is one
  regex pass per node instead of a `new RegExp` per identifier. That took it from 17.1 s to 3.8 s.
- **No long stretches:** derived edges are inserted in 2,000-row transactions
  and `in_degree` is recomputed in 900-node chunks, each giving the event loop a
  turn when the thread budget is spent; the drain also yields after a flush.
- **Persist batch 25 → 10 files.** With the larger WAL threshold, commits are
  cheap, so the batch is sized for how long one flush holds the thread. Over
  three runs each, 10 cut the total stalled time from 44 s to 19 s (89 vs 220
  stalls over 100 ms) for a wall difference inside the noise (59.1 vs 57.5 s).

### Before and after

Interleaved base / new / base / new… over one window, so both see the same
machine state. The laptop was **on battery** for this window, which is why the
base is slower than the AC baseline above; the ratio is the comparable number.
Median of three each:

| | base | new |
| --- | --- | --- |
| **wall** | **108.5 s** (108.5 / 114.0 / 97.9) | **43.9 s** (51.0 / 43.9 / 42.6) |
| SQLite writes | 51.2 s | 28.7 s |
| derived edges | 53.7 s | 11.3 s |
| longest event-loop stall | 33.4 s | 0.8 s |
| stalls over 1 s | 4 | 0 |
| total time in stalls over 100 ms | 89.3 s | 11.0 s |
| peak RSS | 381 MB | 411 MB |

**60% less wall time; the longest stall goes from 33 s to under 1 s.** The
remaining derived-edge time is reference scan 3.8 s, insert 3.7 s, `in_degree` 1.8 s.
A single AC-power run of the new code, at batch size 25, took 36.4 s. Peak RSS is within
run-to-run spread (353–416 MB across new runs).

A first attempt at this A/B is discarded: the lid closed and the machine sat in
Modern Standby for 14 minutes inside one run (908 s wall, a 789 s "stall").

**Graph unchanged.** `native/bench/graph-fingerprint.ts` builds the tree and
writes every file, node (kind, name, lines, entrypoint, `in_degree`, signature
and code hashes), edge, service tag and an FTS probe as sorted text, with file
ids replaced by paths. The baseline was deterministic (two builds, same SHA-1),
and the new code produces the identical file: 44,307 nodes, 96,526 edges, 134
tags, SHA-1 `dbc14bffa187e38c96603c8b3b39005e4ef3fec0`. `parity-real.ts` still
shows the one documented difference (`Prompt` end line) and nothing else: 44,306 nodes and 82,108 edges on each side.

**Rebuild over an existing database** (`BANYANCODE_PROFILE_REBUILD=1`, one run
each): 172.2 s → 83.0 s, longest stall 38.3 s → 1.3 s. This pair overlapped a
full index of another tree on the same machine, so treat it as indicative; an
earlier AC-power pair was 133.9 s for base and 101.1 s for new at batch 25.

### Measured and not adopted

From a replay harness that writes a built graph into a fresh database under
each variant (no parsing, single runs, ±20% noise):

| variant | effect | why not |
| --- | --- | --- |
| prepared single-row statements reused | none (multi-row inserts were already amortised) | no gain |
| `foreign_keys = OFF` | within noise | `DELETE FROM codegraph_files` relies on the cascade; connection-wide, so it would also drop enforcement for every other writer |
| drop secondary indexes, recreate after | −3.5 s | DDL on a live database: readers lose the indexes for the length of the build |
| drop FTS triggers, one `rebuild` after | −6.5 s | the rebuild is a single 9–12 s statement that blocks the thread and holds the write lock past other processes' 5 s `busy_timeout`; a crash would leave the triggers off |
| FTS `automerge = 0` / `crisismerge = 64` + `optimize` | within noise | no gain |
| 100- or 500-file transactions | within noise | longer stalls, more memory |
| `temp_store = MEMORY` | within noise | no gain |
| 64 / 128 MB page cache | same wall as 16 MB | +20 / +120 MB RSS |

Ablation on real builds (single runs, new code otherwise): the default 2 MB cache
gives 54.6 s and the default WAL threshold 71.1 s, against 36.4 s with both.

Moving edge resolution into SQL or the sidecar was not needed: after the changes
above the JavaScript part of it is under 5 s.

### What is left

- **Trigram FTS is now most of the write phase.** The replay puts about 16 s of
  the remaining writes in FTS maintenance. Taking it off the API thread needs
  either a worker with its own connection, or a chunked backfill with a
  crash-safe "FTS dirty" marker. Both change who writes and when, so they were
  out of scope here.
- **A rebuild over an existing graph pays FTS twice**: every replaced node is
  re-tokenized for the `delete` as well as the insert.
- **Flush stalls**: a 10-file flush still holds the thread for up to ~0.8 s
  on the largest files. Splitting a single large file's graph across
  transactions would break per-file atomicity.

Fixture parity was not enough. The first sidecar passed every fixture and
panicked on this repository within seconds, and the fallback hid it: "native"
runs were really TypeScript. Compare backends over a real tree with
`bun native/bench/parity-real.ts <root>`. On this repository:

- nodes: 46,081 on both sides, one differs (`Prompt` in
  `packages/tui/src/component/prompt/index.tsx`, `end_line` 1998 vs 1999)
- edges: 82,796 on both sides, all identical

A per-file panic is now contained: that file gets no result line, and the
TypeScript parser indexes it.

## 5. What the sidecar does

`packages/banyancode/native` builds one binary, `banyan-indexer`.

Per file it owns: read, SHA-256, the skip decisions, language/file-kind
classification, parsing, and node/edge extraction. It does **not** own the
graph shape: the file-level node, the artifact node, the entrypoint flag, node
derivation and the parser-edge endpoint remapping stay in
`buildFileGraph` (`codegraph-indexer.ts`), which both backends call. That is
what keeps the graph identical when the backend flips.

It never opens SQLite. TypeScript remains the single writer through the
existing repository methods, so the schema keeps exactly one owner.

### Protocol

NDJSON over stdin/stdout.

```
sidecar → {"type":"hello","protocol":1,"version":"0.1.0","backends":["tree-sitter"]}
client  → {"type":"request","protocol":1,"root":…,"mode":"files"|"full","files":[…],"force":…,"maxFileSizeBytes":…,"excludePatterns":[…]}
sidecar → {"type":"file",…}        one line per input file
sidecar → {"type":"summary",…}     counters + timings, always last
```

- The protocol version is checked **on both sides at startup**: the client
  rejects a `hello` whose `protocol` differs, and the sidecar exits 3 on a
  mismatched request.
- `files` mode is what the indexer uses: TypeScript owns the walk (and therefore
  the nested-`.gitignore` semantics and the `gitignored`/`banyanignored`/
  `tooLarge` buckets), and sends `{path, fileID, sizeBytes, mtimeMs}` plus the
  known hash/size/mtime for unchanged-file skipping. `full` mode walks the tree
  itself with the `ignore` crate; it exists for standalone use and for the
  benchmark, not for the production path.
- `fileID` is minted by the caller, so node ids (`${fileID}:${kind}:${name}:${line}`)
  are byte-identical between backends.
- Every skip bucket is incremented at its own decision site in
  `pipeline.rs`; the summary never derives a bucket from a total.
- `.scm` query sources are `include_str!`d from
  `src/codegraph/langs/queries/*.scm`, so both backends read the same file.

### Failure handling

Any failure — missing binary, spawn error, version mismatch, crash mid-stream,
malformed line, or a clean exit that delivered fewer files than it was given —
falls back to the TypeScript parser for the files the sidecar did not deliver,
with one logged warning, and the build result records `backend: "typescript"`.
A malformed line never aborts the build.

The child is acquired with `Effect.acquireUseRelease`, so it is killed on
success, on failure, on interruption (cancel) and on scope close. Cancel is also
polled once per line so a cancel during a long build kills the child promptly
rather than at the end of the stream.

### Back-pressure

The parse pool pushes into a bounded channel (64) drained by one writer thread;
`send` blocks when the consumer is behind, which parks a rayon worker and stops
the pool from starting more files. On the TypeScript side the callback is
awaited before the next line is read, and the callback offers into the existing
bounded `parsedQueue` (128) which the SQLite drain consumes. There is no
unbounded queue anywhere in the path: when SQLite is slow, the pipe fills, the
sidecar blocks on write, and the whole pipeline throttles.

### Effect rules respected

- No `Effect.runSync` from callbacks; the callback returns an `Effect` that the
  consumer `yield*`s.
- `catchCause`, not the non-existent `catchAll`.
- The child is a scoped resource (`acquireUseRelease`), not a detached fiber.
- The writer thread is a plain OS thread with an explicit `join`, so nothing
  outlives `runNativeIndex`.

## 6. Parity differences (documented, not hidden)

The parity test compares every node (`id`, `kind`, `name`, `startLine`,
`endLine`, `signature`, `code`, `isEntrypoint`) and every edge (`id`, endpoints,
`kind`) between the two backends over a fixture with all indexer-reachable
languages. It passes. The remaining differences are structural, not
observable in the graph:

1. **Offsets are UTF-8 bytes, not UTF-16 units.** Only matters if a body cap or
   a slice lands inside a multi-byte character. Node ids, kinds, names and line
   numbers are unaffected; `code` slices of non-ASCII source can differ by up to
   one character at the 4000-unit boundary.
2. **`\b` is a Unicode word boundary** in Rust and ASCII in JavaScript. Only
   differs when an identifier is adjacent to a non-ASCII character.
3. **`\s` additionally matches U+FEFF.** JavaScript also treats a BOM as
   whitespace; Rust's `\s` does not, so the ported patterns spell it out
   explicitly. The two agree.
4. **Regex backtracking limits.** The ported patterns use `fancy-regex`, a
   backtracking engine like V8's, but with a different (configurable) limit. A
   pathological C/C++ file could hit it where V8 would not; the crate's own
   tests and the parity fixture do not.
5. **fileID values differ run to run** because they are UUIDs minted per build.
   The id *scheme* is identical, which is what the parity test normalises.

Two behaviours were ported **as-is rather than fixed**, because "fixing" them
would change the graph and break parity with builds already on disk:

- `langs/python.ts` reads `match[3]` from a pattern with two capture groups, so
  its `import` loop never emits an edge; and its `from … import` pattern
  requires a *quoted* module, which is not valid Python. Net effect: Python
  files produce **no** `imports` edges, on both backends.
- `langs/typescript.ts` exports `.tsx` syntax errors as suppressed, so a real
  TSX syntax error is never reported.

## 7. Skip buckets: which are reachable

The parity test asserts both backends report the same number for every bucket,
and that each statically reachable bucket actually fires:

| bucket | reachable | note |
| --- | --- | --- |
| `gitignored` | yes | defaults, root/nested `.gitignore` |
| `banyanignored` | yes | `.banyancode/ignore` + configured excludes |
| `tooLarge` | yes | over `maxFileSizeBytes` at stat time |
| `minified` | yes | any line over 5000 chars |
| `artifact` | yes, one shape | `isArtifact && !classifyFileKind`; the only reachable shape is a path containing `dockerfile.` (e.g. `x.dockerfile.ts`), because every other `isArtifactPath` shape also classifies a kind |
| `cached` | yes | second build |
| `parseFailure` | yes | a file with a syntax error still indexes |
| `tooLargeParse` | **no** | a race: content would have to grow between the stat and the read. Both backends report 0 |
| `readError` | **no** | a race: the file would have to vanish or lose read permission after the walk. Both backends report 0 |

A related finding, surfaced while building the parity fixture: **the JSON, TOML
and YAML AST-walk adapters are unreachable through the indexer.** `.json`,
`.toml`, `.yml` and `.yaml` are not in `CODE_EXTENSIONS`, so a file is only a
candidate when `isArtifactPath` matches — and every one of those shapes takes
the artifact branch, which parses nothing. Both backends therefore skip them
identically; the parity test guards this explicitly so a future change to the
extension list is deliberate. The three walkers are still covered by the crate's
own unit tests, and the Rust port implements them.

## 8. Packaging

`packages/cli/script/native-indexer.ts` builds and stages the sidecar:

- Host target: `cargo build --release`.
- Cross target: `cargo zigbuild --release --target <triple>`, falling back to
  `cargo build --release --target <triple>` when zigbuild is unavailable (the
  Windows ARM64 case, where zig cannot emit the MSVC ABI).
- `BANYANCODE_SKIP_NATIVE_INDEXER=1` is an explicit opt-out and is **rejected**
  for release builds.
- A release build (anything without `--single`) fails with a clear, actionable
  message when a target has no sidecar. A `--single` dev build without cargo
  warns and continues, and the shipped binary falls back to the TypeScript
  parsers.

`verifyArtifact` now checks the sidecar exists and is non-empty, and runs
`banyan-indexer --version` when the artifact's target matches the build host (a
cross-compiled binary cannot execute here).

`script/banyancode/pack.ts` copies the sidecar into each platform package and
into each GitHub release archive, and fails a `--all` (release) pack when a
target is missing it. `script/postinstall.mjs` links or copies the sidecar next
to the installed executable, best-effort, with a warning when absent.

Target status (12 targets in `allTargets` / `PLATFORMS`):

| target | Rust triple | sidecar | status |
| --- | --- | --- | --- |
| `linux-x64` | `x86_64-unknown-linux-gnu` | configured | cross (zigbuild) |
| `linux-x64-baseline` | `x86_64-unknown-linux-gnu` | configured | cross (zigbuild) |
| `linux-x64-musl` | `x86_64-unknown-linux-musl` | configured | cross (zigbuild) |
| `linux-x64-baseline-musl` | `x86_64-unknown-linux-musl` | configured | cross (zigbuild) |
| `linux-arm64` | `aarch64-unknown-linux-gnu` | configured | cross (zigbuild) |
| `linux-arm64-musl` | `aarch64-unknown-linux-musl` | configured | cross (zigbuild) |
| `darwin-x64` | `x86_64-apple-darwin` | configured | cross (zigbuild) |
| `darwin-x64-baseline` | `x86_64-apple-darwin` | configured | cross (zigbuild) |
| `darwin-arm64` | `aarch64-apple-darwin` | configured | native on macos-15 |
| `windows-x64` | `x86_64-pc-windows-msvc` | **built here** | native, `--version` verified |
| `windows-x64-baseline` | `x86_64-pc-windows-msvc` | **built here** | native, `--version` verified |
| `windows-arm64` | `aarch64-pc-windows-msvc` | configured | cross (MSVC ARM64 toolset) |

Only the Windows x64 family was built and executed on this machine
(`cargo build --release` → `banyan-indexer 0.1.0 protocol 1`). Every other row is
**configured, not built**: `cargo-zigbuild` is not installed here and no
cross-compilation was attempted.

CI (`banyancode-publish.yml`, build job only — no trigger changes): added a
"Setup native indexer toolchain" step (rustup, `cargo install cargo-zigbuild`,
zig from the official tarball on Linux/macOS, `rustup target add
aarch64-pc-windows-msvc` on Windows) and `actions/cache/restore` /
`actions/cache/save` steps for `packages/banyancode/native/target`, both using
the already-pinned `actions/cache` SHA. `script/banyancode/workflows.test.ts`
still passes.


## 9. What is not verified

- **Windows x64 and Linux x64 `--single` builds are verified**: the packaged binary finds the sidecar next to itself and records `backend: native`, and removing the sidecar falls back to `backend: typescript`. No other platform has been run.
- **Every cross-compiled target.** `cargo-zigbuild` is not installed on this
  machine, so the musl, arm64, darwin and windows-arm64 sidecars are configured
  only. The `darwin-x64`-from-`arm64` and `windows-arm64`-from-`x64` cases are
  the two most likely to need attention.
- **CI itself.** The workflow steps are prepared but cannot be run here.
- **`--single` dev build without cargo.** The warn-and-continue path is
  implemented and type-checks; it was not exercised end to end.
- **Cancel during a native build.** The child is killed by the scoped release
  and cancel is polled per line; no test drives an actual cancel mid-stream.
- **Incremental builds (`applyChanges` / `indexFiles` / `removeFiles`) always use
  the TypeScript parser.** Deliberate: watcher change sets are small and the
  per-file protocol overhead is not worth it. Parity means the two paths produce
  the same rows.

