# Agents tab: finish D · Understory

Goal: the real Agents tab matches `D:\opencode\specs\tui-redesign-handoff\agents-tab.html` (the brief is the
`<script id="brief">` block at lines 10-315 of that file; it replaces the Grove section of HANDOFF.md).

Work happens in the `D:\bc-tui-redesign` worktree on `tui-trunk-grove`. `D:\opencode` is the frozen v1 fork.

## Why it doesn't match today

1. **Host layout.** The tab is mounted as a `main` panel inside the session pane, so the classic sidebar and
   inspector stay docked around it. Understory gets about 100 columns: medium roster, no docked inspector.
2. **Only the first slice shipped.** Roster, Stream and inspector exist. Lens tabs, overview, ruler, Trace lanes,
   the now column, Roots, replay and composer routing don't.
3. **Row drawing.** `LineView` spans have a foreground only. Sub-cell blocks and overview layers need a
   foreground and a background per cell, at a cost that holds with 20 agents.
4. **Chrome.** The classic header and footer keep "0 need attention". The mockup uses the canopy chrome.
5. **Roster shape.** No trunk rail, no sparkline, and rows don't line up with lanes.

## Decisions

- The Agents tab is full-bleed: no sidebar or inspector columns while it is active, in either `session_layout`.
  The Chat tab doesn't change.
- The Agents tab always uses the Trunk header and footer. Classic stays the Chat default.
- Real data only. The mock's token wobble is decoration: if there is no signal, draw a flat bar for the turn.
- Replay only reads existing parts, filtered by timestamp. Nothing extra is recorded.
- Lead does all commits. No push, tag or publish. The final binary is a local build.

## Module layout

```
packages/banyancode-tui/src/
  data/understory.ts          roster, stream, sheets (exists)
  data/understory-spans.ts    tool and turn spans, token buckets, now text, stale edits: pure, takes time T
  data/understory-map.ts      treemap, heat, blast walk: pure
  components/understory/
    index.tsx                 shell: layout, keys, mount of the active lens
    view.ts                   shared view state: lens, playhead, window, pinned call, file, overlays
    cells.tsx                 CellGrid: per-cell glyph, fg, bg drawing, with a test-visible frame
    layout.ts                 columns, lane height, row alignment (exists)
    roster.tsx                trunk tree with lane-aligned rows
    inspector.tsx             File / Call / Run / Agent sheets
    lens-tabs.tsx             1 Trace 2 Roots 3 Stream, LIVE clock
    stream.tsx                moved out of index.tsx
    trace/                    overview, ruler, lanes, now column
    roots/                    treemap, braille curves
```

## Waves

Each wave runs in background subagents with no file overlap. Lead reviews, runs checks and commits between waves.

| Wave | Task | Owns |
|---|---|---|
| 0 | Reference frames from the mockup, at all 5 sizes | scratch dir only |
| 0 | Host: full-bleed tab and canopy chrome | `packages/tui` hook, `status/session-chrome.tsx`, `panels/inspector.tsx`, `v2-patches.md` |
| 0 | Foundation: CellGrid, theme roles, view state, split `index.tsx`, span data | `components/understory/*`, `data/understory-spans.ts`, `theme.ts`, theme schema |
| 1 | Trace lens: overview, ruler, lanes, now column, zoom | `understory/trace/*` |
| 1 | Roster and inspector to spec, including Call and File sheets | `roster.tsx`, `inspector.tsx` |
| 1 | Roots lens: map, heat, curves, stale edits, blast radius | `understory/roots/*`, `data/understory-map.ts` |
| 2 | Replay across all panes, Stream follow | `view.ts`, `index.tsx`, lens glue |
| 2 | Composer routing: `@label` steers one branch, picker, replay guard | composer slot, `data/` |
| 3 | Real tmux run at 200x55, 168x48, 120x40, 100x30, 80x24, compare with frames, fix | as found |
| 4 | Checks, then a local dev binary | `packages/opencode/script/build.ts --single` or the v2 equivalent |

## Done means

The checklist in section 17 of the brief, plus: a dev binary the owner can run. Anything not verified gets reported.
