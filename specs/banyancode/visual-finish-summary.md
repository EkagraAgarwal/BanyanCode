# BanyanCode Visual Finish — Final State and Limitations

End-of-pass snapshot of the visual-finish rework. Captures what shipped on `ui-v2-finish`, the inevitable limitations of expressing a CSS/web aesthetic through a TUI renderer, and the items deferred with their reasons.

The "what shipped per phase" lines cite commit SHAs and the actual files; "limitations" categorizes the items the spec asked for that the renderer fundamentally cannot produce, plus the residual issues found while implementing.

---

## 1. Branch and commit log

Branch: **`ui-v2-finish`** (local only, not pushed). Stacked on `ui-v2-overhaul` which already carried PRs 1A–3 + 4a–4b + A–E + Temp-removal.

```
ui-v2-finish (9 commits on top of ui-v2-overhaul):
971e2b4 fix(tui): revert step-indicator pill rounding + drop prompt bg fill
ffba71f fix(tui): phase 8 - polish per user feedback
36955db feat(tui): visual finish phase 7 - density tightening + bold stripping
9a702ff docs(specs): ui-v2 §15 - visual finish translation notes
edc5c78 feat(tui): visual finish phase 5 - dashed aggregate divider
289ecbf feat(tui): visual finish phase 4 - chat shell rounded borders
8c3cb00 feat(tui): visual finish phase 3 - structural panels, separator, attention items
9fba0fb feat(tui): visual finish phase 2 - status pills become pill-shaped containers
58dbd9d feat(tui): visual finish phase 1 - border presets, separator hover, palette helpers
```

23/23 monorepo packages green (`bun turbo typecheck`). TUI suite: **212 pass, 0 fail, 20 snapshots**.

Prior `ui-v2-overhaul` stack (preserved unchanged): the message-block pipeline, attention strip, sidebar widgets, inspector widgets, codebase tree, system monitor, performance widget, attention severity, plus all the post-overhaul polish (graph tab/codegraph layers removed, top/bottom bars simplified, context widget redesigned, etc.).

---

## 2. What shipped, per phase

### Phase 1 — Foundations (`58dbd9d`)
- `packages/tui/src/ui/border.ts` — added `RoundedBorder` (`╭╮╰╯` corners, `─│` edges, `┬┴├┤┼` junctions), `RoundedTopBorder`/`RoundedBottomBorder` for single-edge rounding, `DashedDividerChars` (`╌`).
- `packages/tui/src/component/resizable-separator.tsx` — added `onMouseOver`/`onMouseOut`; resting fill = `theme.border`, hover = `theme.primary`, drag = `theme.primary` (drag wins).
- `packages/tui/src/util/palette.ts` (new, 21 lines) — `severityFill(panel, accent, severity)` and `pillFill(...)` helpers using the existing `tint()` blend at alpha 0.18 (severity) / 0.108 (pill). Theme-token inputs only. Severity union: `success | warning | error | info | neutral`.

### Phase 2 — Status pills → pill shape (`9fba0fb`)
- `packages/tui/src/feature-plugins/header/status-pills.tsx` — top-bar pills (`● 0 active`, `● MCP: MiniMax`, `● LSP: off`) wrapped in small rounded containers with `RoundedBorder` chars, semantic border + `pillFill()` tinted bg. Pipes removed; `gap={2}` on parent row. `accentForSeverity()` picks the right `theme.*` for the fill.
- `packages/tui/test/feature-plugins/header/status-pills.test.tsx` — stub theme upgraded to `RGBA.fromInts()` instances (required for `borderColor`/`backgroundColor` props to resolve).

### Phase 3 — Structural panels (`8c3cb00`)
- `packages/tui/src/routes/session/sidebar.tsx:30-43` — outer `<box>` gets `RoundedBorder` chars, full 4-side border, `theme.borderSubtle`, `theme.backgroundPanel` surface. `marginTop={1}` + `marginBottom={1}` for canvas inset. Removed redundant `paddingTop`/`paddingBottom`.
- `packages/tui/src/routes/session/index.tsx:1449-1461` — inspector container same treatment as sidebar.
- `packages/tui/src/component/resizable-separator.tsx:46` — resting fill changed from `theme.border` to `theme.background` (matches canvas, invisible at rest).
- `packages/tui/src/component/attention-strip.tsx:118-150` — outer strip is borderless full-width; each alert is a rounded pill with `severityFill` bg + matching semantic border. Severity mapping: `blocked`→error, `permission (diff)`→warning, `permission (regular)`→info, `question`→info, `lsp`/`mcp`→warning. `accentForSeverity(item)` and `severityForKind(item)` helpers (the latter fixed a `kind as Severity` unsound cast introduced by the subagent).

### Phase 4 — Chat shell (`289ecbf`)
- `packages/tui/src/component/message-block.tsx` — full 4-side `RoundedBorder` on the container with `borderColor={mode accent}` and `backgroundColor={theme.backgroundPanel}`. Three buttons (✓/✕/ⓘ) each wrapped in small rounded boxes with semantic border + `severityFill` tinted bg.
- `packages/tui/src/component/prompt/index.tsx:1571-1599` — outer composer wrapper gets `RoundedBorder`, `theme.borderSubtle`, `theme.backgroundElement`.
- `packages/tui/src/ui/toast.tsx` — full 4-side `RoundedBorder`, border color follows toast variant.
- Plan deviation: the `SplitBorder → RoundedBorder` swap was partially reverted in `routes/session/index.tsx:1294/1532/1668/2146`, `routes/session/permission.tsx:509/670`, `routes/session/question.tsx:290`, `routes/session/subagent-footer.tsx:73`. These are chat-content elements using `border={["left"]}` only; swapping the char set without expanding the border was a no-op visually and a misleading code change. They keep `SplitBorder` for the heavy-vertical `┃` left accent identity.
- Updated snapshot: `packages/tui/test/component/__snapshots__/message-block.test.tsx.snap`.

### Phase 5 — Dashed divider (`edc5c78`)
- `packages/tui/src/feature-plugins/sidebar/agents.tsx` — added a `╌`-character row before the "Total across all agents" aggregate row, `theme.borderSubtle`. Renamed "Total:" → "Total across all agents". Narrow scope per plan (only this one site).

### Phase 6 — Skip documentation (`9a702ff`)
- `specs/banyancode/ui-v2.md` §15 — translation table (spec→outcome with one-line skip reasons), "what the implementation produced" summary, phase log table.

### Phase 7 — Density tightening + BOLD stripping (`36955db`)
- 13 dialog/panel files: `paddingLeft/Right={2}` → `1` on outer container padding.
- `routes/session/index.tsx:1201` only: `gap={2}` → `gap={1}` on the top-bar row flex.
- 7 widget files: stripped `<b>` from already-uppercase labels (AGENT DETAILS, AGENT ACTIVITY, TODO, PENDING ACTIONS, AGENTS, CONTEXT, GRAPH EXPLORER).
- `.gitattributes` — added `packages/tui/**/* text eol=lf`. The 19 files touched in this phase were stored as CRLF in git's object store; this commit normalizes them to LF. Diff appears large (3126 inserts/3125 deletes) but `git diff -w HEAD` shows the actual semantic change is 21 files / 24 inserts / 24 deletes.

### Phase 8 — Polish per user feedback (`ffba71f`)
- `packages/tui/src/feature-plugins/sidebar/context.tsx` — context bar replaced ASCII `█`/`░` with real `<box>` segments, `BAR_WIDTH` 18 → 36, per-segment proportional widths against model context limit (no minimum-1 floor). Free portion uses `theme.backgroundElement`.
- `packages/tui/src/component/attention-strip.tsx` — dropped the `lspDown` memo + the `LSP down` item creation; dropped the trailing `dismiss ×` chip + `flexGrow` spacer; dropped `onDismissAll` prop and prop wiring.
- `packages/tui/src/routes/session/index.tsx:1669-1681` — error block simplified: removed `backgroundColor={theme.backgroundPanel}` fill, `borderColor` error → `borderSubtle`, paddingTop/Bottom 1 → 0.
- `packages/tui/src/feature-plugins/sidebar/{agents,codebase-tree,performance,system-status}.tsx` — `marginTop={1}` → `0` on fallback/empty-state rows.
- `packages/tui/src/component/prompt/index.tsx:1583` — removed the redundant inner `backgroundColor={theme.backgroundElement}` on the composer wrapper inside the rounded shell.
- Subagent revert in this phase: had wrapped the wrong chips (`⌘E agents`, `⌘K commands`, etc. in `prompt/index.tsx`) for the user's "round prompt chips" request — actual target was the message step indicator (`session/index.tsx:1683`).

### Phase 8b — Step-indicator revert + prompt bg removal (`971e2b4`)
- **Reverted** the message step indicator pill rounding added in Phase 8. The agent-color pill (`local.agent.color("build")` returns orange for the build agent in some themes) rendered as a "thick orange bar" inside the rounded border — user wanted it gone. Back to plain-text span rendering.
- `packages/tui/src/component/prompt/index.tsx:1576` — removed `backgroundColor={theme.backgroundElement}` from the prompt composer's outer rounded box. The fill is a square that bleeds past the rounded corners (opentui limitation). Now the inner is transparent; only the rounded border outline + cursor guides remain.

---

## 3. Limitations

### 3.1 No CSS-style surface effects — fundamentally impossible in this renderer

The original visual-finish spec was written for a web/CSS layout with `rgba()`, gradients, `box-shadow`, `backdrop-filter`, `border-radius`, scrollbar styling, and alpha compositing. BanyanCode's TUI is built on opentui, which is a character-grid renderer:

- 24-bit color per cell is supported, but the terminal does not composite alpha — a "30% white" cell renders as solid 30% white; nothing shows through.
- No off-screen rendering; no `backdrop-filter`; no per-cell gradient fills; no `box-shadow`.
- Borders are limited to character-drawing art (`─│╭╮╰╯┌─┐`).
- Scrollbar width is OS/terminal controlled; only track and thumb colors can be themed.

**Documented-skipped spec items** (see `specs/banyancode/ui-v2.md §15`):

| Spec item | Outcome |
|---|---|
| 1.1 Global radial gradients (orange/blue corners) | Skipped — character grid has no per-cell gradient. |
| 1.2 Glassmorphism + backdrop blur | Skipped — no compositor. |
| 1.3 Panel sheen (subtle internal linear gradient) | Skipped — sub-perceptible at the spec'd alpha. |
| 1.4a 1px white-transparent ring | Implemented as `theme.borderSubtle` border on every panel. |
| 1.4b Drop shadow `0 14px 40px rgba(0,0,0,0.30)` | Skipped — no off-screen rendering. |
| 2.1 8px column gaps | Implemented — 1-cell canvas margins top + bottom around side panels, 1-cell separator at rest hidden. |
| 2.2 Resize handle hover illumination | Implemented. |
| 3.1 Border-radius 10/8/5/999px | Implemented as binary rounded (`╭╮╰╯`) — multiple radius values collapse to one shape in a character grid. Pill shape = box + tinted bg + horizontal padding. |
| 3.2 1px `#2b2b2b` borders | Implemented via `theme.borderSubtle`. |
| 4.1 Custom 8px slim scrollbars | Skipped — OS/terminal controlled; only `backgroundColor` is themable. |
| 4.2 Translucent colored fills | Implemented via `severityFill()` / `pillFill()` using `tint()` blend. |
| 4.3 Dashed dividers | Implemented narrowly — only the agents-widget aggregate row uses `╌`. |

### 3.2 Opentui-specific visual limits discovered during build

**Square background fills inside rounded boxes.** A `<box backgroundColor={X}>` always fills the full rectangle — the rounded-corner border chars (`╭╮╰╯`) are drawn *over* the fill at the perimeter, but the fill itself is square. Visible when the fill is heavy (≥10% alpha) and the border is thin. Mitigations possible:

- Drop the fill entirely (transparent interior) — used on the prompt composer in Phase 8b.
- Use square borders (`┌─┐` chars) where a heavy fill is unavoidable.
- Accept the artifact where the fill IS the design feature (status pills, attention strip pills, message-block action buttons).

The prompt composer is now borderless-on-the-inside. The top-bar pills, attention pills, and message-block buttons intentionally show the square fill behind their rounded borders — that visual contrast is part of the design language.

**All `<box>` widths are integer cells.** `width={X}` rounds to the nearest cell. Sub-cell precision is impossible. The new context bar uses `BAR_WIDTH = 36` cells (the practical max at typical 30-col sidebar widths), giving a granularity of ~2.7% per cell at full context. Sub-percentage usage will round to zero cells — by design.

**`<text>` has no fontSize attribute.** opentui's `TextRenderable` doesn't expose it. Characters are exactly 1 cell wide × 1 row tall. The user's "decrease text size slightly" request was asked *after* Phase 7 was merged; per their instruction ("ask me this again at the very end after everything is done"), no text-size change ships in `ui-v2-finish`. Practical TUI equivalents for "smaller text feel" that could be added later: tighten panel padding further (already done at Phase 7), reduce row gaps, strip BOLD on redundant labels (done at Phase 7), or use half-row rendering with `▀`/`▄` (significant complexity, deferred).

### 3.3 Subagent-driven scope corrections (transparent deviations from the original plan)

Three corrections required when coder-subagent implementations diverged from the locked plan:

1. **Phase 2 — accent color bug**: `mcpPillBg` always passed `theme.success` to `pillFill` regardless of severity. Fixed by adding `accentForSeverity()` that picks the matching `theme.*` per severity. `as Severity` cast was unsound; replaced with a typed `severityForKind(item: StripItem): Severity` helper.
2. **Phase 4 — wholesale SplitBorder swap**: subagent globally swapped `SplitBorder` → `RoundedBorder` across files. Several sites used `border={["left"]}` only with `SplitBorder` (which only defines `vertical: "┃"`; everything else empty). After swap, those boxes had rounded chars they didn't render. Reverted in 7 locations: `routes/session/index.tsx:1294/1532/1668/2146`, `routes/session/permission.tsx:509/670`, `routes/session/question.tsx:290`, `routes/session/subagent-footer.tsx:73`.
3. **Phase 8 — wrong chip target**: subagent rounded the keyboard-shortcut pills in `prompt/index.tsx` (e.g., `⌘E agents`, `⌘K commands`) when the user actually meant the message step indicator at `session/index.tsx:1683` (`▣ Build · MiniMax-M3 · 10.9s`). Reverted the prompt/index.tsx changes; applied chip rounding to the correct location.

### 3.4 Line-ending normalization (Phase 7)

The TUI package's files were stored as CRLF in git's object store (Windows-editor convention leftover). Phase 7 added `packages/tui/**/* text eol=lf` to `.gitattributes` and normalized the 21 files touched in that phase to LF. The cumulative diff appears noisier than the actual semantic content (24 inserts / 24 deletes vs. the diffstat's 3126/3125 — that's all line-ending normalization). Older commits on the branch (Phases 1-6) still contain CRLF in files they touched; normalization was not retroactive. Future commits will be LF.

### 3.5 Open / not-shipped items

- **Push `ui-v2-finish` to `origin`** — branch is local-only. Push has not been requested.
- **Text size / zoom** — deferred per user ("ask me this again at the very end after everything is done"). Not addressed in this branch.
- **`message-block.tsx` vertical padding `1` → `0`** — Phase 7 skip flag from subagent. The semantic change is correct but the `message-block.test.tsx.snap` needs terminal-environment frame-position regen to verify exact trailing-blank-row counts. Easy follow-up when running tests in a proper terminal.
- **Snapshot test coverage gaps** — most sidebar/inspector/attention-strip tests are render-without-throwing smoke tests with empty `""` snapshots (e.g., `system-status.test.tsx.snap`, `status-pills.test.tsx.snap`). Real visual regression requires manual terminal QA. Only `message-block.test.tsx.snap` captures non-empty text content for the diff/approve/reject flow.

---

## 4. Map: spec section → shipped outcome

For cross-referencing the spec with what's actually merged:

| Mockup element | Spec section | Ships as |
|---|---|---|
| Top-bar rounded pill chips | §1 brand text + Phase 2 | `RoundedBorder` small box per pill with semantic border + `pillFill` bg |
| Three floating columns | §4 layout + Phase 3 | sidebar/inspector with rounded border + 1-cell canvas margin top + bottom |
| Canvas-transparent separators | §4 layout + Phase 3 | `theme.background` fill at rest, `theme.primary` on hover/drag |
| Attention strip with tinted items | §5 alerts + Phase 3 | borderless full-width row, each item is a rounded pill with `severityFill` |
| Sidebar widget section headers | §6 widgets | AGENTS / CONTEXT / PERFORMANCE / SYSTEM / CODEBASE — uppercase via theme primary, **no rounded container** (user did not request) |
| Context bar at 100%, ~100-500 subdivisions | §6 context + Phase 8 | Real `<box>` segments at `BAR_WIDTH = 36` cells, no minimum floor, used/free visible |
| Performance bars | §6 performance | Unchanged from prior `ui-v2-overhaul` work |
| SYSTEM widget (CPU / RAM / Disk, no Temp) | §6 system + `198ed95` | Temperature sensor dropped earlier this session (`198ed95`); SYSTEM shows CPU / RAM / Disk only |
| Message blocks with mode-color full border | §7 chat shell + Phase 4 | Full 4-side `RoundedBorder` with mode accent (`plan`=accent, `diff`=success, `tool`=warning, `report`=borderSubtle) and `theme.backgroundPanel` block surface |
| Approve/Reject/View-diff buttons | §7 chat shell + Phase 4 | Small rounded boxes with semantic border + `severityFill` (Phase 8 keep) |
| Inspector widget headers | §8 inspector | AGENT DETAILS / AGENT ACTIVITY / TODO / PENDING ACTIONS — uppercase, `<b>` stripped in Phase 7 |
| "Total across all agents" aggregate row | §6 agents + Phase 5 | Dashed `╌` divider before the row |
| Tab strip / Chat / Sessions / Agents / Memory / Settings | §4 tabs | Unchanged, sits inside the center column's rounded container |
| Prompt composer with rounded border | §4 prompt + Phase 4 + Phase 8b | Rounded border, **transparent interior** (Phase 8b removed the bg fill that bled past the rounded corners) |
| Toast | §1 / §10 + Phase 4 | `RoundedBorder` chars with theme variant border color |

---

## 5. House-keeping / cross-references

- `specs/banyancode/ui-v2.md` — primary spec doc, §15 carries the per-item translation table; §13/§14 unchanged from prior phases.
- `packages/tui/src/ui/border.ts` — single source of truth for border presets (`EmptyBorder`, `SplitBorder`, `RoundedBorder`, `RoundedTopBorder`, `RoundedBottomBorder`, `DashedDividerChars`).
- `packages/tui/src/util/palette.ts` — single source of truth for severity-tinted fills (`severityFill`, `pillFill`).
- Branch not pushed. To push: `git push -u origin ui-v2-finish`.
