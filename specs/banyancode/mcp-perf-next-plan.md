# MCP + performance: verified status and next plan

Date: 2026-10-02. Supersedes the "remaining roadmap" in the agent's progress report. It builds on [mcp-server-gap-plan.md](./mcp-server-gap-plan.md), whose item IDs (A*, B*, Q*, S*, U*, G*, V*, C*, D*, E*) are used below.

Method: I checked each claim in the progress report against the repository rather than the report itself:
- `git log origin/main..main` and `git status`
- file inspection
- `bun typecheck` in `packages/opencode`
- `bun test test/mcp-server`
- a process-tree check of the "respawning harness"

---

## 1. Claim-by-claim verification

| Claim | Verdict | Evidence |
|---|---|---|
| 17 commits landed | ✅ True, but **all 17 are on local `main`, unpushed** (`main...origin/main [ahead 17]`). | `git status -sb` |
| Milestone A (A1–A13) | ✅ Substantially true. Spot-checked: ephemeral listener (`server/server.ts:40-42,131-134`), `chdir` + directory-scoped SDK client, `paths.ts` guard, password only set around `listen` and then restored (`mcp-server/server.ts:398-409`) plus the spawn-env scrub. | file inspection |
| Q1 shared memoMap / port-before-build | ✅ (`c7b4262672`) | commit |
| Milestone B (B1–B12) | ⚠️ **Partly.** `session-client.ts`, `task-engine.ts` (641 lines), `policy.ts`, `task-handle.ts` and `tools-task.ts` exist and are registered, and the engine logic is sound. But the **live event source is a stub**: `server.ts` passes `events = { subscribe: () => () => {} }`. See §2.3. | `mcp-server/server.ts` ("No live event drain yet") |
| "Q0–Q10 all done" | ❌ **Two are not done.** **Q4**: `MAX_HOT_GRAMMAR_FAMILIES = 4` and the dead `HEAP_*` constants are unchanged (`langs/tree-sitter.ts:103,109`). **Q8**: `BanyanConfig.get()` still re-reads up to 3 files and decodes them on every call, with no cache (`core/src/banyancode/banyan-config.ts:37-66`). The rest were spot-checked as present: Q0, Q2, Q3, Q5, Q6, Q7, Q9 (Windows enforcer now 1 s), Q10. | file inspection |
| Storage S1–S5 | ✅ Commits present (`456e39b2da`, `b118f1060e`, `0b99ba26f3`, `db-gc.ts`). ❌ But **S1 breaks typecheck** (§2.1). | typecheck |
| "In flight: E0–E4 engine gaps" | ⚠️ No engine changes are in the working tree. Instead there is a **large uncommitted wave the report doesn't mention** (§2.4). | `git status` |
| Pre-existing failures (httpapi-listen 1, shell 14, codegraph-incremental 2) | Not re-run here. Plausible. `codegraph-incremental` matches gap-plan §12 item 1 (incremental scope drops edges), so it's a **real bug, not noise**. | — |
| MCP suite health | ✅/⚠️ **122 pass / 2 fail.** Both failures are the new symlink tests in `paths.test.ts`, which fail with **EPERM**: Windows needs Developer Mode or admin rights for `dir` symlinks. It's an environment issue, not a guard bug. | `bun test test/mcp-server` |

## 2. Blockers to fix before any new swarm

### 2.1 `main` doesn't typecheck (P0)
`bun typecheck` (packages/opencode) reports 3 errors:
1. `core/src/event/compaction.ts:203` — `inArray(EventTable.id, chunk)`: `chunk` is `string[]` but the column is the branded `Event.ID`. This is **committed** (S1, `456e39b2da`). Fix: map the IDs through the brand (or type `deletable` as `Event.ID`).
2. `opencode/src/session/jev-explorer/deps.ts:398` — `unknown` passed as `string`. The file itself hasn't changed since `e3f0203ddd`, so a type it depends on changed. The most likely cause is the uncommitted `message-v2.ts` rework (§2.4); confirm once that wave is settled.
3. `opencode/test/session/message-v2.test.ts:1769` — plain string where `MessageID` is required. This is **uncommitted** in-flight work.

**Consequence:** the husky `pre-push` hook runs `bun typecheck`, so **none of the 17 commits can be pushed** until item 1 is fixed (and items 2–3 if their files are committed).

### 2.2 Branch hygiene (P0)
All work went straight onto local `main`. The repo conventions say to work on a short branch and ship through PRs to `main`, with one logical change per commit and typecheck plus the relevant tests run between commits. Recommended:
1. Move the 17 commits to a branch without rewriting them: `git branch mcp-perf main` then `git reset --keep origin/main` on `main`. Only do this **after** the in-flight agent has stopped writing to the tree. `--keep` refuses if it would clobber local changes.
2. Fix §2.1 item 1 on that branch.
3. Open a PR, or split it into three (MCP A+B, perf quick wins, storage). The storage PR should get the closest review because it contains a data migration (the event-log compaction and the patch-body backfill).

### 2.3 Task engine has no event source (P1, the real "E0–E4")
The engine's handlers for `permission.asked`, `question.asked`, `session.idle`/`status` and `session.error` exist (`task-engine.ts:551-590`) but never fire. Without events, everything depends on the caller polling a **specific** handle:
- **Queued tasks only start when a *running* task's own handle is polled to `done`.** `dequeueNext()` runs only from `refresh(handle)` when that handle completes, or on failure. A caller that polls only the queued handle waits forever: `refresh` on a queued record never dequeues.
- **Under `reject`, an `ask` permission blocks the session until someone polls that task.** The auto-reject is in `refresh`/`apply`, and nothing triggers either.
- `needs_input` timers start only after a poll has observed the question.

Fix (small; the engine already supports it):
1. Implement `EngineEventSource` over `sdk.event.subscribe` (in-process) or `sdk.global.event` (`--attach`), mapping `session.status`, `session.idle`, `session.error`, `permission.asked` and `question.asked`. Include child sessions, since subagents ask too.
2. As a safety net, add a low-frequency sweep (every 5–10 s while any task is non-terminal) that calls `refresh` on all running handles and then `dequeueNext()`.
3. Tests against the real in-process server:
   - queued → auto-start after the running task finishes, **without** polling it;
   - reject-policy ask auto-rejected without any poll;
   - `needs_input` timeout fires without a poll.

### 2.4 Unreported uncommitted wave (P1, needs an owner)
The working tree has substantial, uncommitted changes that aren't mentioned in the progress report. They map to gap-plan items as follows:

| File(s) | Item | Size |
|---|---|---|
| `project/instance-store.ts`, `effect/instance-state.ts`, `effect/instance-registry.ts`, `test/project/instance-eviction.test.ts` | U5 / R7 instance eviction | instance-store +405/−… |
| `lsp/lsp.ts`, `test/lsp/lsp-idle-sweep.test.ts`, `test/lsp/lifecycle-memory.test.ts` | R11 LSP sweep | +63 |
| `session/instruction.ts`, `session/tools.ts`, `test/session/instruction-cache.test.ts`, `test/session/tools-cache.test.ts` | U3 / R8 per-run caches | +112 / … |
| `session/message-v2.ts`, `session/compaction.ts`, `session/summary.ts`, `session/status.ts`, tests | U2 / U6 incremental history + prefix sums | +100 / … |
| `snapshot/index.ts`, `test/snapshot/snapshot.test.ts` | U4 / R9 snapshot correctness | the "two agents merged it" file |
| `core/.../repository-intelligence/layer.ts`, `core/test/banyancode/query-context-cache.test.ts` | G2 / C2 gateway context cache | +71 |
| `tui/src/routes/session/question.tsx`, `subagent-footer.tsx` | **Not from this effort.** These were already modified before the review started. The diff is mostly CRLF→LF churn (1,030 and 266 lines). | — |

Before any new swarm:
1. Confirm which agent owns this wave and let it finish **or** stop it.
2. Run typecheck and the matching tests per item.
3. Commit each item separately, as the conventions require.
4. Leave the two TUI files out. They are the user's own pending changes, and the line-ending churn shouldn't ride along in a perf commit.

### 2.5 The "harness processes holding the global DB"
Observed at 18:00: **one** `banyancode.exe` (PID 22240, 710 MB working set), started at 17:58 by `node.exe` (the npm `banyancode` shim), whose parent is `powershell.exe`. Its command line isn't readable without elevation. That pattern is someone or something running the `banyancode` CLI. Candidates are an agent worker (the external `go-coder`/`go-scout` workers run CLI processes) or a TUI you opened.

On the options the agent offered:
- **(a) `taskkill /T /F`: not recommended blind.** It may be the very coder doing the in-flight work, or your own TUI with an active session. Identify it first, e.g. Resource Monitor → CPU → Associated Handles → search `banyancode-` to see which DB file it holds, or Process Explorer for the command line.
- **The underlying problem is test isolation, and that's the actual fix.** `test/preload.ts` sets `OPENCODE_DB=:memory:` and temporary XDG dirs, so the *main* DB is isolated. But the per-root BanyanCode DBs (`WorkspaceIdentity.identityForRoot` / `deriveBanyanDbPath`, and `databaseLayerForRoot` in `banyan-tools-mount`) resolve to **`<repo>/.banyancode/banyancode-<hash>.db`** and don't honor the test override. So tests that use the repo itself as a root contend with any real BanyanCode running in this repo.
- **Fix:** an env override (e.g. `BANYANCODE_PROJECT_DB_DIR`) honored by `deriveBanyanDbPath`, set to a temp dir in `test/preload.ts`. Tests should also use `tmpdir()` roots, not the repo. Then no external process can block the suites.

## 3. Revised plan

Ordered so each wave starts from a green, pushable baseline.

### Wave 0: stabilize (½ day, serial, lead agent only)
| # | Task | Done when |
|---|---|---|
| W0.1 | Stop or finish the uncommitted wave (§2.4). No new agents start until the tree is quiet. | `git status` shows only the 2 pre-existing TUI files |
| W0.2 | Fix `compaction.ts:203` (brand the IDs); resolve `deps.ts:398` / `message-v2.test.ts:1769` with whichever wave owns them | `bun typecheck` green in `packages/opencode` and `packages/core` |
| W0.3 | Move the 17 commits to the `mcp-perf` branch (§2.2); commit the §2.4 items one by one on it | `main` == `origin/main`; branch builds |
| W0.4 | Windows-safe symlink tests: `symlink(target, link, process.platform === "win32" ? "junction" : "dir")` | `paths.test.ts` green on Windows |
| W0.5 | Test DB isolation for per-root DBs (§2.5) | instance and codegraph suites pass with a real BanyanCode running in the repo |
| W0.6 | Re-run the "pre-existing" failures on the branch and record the baseline in the PR description | Known-failure list with the reason for each |

### Wave 1: finish what was claimed (1–2 days)
| # | Task | Notes |
|---|---|---|
| W1.1 | Engine event source + sweep + tests (§2.3) | This completes Milestone B. Without it, delegation stalls for callers that poll only the newest handle |
| W1.2 | **Q4**: load each grammar family once, never evict (≤ 16); delete the dead `HEAP_*` constants; regression test with no RSS growth across two index runs | Was claimed, not done |
| W1.3 | **Q8**: cache `BanyanConfig.get()` (mtime- or write-invalidated); cache `indexedRoot` in auto-update | Was claimed, not done |
| W1.4 | **New bug:** `BanyanConfig.readConfig` resolves the *local* `banyancode.json` from `process.cwd()`, not from the instance or project directory. In a multi-project server (`serve`, `--attach`, the TUI switching projects) every project gets the launcher's local config. Key the cache from W1.3 by directory and pass the instance directory in | Correctness; pairs with W1.3 |
| W1.5 | Delete the legacy `mcp-server/tasks.ts` (keep only the shared types, moved to `session-client.ts` or a `types.ts`) and `isolation.ts`'s duplicate policy and tracker. Remove `FakeSessionClient`-based tests that duplicate engine coverage | Gap-plan §4.8 consolidation; `tasks.ts` (451 lines) is now just a type source |
| W1.6 | `codegraph-incremental.test.ts` failures → fix the incremental scope (gap-plan §12 item 1, G6) instead of carrying them as "pre-existing" | They're the edge-loss bug |

### Wave 2: Wave-8b as planned, with corrections
- **Codegraph (G1, G3, G4, G5, G6).** G2 is in the uncommitted wave (§2.4); verify it there. Do G1 and G6 in **one** PR, since both touch `applyChanges`.
- **TUI (V1–V5)**, and V6 (the in-process server spike) only after V1 lands and is measured.
- Run the §11.6 perf probe **before and after** this wave. None of the quick wins have measured numbers attached yet. The `db-report` script from the review can provide the event-bytes baseline today.

### Wave 3: Milestone C (C1–C6)
Unchanged from the gap plan, with two notes:
- C2 (real worktrees) needs §2.3 done first: queued and worktree tasks depend on reliable dequeue.
- C6 (USD cap) should reuse the engine's event source for cost updates rather than polling.

### Wave 4: Milestone D, then E
Unchanged (D0 SDK v2 dual-era first). Re-check the MCP spec and SDK versions at the start of D: they were current as of 2026-10-01.

### Wave 5: release gate
- Serialized `bun turbo typecheck` and the full test run (from package dirs).
- Reviewer verdict.
- The perf probe compared against the Wave 2 baseline.
- Release through the normal path: a version-bump commit on `main`, after which `tag-release.yml` tags and publishes. **No manual tags.**

## 4. Process changes for the remaining swarms
1. **No commits to `main`.** Agents work on the `mcp-perf` branch or a worktree per wave; the lead merges or opens PRs. (`AGENTS.md`: workers never commit, the lead commits.)
2. **Every "done" claim includes evidence:** commit SHA, the test file that proves it, and a green typecheck line. "All done" summaries without per-item evidence are how Q4 and Q8 slipped through.
3. **Only one writer per file per wave.** The `snapshot/index.ts` merge by two agents (U4 + U5) is the failure mode the parallel-work rules exist to prevent. If a file is shared, serialize those items.
4. **Typecheck before every commit**, not only before push. The compaction error would have been caught.

## 5. Decision needed
On the agent's (a)/(b)/(c) question, my recommendation is **(c) pause new swarms for Wave 0**, and **don't** run a blind `taskkill /T /F`. Identify PID 22240 first (§2.5). Then fix test DB isolation so nothing external can block the suites again. After Wave 0, proceed with (b) under §4's rules.
