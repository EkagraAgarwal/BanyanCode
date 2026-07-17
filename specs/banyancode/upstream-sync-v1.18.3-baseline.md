# Upstream Sync Baseline

Captured 2026-07-17 on `main` HEAD before merge.

## SHAs

| Ref | SHA | Version |
|---|---|---|
| `main` (our fork) | `1bd1666af25902beaa37bad38460520c7b7f1d42` | `26.07.4` |
| `upstream/dev` (merge source) | `3a1c6df9e24672f0761a6ced18e1315d89334baf` | `1.18.x` (dev tip) |
| `v1.18.3` (release checkpoint) | `127bdb30784d508cc556c71a0f32b508a3061517` | `1.18.3` |
| Last sync base | `6eba1466a86638d0492b99f6f17004b7cddbedcf` | `1.17.3` |

## Typecheck baseline (all `exit=0`)

| Package | Result |
|---|---|
| `packages/core` | clean |
| `packages/opencode` | clean |
| `packages/tui` | clean |

## Test baseline

| Suite | Pass | Fail | Notes |
|---|---|---|---|
| `packages/opencode/test/agent/ + test/banyancode/` | 340 | 2 | Both failures pre-existing flakes: `skill directories are allowed for external_directory` (timeout), `defaultAgent throws when all primary agents are disabled` (timeout). Confirmed present on `origin/main` HEAD without our recent commits. |
| `packages/core/test/banyancode/` | 610 | 0 | Clean |

## Conflict candidates (from `git diff --name-only 6eba1466a..upstream/dev`)

Files we modify that upstream also touched:
- `packages/core/src/database/database.ts`
- `packages/core/src/global.ts`
- `packages/core/src/project.ts`
- `packages/core/src/plugin/agent.ts`
- `packages/core/src/tool/code-find.ts` (NEW in fork)
- `packages/core/src/tool/repository-wave2.ts` (NEW in fork)

## Recent BanyanCode commits to preserve

| SHA | Title |
|---|---|
| `7998ad094` | feat(banyancode): add CodegraphSystemSource module and delegate V1 codegraph block |
| `133231ef0` | refactor(opencode): default-allow BanyanCode tools and strip duplicated policy prose from subagent prompts |
| `469b55b18` | fix(prompt): resolve grep/glob-preference conflict in gpt, codex, and gemini provider prompts |
| `e8f867236` | test(banyancode): regression suite for codegraph tool guide policy and per-agent rendering |
| `db3d3e6d3` | test(core): V2 SystemContext wiring test for BanyanCode codegraph policy |
| `f734d9e8b` | docs(agents): add tool-guide, V1/V2, permission-defaults, and three-commit-split lessons |
| `203d46c98` | fix(tui): show YOLO mode indicator in both on and off states |
| `1bd1666af` | chore(opencode): bump version to 26.07.4 |