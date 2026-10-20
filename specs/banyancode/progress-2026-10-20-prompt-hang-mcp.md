# Progress — prompt hang + MCP hardening (2026-10-20)

**Branch:** `fix-prompt-hang` (pushed; off `origin/main` @ 26.10.7). `hotfix-remove-jev` was already fully merged into main.
**Installed locally:** 26.10.8 built from this branch, copied over `%APPDATA%\npm\node_modules\banyancode\bin\banyancode.exe` (old 26.10.7 exe backed up to `C:\Users\ekagr\banyancode-backup-20261020\`).

## Root causes fixed
- **No response / stuck loading:** `C:\Users\ekagr` is itself a git repo, so running from `~` made the pre-step snapshot (`git diff-files` + `ls-files --others`) scan the whole home dir for minutes before the first LLM call. Listing is now capped at 15 s (`BANYANCODE_SNAPSHOT_LIST_TIMEOUT_MS`), after which snapshots are off for that worktree.
- Home dir `.git`/`.banyancode` no longer adopted by child folders (`Database.path()`, `findContainingBanyanDir`).
- Auto-update no longer indexes BanyanCode's own state/data dirs or home-dir instances.
- MCP: `banyan_verify` 500 (VerifierService not provided to /global routes); codegraph stores stamped with a subdir root (permanent "indexed_root mismatch"); status said `missing` during builds (now `building` + progress); old-schema graphs reported `ready` and non-forced builds kept stale nodes.
- Codegraph TS accuracy: arrow-function ranges off-by-one, multi-line typed arrows not indexed, expression bodies cut to 1 line, type aliases swallowing the next function, `export type` not indexed. Schema bumped to 5 (forces one reindex).
- MCP quality: SDK 2.3.1 (protocol 2025-11-25), server `instructions`, read-only hints on task status/result, `path` on code_find matches, preflight `risk` + `filePaths`, truncation keeps scalars/small maps, `code` bodies clamped to 600 chars, clean verify has empty `failures`.

## Verified
- TUI from `~` answers (≈44 s first turn incl. 15 s snapshot cap). `banyancode run` from `~` answers.
- `claude mcp list` → banyancode ✔ Connected; headless `claude -p` exercised codegraph build/status, code_find, change_check, repo, memory, verify, and a real sub-agent task (banyan_task_start → result).
- Tests: core banyancode 1153 pass (1 pre-existing symlink EPERM — needs Windows Developer Mode); opencode banyancode + mcp-server 589 pass.

## Blocked / TODO
- **npm publishing blocked: `NPM_TOKEN` secret is invalid** (preflight `npm whoami` fails; dev canary run 39369793281 failed at npm publish). User must create a new npm token and update the repo secret. Then merge `fix-prompt-hang` to `main` (version already 26.10.8) so tag-release publishes, and re-push `dev` for a canary.
- PR for `fix-prompt-hang` → `main` not opened yet.
- This Claude session's own banyancode MCP needs `/mcp` → Reconnect (it failed at startup on the old binary).
- Follow-ups: cross-module edges resolved by bare name (`layer`/`defaultLayer` collisions inflate transitive callers); callers attributed to whole `layer` factories instead of inner methods; `task_start` reports cost 0 when it finishes within wait; ~38k input tokens per trivial sub-agent task.
- Backups of moved data (restore if needed): `D:\banyancode-backup-20261020\` (3.1 GB drive-root DBs, old repo `.banyancode`), `C:\Users\ekagr\banyancode-backup-20261020\` (home `.banyancode`, cache, snapshot).
