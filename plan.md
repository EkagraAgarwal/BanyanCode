# Plan

**Last stable:** `d4db94f` (tag `last-stable`, branch `stable`). Based on `v4-baseline`. DeepSeek works out of the box; minimax needs a working API key in `~/.config/opencode/opencode.json`.

**Branch layout:**

| Branch | Purpose |
|---|---|
| `stable` | Working code. Use this. |
| `main` | Mirrors `stable`. |
| `v4-baseline` | Upstream reference for `stable`. |

**Tags:**

| Tag | Points to | Notes |
|---|---|---|
| `last-stable` | `d4db94f` | Working commit. |
| `backup-pre-cleanup` | `87e184f` | The 12 broken commits discarded from `main` before this cleanup. |
| `pre-tier3-baseline` | older tag | Untouched. |

**Known good:** run `bun run --cwd packages/opencode --conditions=browser src/index.ts`.

**Known broken:** the minimax key in `~/.config/opencode/opencode.json` returns `insufficient balance (1008)`. Replace the key or use DeepSeek.

**To bring back the 12 experimental commits:**

```bash
git checkout backup-pre-cleanup
git checkout -b experimental-restored
```

**Future work:** none planned. Add a `plan.md` section if/when needed.

---

## In-progress TUI fixes (commits `d101a43`–`2fcc41a`)

Four user-reported visual issues from screenshots, all fixed:

1. **`d101a43`** — "Current variant" toast now newline-split, list-length check fixes `"none, none"` bug.
2. **`45d96f6`** — `[e rename]` → `<span>` with `TextAttributes.BOLD` (matches which-key.tsx pattern). Same pattern applies to `[⏎ save]` and `[esc cancel]` in the same file but those weren't user-reported; left for follow-up.
3. **`f7ffa74`** — Autocomplete dropdown: height 10→15, cap by `spaceAbove` (was `anchor().y`). zIndex 100→1000. Item backgrounds: `theme.backgroundMenu` always (was transparent when not selected).
4. **`2fcc41a`** — Variant picker fallback to ProviderTransform synthesis via `sdk.client.config.providers()` (the endpoint that runs `ProviderTransform.variants()`). Fixes "no variants" for minimax-m3 and deepseek-r1.
5. **Slash command removal** — `/variant`, `/reasoning`, `/thinking` removed (extra commands the user didn't want). `/variants` retained.
6. **Autocomplete z-order fix** — wrap in `<Portal mount={renderer.root}>` and bump zIndex to 2900 (below dialogs at 3000, above which-key at 3500 fix later). Mounting via Portal escapes the parent's `_childrenInZIndexOrder` so the agents tab behind can't bleed through.

---

## In-progress: Codegraph build stuck at 0/0

### Symptom

TUI shows:
```
Codegraph Indexing — Running
░░░░░░░░░░░░░░░░░░░░ 0/0
Index → D:\OpenCode\packages\opencode\.banyancode\banyancode-local.db
Press Ctrl+C to cancel
```

Process never completes and never errors. The "0/0" never advances.

### Root cause

Commit `944bc14` (perf: structural compaction estimator) added `fs.stat()` per file in `walkDirectory` (`packages/core/src/banyancode/codegraph-indexer.ts:72-78`). `fs.stat()` blocks indefinitely on:

- Named pipes on Windows
- Stale file handles (deleted-but-still-mapped files)
- Files on disconnected network drives
- Locked files held open by another process

Because `walkDirectory` recurses synchronously via `yield*` and `onProgress` is only called after the walk completes, the entire `indexer.index()` effect hangs in `walkDirectory`. The build service publishes the initial `{status: "running", done: 0, total: 0}` state at line 87-88 then never publishes another event. TUI shows "Running" + `0/0` indefinitely.

### Fix

Two-layer guard:

1. **Per-stat timeout** (`codegraph-indexer.ts:72-78`):

   ```ts
   const stats = yield* fs.stat(fullPath).pipe(Effect.timeout(Duration.seconds(5)))
   if (Option.isNone(stats)) {
     yield* Effect.logWarning(`Skipping file (stat timeout): ${path.relative(root, fullPath)}`)
     continue
   }
   ```

2. **Whole-walk timeout** as a defense-in-depth outer guard so a single hung readdir doesn't block the indexer forever.

### Tests

- Add a test that walks a directory containing a special file (named pipe or symlink loop) and asserts the indexer completes within a bounded time.
- The existing `packages/core/test/banyancode/codegraph-indexer.test.ts` covers the happy path; add a slow-filesystem case.

---

## Suggested next steps

1. Dispatch `@coder` to apply the 1-line `Effect.timeout` fix at `codegraph-indexer.ts:72-78` and add a global walk timeout.
2. Add a test for the special-file case.
3. After fixing, run `bun --cwd packages/core test packages/core/test/banyancode/codegraph-indexer` and tmux-verify the build completes.