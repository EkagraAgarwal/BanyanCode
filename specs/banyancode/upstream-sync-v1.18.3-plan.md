# Upstream dev Sync Plan: v1.18.3

Sync `anomalyco/opencode` `dev` into the BanyanCode fork to capture everything that landed between our last sync (`6eba1466a`) and `upstream/dev` at `3a1c6df9e`, with `upstream/v1.18.3` (`127bdb307`) as the documented release checkpoint.

Validated 2026-07-17 against `main` (`1bd1666af`, version `26.07.4`) and `upstream/dev` (`3a1c6df9e`).

## Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Target | `upstream/dev` | Carries post-`v1.18.3` bug fixes; tag is just a snapshot |
| Base | `main` | Preserves the 6 new BanyanCode commits from the tool-guide work |
| Strategy | Merge | 15,010 commits since last sync — too many to cherry-pick selectively |
| Scope | Wholesale | Accept upstream changes incl. app/web/desktop/storybook; BanyanCode stays TUI/CLI but receives the full mechanical update |
| Docs | `specs/banyancode/upstream-sync-v1.18.3-*.md` | Same dir as prior sync artifacts |

## Conflict hotspots

BanyanCode-shared files modified in upstream between `6eba1466a` and `upstream/dev`:

| File | BanyanCode change | Expected upstream churn |
|---|---|---|
| `packages/core/src/database/database.ts` | Added codegraph + memory tables, migrations | Low — migrations dir may grow |
| `packages/core/src/global.ts` | `app = "opencode"` -> `"banyancode"` | String-only path fix; unlikely to change |
| `packages/core/src/project.ts` | Path strings `opencode` -> `banyancode` | String-only; unlikely to change |
| `packages/core/src/plugin/agent.ts` | V2 `BUILD_SYSTEM` / `PROMPT_EXPLORE` rewrites | V2 wiring is fork-only; minimal conflict |
| `packages/core/src/tool/code-find.ts` | NEW file (BanyanCode) | Naming collision possible; resolve by keeping ours + porting upstream |
| `packages/core/src/tool/repository-wave2.ts` | NEW file (BanyanCode) | Same as above |

## Resolution rules

| Area | Resolution |
|---|---|
| `packages/core/src/banyancode/**` | Keep BanyanCode unless upstream adds identically-named feature, then merge behaviors |
| `global.ts`, `project.ts`, config paths | Preserve BanyanCode identity (`banyancode`, `.banyancode`, `BANYANCODE_*`, `banyancode.db`) |
| Database schema / migrations | Keep upstream migrations AND BanyanCode tables; never destructive |
| V1/V2 system prompts | Keep `CodegraphSystemSource` pointer + tool-guide policy |
| Provider code | Take upstream wholesale, preserve BanyanCode-only endpoint wiring |
| Permissions | Keep upstream + BanyanCode tools; preserve explicit `explore` allows after `"*": "deny"` |
| Generated SDK / OpenAPI | Take upstream generation; regenerate after schema conflicts resolve |

## Execution phases

1. **Isolate** — write this plan + baseline/results docs, create `sync/upstream-dev-1.18.3` branch, capture baseline
2. **Merge** — `git merge upstream/dev --no-ff`, resolve conflicts per the table above
3. **Reconcile** — verify all 6 recent BanyanCode commits survived: `CodegraphSystemSource`, agent permissions, provider prompt edits, 130 new tests, YOLO indicator, AGENTS.md lessons
4. **Regenerate** — `./packages/sdk/js/script/build.ts` after schema resolution
5. **Validate** — typecheck + targeted tests; known unstable suites: `prompt.test.ts`, some `agent.test.ts`, `codegraph-manual-build.test.ts`
6. **Commit** — 6 commits: docs, merge, sdk-regen, test reconciliation, results, version bump
7. **Push** — push `sync/upstream-dev-1.18.3`, open PR into `main`

## Validation gates

```powershell
# Typechecks
cd packages/core; bun typecheck
cd packages/opencode; bun typecheck
cd packages/tui; bun typecheck

# BanyanCode regressions
cd packages/opencode
bun test test/banyancode/
bun test test/agent/

cd packages/core
bun test test/banyancode/

# Full pre-push gate
bun turbo typecheck
```

## Risks

| Risk | Mitigation |
|---|---|
| Naming collision at `code-find.ts` / `repository-wave2.ts` | Resolve by keeping BanyanCode implementation; port any upstream capability onto ours |
| Drizzle schema drift | `bun test packages/core/test/banyancode/codegraph-indexer.test.ts` after merge |
| SDK regen produces noisy diff | Isolate in its own commit so merge commit stays small |
| `chore: generate` floods the diff | Accept wholesale; typecheck catches real issues |
| 6 new commits lost during conflict resolution | Reconciliation step explicitly checks each |

## Out of scope

- Re-bumping to upstream v1.18.x version strings (we keep `26.07.x`)
- Adopting upstream UI features (sidebar, model picker)
- BanyanCode-only feature additions