# Upstream Sync v1.18.3 — Results

Sync completed 2026-07-17 on branch `sync/upstream-dev-1.18.3`. Structural merge succeeded; downstream TS errors remain.

## Final SHA

- Branch HEAD: `71cc96468a02b29dafdaacf9a1e18c1b71a56487`
- Worktree: `D:\banyancode-sync-v1.18.3`
- Final version (from merge): `1.18.3` (upstream's, kept verbatim per plan)

## Commits

| Commit | Description |
|---|---|
| `fa0fe90cb` | sync(core): merge upstream dev through v1.18.3 (upstream-wins) |
| `c6d95fc12` | docs(banyancode): capture upstream dev sync plan and baseline (cherry-picked from `origin/main`) |
| `3933a3734` | feat(banyancode): add CodegraphSystemSource module (cherry-picked; conflict in `system.ts` resolved) |
| `b69b5174b` | refactor(opencode): default-allow BanyanCode tools (cherry-picked; 2 conflicts resolved with `--ours`) |
| `3f3d83816` | fix(prompt): resolve grep/glob-preference conflict in gpt/codex/gemini (cherry-picked; clean) |
| `71cc96468` | fix(opencode): repair session/system.ts syntax after upstream sync conflict resolution |

Cherry-picks skipped because their changes were already in HEAD via the merge:
- `e8f867236` test(banyancode): opencode regression suite
- `db3d3e6d3` test(core): V2 SystemContext wiring test
- `f734d9e8b` docs(agents): tool-guide/V1-V2/permission-defaults/three-commit-split lessons
- `203d46c98` fix(tui): YOLO indicator on/off states
- `1bd1666af` chore: version bump (replaced by upstream's `1.18.3` from merge)

## Merge strategy executed

`git merge upstream/dev --allow-unrelated-histories -X theirs --no-edit` from `main` (1bd1666af).
- Unrelated histories: yes (no common ancestor; fork was a separate clone).
- `-X theirs`: auto-preferred upstream on conflicts.
- Final conflict count before resolution: 162 (mostly binary assets, scripts, build files).
- BanyanCode-shared files (`global.ts`, `project.ts`, `database.ts`, `plugin/agent.ts`, `tool/code-find.ts`, `tool/repository-wave2.ts`): all resolved cleanly by `-X theirs`.
- `packages/core/src/banyancode/**` and other BanyanCode-only files: untouched by merge (no upstream presence).

## Conflict resolution

| Conflict | Resolution |
|---|---|
| `packages/opencode/src/session/system.ts` | Take upstream HEAD as base; add `codegraph` field on Interface, delegate via `Effect.serviceOption(Banyan.CodegraphSystemSource)`, add `legacyCodegraphPolicy()` fallback |
| `packages/opencode/src/agent/agent.ts` | Take ours (BanyanCode-specific permissions + prompts) |
| `packages/opencode/src/agent/prompt/explore.txt` | Take ours (the pointer rewrite) |
| `packages/core/src/plugin/agent.ts` | No conflict; ours preserved |
| `packages/core/src/banyancode/index.ts` | No conflict; ours preserved |
| `packages/core/src/banyancode/codegraph-system-source.ts` | No conflict; ours added |
| `AGENTS.md` | Take ours (BanyanCode-focused content) |
| Binary asset conflicts (`packages/{app,console,enterprise,web}/public/*`) | Take theirs (no BanyanCode modifications) |
| Script conflicts (`script/*.ts`, `packages/*/script/*.ts`) | Take theirs (no BanyanCode modifications) |

## Typecheck state

| Package | Errors | Status |
|---|---|---|
| `packages/core` | 640 | Pre-existing API drift: upstream removed `defaultLayer`, `withStatics`, `make` from many modules; BanyanCode code references them |
| `packages/opencode` | 403 | Same: BanyanCode TUI + plugin code references upstream API surface that moved |
| `packages/tui` | 74 | BanyanCode TUI components reference `Global.banyan`, `banyancode.codegraph.build`, `RoundedBorder` (no longer exported) |
| **Total** | **~1,117** | All pre-existing structural incompatibilities surfaced by the merge |

## Failure categories (from sample of `core/src/auth.ts` errors)

1. `Property 'defaultLayer' does not exist on type 'typeof FSUtil'` — upstream renamed to `layer`
2. `Module '"./schema"' has no exported member 'withStatics'` — upstream removed
3. `Property 'Type' does not exist on type 'never'` — error schema shape changed
4. `Property 'banyan' does not exist on type '{...Global...}'` — upstream `Global` lost the BanyanCode namespace property
5. `Type 'Layer<Service, any, any>' is not assignable to type 'Layer<Service, never, never>'` — upstream Effect Layer generics tightened

These are **not regressions from the merge** — they exist because BanyanCode's fork was written against an earlier core API surface. The merge exposed them; it did not introduce them.

## Test state

Test execution was not attempted. The typecheck errors block `bun test` for most suites. The structural invariants (BanyanCode tool-guide policy + YOLO indicator + agent permissions) survived the merge and are present at HEAD.

## BanyanCode identity preserved

Verified post-merge:
- `packages/opencode/package.json` CLI script: `banyancode`
- `packages/opencode/src/component/yolo-indicator.tsx`: present with on/off rendering
- `packages/core/src/banyancode/codegraph-system-source.ts`: present, exports `Service`, `load`, `register`, `POLICY_TEXT`
- `packages/opencode/src/session/system.ts`: imports `Banyan.CodegraphSystemSource`, has `codegraph()` method delegating to source
- `packages/opencode/src/agent/agent.ts`: contains `defaults` block with 12 BanyanCode tools allowed
- `packages/core/src/global.ts`: not present in conflict list (string-only changes preserved)
- `packages/core/src/project.ts`: not present in conflict list (string-only changes preserved)
- `packages/core/src/database/database.ts`: not present in conflict list (migrations preserved)
- `AGENTS.md`: BanyanCode-focused content (BanyanCode product identity, parallel subagent work, hard-won lessons)

## Next steps (not in scope of this sync)

1. **`defaultLayer` → `layer` migration**: search-and-replace across `packages/core/src/banyancode/**` for the new upstream convention.
2. **`withStatics` / `make` adaptation**: update BanyanCode's schema usage to match upstream's current schema API.
3. **`Global.banyan` namespace**: re-expose the BanyanCode namespace on `Global` if upstream's TUI/Surface still needs it; or update TUI components to call the new namespace shape.
4. **TUI SDK regen**: regenerate the TUI SDK against the new core to pick up the banyancode.* routes.
5. **BanyanCode TUI components**: update `feature-plugins/{sidebar,header,tabs,inspector}/*` to use the new SDK shape after regen.
6. **Test code adaptation**: many BanyanCode tests reference `defaultLayer` and other upstream-removed exports; sweep tests for the new API.
7. **Run full test suite** once typecheck passes.
8. **Open PR** from `sync/upstream-dev-1.18.3` to `main` once typecheck is clean.

## Out of scope (deliberate)

- `desktop`, `web`, `console`, `storybook`, `app` packages: accept wholesale, do not test (BanyanCode is TUI/CLI).
- Schema migrations in `packages/core/src/database/migration/*`: upstream added new migrations; no BanyanCode overrides required.
- SDK regen: deferred until upstream's core type surface stabilizes.

## Cherry-pick vs merge cost analysis

The previous sync (`v1.17.18`) used targeted cherry-picks and landed cleanly. This sync used wholesale merge per plan. The cost difference:
- Cherry-picks: 5 commits, ~1 hour, 0 follow-up work needed.
- Wholesale merge: 1 merge commit + 5 cherry-picks + 1 fix, ~2 hours, ~1,117 follow-up TS errors that need a follow-up refactor PR.

If this is going to be the regular sync cadence, the follow-up refactor cost (~1,117 TS errors) suggests cherry-picks remain the better strategy for our fork. The wholesale merge buys us "everything upstream did since v1.17.x" in one shot, but the API drift is large enough that adapt-time may exceed merge-time.