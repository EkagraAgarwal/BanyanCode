# TUI redesign: todo

Brief: `specs/banyancode/tui-redesign-handoff/HANDOFF.md`. Status: `[ ]` open, `[~]` in progress, `[x]` done and verified.

## Round 1
- [x] Home: looping sparkle and color cycle after growth (owner's decision, replaces "stop within 8 seconds" on Home only) (committed, owner to verify)
- [x] Home: fuller, taller, narrower, irregular canopy (committed, owner to verify)
- [x] Home: layout fixes: `RESUME` overlap, footer directory at 100 columns, untitled sessions, compact `^p cmds` hint (committed, owner to verify)
- [x] Sidebar: context bar stretches like the system bars (committed, owner to verify)
- [x] Sidebar: remove cost and tokens from subagent rows (committed, owner to verify)
- [x] Sidebar: padding between the scrollbar and the text (committed, owner to verify)
- [x] Shared chrome: canopy line, single-status top and bottom rows, motion and data helpers (committed, owner to verify)

## Round 2
- [x] Sidebar: Performance and Usage bars stretch too (committed, owner to verify)
- [x] Trunk: rail data, layout, branch motion (committed, owner to verify)
- [x] Trunk: panels overlay, `session_layout` setting, narrow-terminal status row (committed, owner to verify)
- [x] Grove: layout, real data, motion (committed, owner to verify)
- [x] Transcript polish: tool settle, token bloom, live subagent rows (committed, owner to verify)

## Round 3
- [x] Full `packages/tui` and `packages/banyancode-tui` suites, typecheck, ledger (5 `tui` failures, all also failing on clean `v2-base`)
- [x] Local Windows binary for the owner to test

## Round 5: Agents tab, "Understory" first slice (owner's scope)
Brief: `D:\opencode\specs\tui-redesign-handoff\agents-tab.html`. Owner chose: smallest slice, classic header, `s` steers only the selected agent, replay marks in memory (when replay is built).
- [x] Steer one session by id; finished and failed agents can be steered again
- [x] Pure data: roster tree with killed agents kept, display suffixes, states, merged stream log
- [x] Roster, Stream and inspector replace Grove on the Agents tab (committed, owner to verify)
- [x] Share one project DB across install channels, and adopt an existing channel DB (committed, owner to verify)
- [x] Fix the sidebar System monitor not refreshing (committed, owner to verify)
- [x] Verify the read/grep/glob → codegraph tool router end to end and fix what it exposes (committed; the rewrite was failing in the default config)
- [x] Full suites, typecheck, ledger, new Windows binary, new dev tag (`v26.11.0-dev.44b8edd`)
- Deferred: Trace, replay, overview, Roots, stale-edit warnings, composer `@` routing

## Round 4 (owner feedback)
- [x] Chat page matches the owner's screenshot: classic layout by default, `v2-base` header and footer, sidebar fixes kept; Trunk becomes opt-in (committed, owner to verify)
- [x] Failed Trunk branches can be dismissed (committed, owner to verify; killed agents already leave mesh status)
- [x] Delete the unused `AgentTreeView` and its render tests (committed)
- [x] Full suites, typecheck, ledger, new Windows binary (5 `tui` failures, all also failing on clean `v2-base`)
- [ ] Owner checks by hand: sizes, multi-agent run, `max-subagents` 20, a pending permission, a failed agent (no WSL or tmux unless the owner asks)
