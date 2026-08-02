# Goal

fix the pre existing failures, push, and publish

## Analysis

Identified 5 pre-existing test failures (independent of the just-shipped
code_find fix) across 3 test files. None were introduced by `bd1907037`
or `d61b19be3`.

### Failure A — `agents-md-staleness > Permission.ask is a valid exported symbol`

- File: `packages/core/test/banyancode/agents-md-staleness.test.ts:47-50`
- Test builds a full source-tree index (`D:/OpenCode` excluding `node_modules`,
  `dist`, `.git`, `coverage`, `.turbo`) and asserts the index contains the
  substring `"Permission.ask"`.
- The 30s timeout fired. Either the source scan is too slow (it reads every
  `.ts/.tsx/.js/.jsx/.sql` file via `Bun.file(...).text()`) OR the substring
  is genuinely missing from all source files.
- `packages/opencode/AGENTS.md` (line 83) says: `<!-- function renamed from
  evaluateInput to Permission.ask -->`. If the rename was reverted or never
  completed, the literal `Permission.ask` identifier will not appear anywhere
  in source, and the test fails.
- Root-cause investigation needed: does `Permission.ask` exist as a literal
  identifier in source? If not, either (a) restore the identifier usage
  somewhere authoritative, or (b) update the test to assert against the
  actual exported name (`Permission.evaluate` based on recent commits).

### Failure B/C — `BanyanConfigService.updateAgentPrompt` (2 tests)

- File: `packages/core/test/banyancode/banyan-config-prompts.test.ts:52-88`
- Tests 1 and 2 fail; Test 3 (which pre-populates `agent: { explorer: {
  enabled: false } }`) passes.
- Symptom: `updateAgentPrompt("coder", "...")` on a fresh config returns
  `{ agent: { coder: { prompt: "..." }, explorer: { enabled: false } } }`
  instead of just `{ coder: { prompt: "..." } }`.
- Test 3 makes the expected behavior explicit: only entries that were
  already present should be preserved. The `explorer: { enabled: false }`
  entry is being added by the implementation even when the on-disk config
  had no `agent` section.
- Root-cause investigation: trace `BanyanConfigService.updateAgentPrompt`
  in `packages/core/src/banyancode/banyan-config.ts`. The merge logic
  probably conflates "merge with on-disk" (preserve existing) with "merge
  with default schema" (which seeds explorer).

### Failure D/E — `repository-intel-tool.ts consolidation` (2 tests)

- File: `packages/core/test/banyancode/schema-alignment.test.ts:159-168`
- Test asserts `packages/core/src/banyancode/tools-layer.ts` and
  `packages/opencode/src/tool/registry.ts` both `import ... from ".../
  repository-wave2"` (i.e., `RepositoryWave2`) and do NOT contain the
  substring `RepositoryIntelTool`.
- The test was authored for a planned refactor — `RepositoryIntelTool` was
  renamed to `RepositoryWave2`. The files were never refactored.
- Root-cause investigation: locate `RepositoryIntelTool` references in
  `tools-layer.ts` and `registry.ts`, rename the imports + any downstream
  callsites to `RepositoryWave2`. Update the namespace projection in
  `repository-wave2.ts` if needed so `RepositoryWave2` is the canonical
  name.

## Steps

1. **Investigate each failure** — open the failing test file + the
   implementation files, capture the exact current behavior and what the
   test expects.
2. **Failure A** — confirm whether `Permission.ask` exists as a literal
   in any `.ts` file under `packages/`. If it does, find why the
   substring doesn't appear in the index (e.g., file is in an excluded
   path). If it doesn't, update the test to assert the actual identifier
   (`Permission.evaluate` per recent commits).
3. **Failure A** — also check the test timeout: 30s may not be enough
   for the source scan. If the scan legitimately takes >30s on this
   repo, bump the timeout. If it completes in <5s on a clean run, the
   timeout itself isn't the issue.
4. **Failure B/C** — trace `BanyanConfigService.updateAgentPrompt`. Fix
   the merge logic so a fresh config yields ONLY the agent that was just
   updated (no auto-seeded `explorer`). Preserve the existing-on-disk
   semantics (Test 3 must still pass).
5. **Failure D/E** — rename `RepositoryIntelTool` → `RepositoryWave2`
   in `packages/core/src/banyancode/tools-layer.ts` and
   `packages/opencode/src/tool/registry.ts`. Update the file
   `packages/core/src/banyancode/repository-wave2.ts` if its
   self-reexport namespace is currently `RepositoryIntelTool` instead.
   Update downstream callsites (`codegraph-analyzer.ts`,
   `repository-intel-tool.ts`, any tool registrations). Re-run all
   codegraph tool tests to confirm no regression.
6. Run the broader `bun test test/banyancode/` suite to confirm no
   other tests regress.
7. Run `bun typecheck` from `packages/core` and `packages/opencode`.
8. Run `bun turbo typecheck` (pre-push hook).
9. Commit fixes in logical groups (one commit per failure if they're
   independent, or one combined commit if a single root cause ties
   them). Use `fix(scope): summary` format.
10. Bump version `26.07.62` → `26.07.63` via
    `packages/opencode/package.json:3`.
11. `git push origin main` and verify the pre-push typecheck passes.
12. Cut the release tag: `git tag -a v26.07.63 -m "BanyanCode
    26.07.63" <bump-sha> && git push origin v26.07.63`.
13. Verify npm publish via `npm view banyancode version` and
    `gh release view v26.07.63 --repo EkagraAgarwal/BanyanCode
    --json isPrerelease,assets`.

## Exit Criteria

The reviewer judges pass when ALL of the following hold:

1. `bun test packages/core/test/banyancode/agents-md-staleness.test.ts`
   — both tests pass, no timeout.
2. `bun test packages/core/test/banyancode/banyan-config-prompts.test.ts`
   — all 3 tests pass.
3. `bun test packages/core/test/banyancode/schema-alignment.test.ts`
   — all tests pass (including the 2 `RepositoryWave2` checks).
4. `bun test packages/core/test/banyancode/` exits 0 — full banyancode
   suite green.
5. `bun typecheck` from `packages/core` succeeds.
6. `bun typecheck` from `packages/opencode` succeeds.
7. `git log origin/main -3` shows the new fix commit(s) and the version
   bump on top.
8. `npm view banyancode version` returns `26.7.63` (CalVer without
   leading zero per AGENTS.md).
9. `gh release view v26.07.63 --repo EkagraAgarwal/BanyanCode
   --json isPrerelease` returns a release object (promoted from
   `--prerelease` to GA per AGENTS.md publish workflow).

## Out of Scope

- Refactoring the source-index algorithm in `agents-md-staleness.test.ts`
  beyond what's needed to make the assertion accurate (e.g., switching
  to `git ls-files` for performance). The fix should match the test's
  existing intent, not redesign it.
- Renaming anything other than `RepositoryIntelTool` → `RepositoryWave2`.
- Touching any test that already passes.
- Reverting the just-shipped `bd1907037` fix.
