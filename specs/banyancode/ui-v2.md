# BanyanCode UI v2

The plan and contract for the new TUI layout in `packages/tui/`. This document is the source of truth for the v2 layout; refer to it before changing anything.

---

## 1. Theme contract (the only design system rule)

The HTML mockup at `specs/banyancode/banyancode_proposed_ui_v2.html` is the design intent. The v2 layout **uses the active theme's colors via existing `Theme` tokens** — no new theme file, no edits to the 33 themes in `packages/tui/src/theme/assets/`. All 33 themes keep working unchanged.

Token mapping (mockup → existing `Theme` field):

| Mockup role | Token | Notes |
|---|---|---|
| Brand text | `theme.primary` | "BANYANCODE" wordmark, active section headers, agent-name highlights |
| Active state | `theme.success` | Active agent dot, "active" pill, "approve" button border |
| Idle state | `theme.warning` | Idle agent dot, "warn" pill, in-progress todo |
| Blocked / critical | `theme.error` | Blocked agent dot, "crit" pill, reject button border |
| Info / link | `theme.info` | View button, model selector, click-to-jump |
| Accent | `theme.accent` | Plan blocks, thinking bar, agent highlights |
| Text | `theme.text` | Default foreground |
| Muted | `theme.textMuted` | Captions, meta rows, "no data" placeholder |
| Border | `theme.border` | Panel borders, separators |
| Panel bg | `theme.backgroundPanel` | Section backgrounds |
| App bg | `theme.background` | Window background |
| Diff + | `theme.diffAdded` | `+ added` line foreground |
| Diff - | `theme.diffRemoved` | `- removed` line foreground |
| Subtle line | `theme.borderSubtle` | Inner dividers (alpha-bleed feel) |

**Rule:** the v2 layout never references a color literal directly. Every color in the new components goes through one of these tokens. Verified all 33 themes carry `diffAdded` / `diffRemoved` (plus `Bg` / `LineNumberBg`) — `theme/index.ts:438-449` provides hardcoded fallbacks if a theme omits them, so these two tokens are never undefined.

---

## 2. Renderer rule: undefined means "no bar", not "0 bar"

A widget that doesn't have data for a metric must HIDE the bar / chip / section entirely. It must NEVER render 0% or 0 by default. The user finds 0% misleading (the GPU bug in v1 was exactly this).

Apply to every new widget. Verified patterns:
- `cpuPercent`: optional. First sample = bar hidden. `cpuPercent > 100` is impossible by construction. See `system-monitor.ts:60`.
- `ttftMs` / `tokensPerSecond`: optional. Tool-only steps (no text emitted) = bar hidden. Zero-duration steps = tokensPerSecond bar hidden.
- `cost` / `tokens` per-peer: optional until first assistant message = section shows "—" or similar neutral placeholder.

If a renderer writes `value ?? 0` for an optional field, the diff in review should reject it. The legitimate places for `?? 0` are only in arithmetic (e.g., summing percentages), never in display.

---

## 3. Data flow (where each metric comes from)

| Metric | Source | File | Notes |
|---|---|---|---|
| Session cost | `SessionMessage.Assistant.cost` aggregate | `packages/opencode/src/session/session.ts:436-452` | Sum across all assistant messages |
| Tokens (input/output/reasoning/cache) | `SessionMessage.Assistant.tokens` aggregate | same | 4-segment bar (today); 5-segment (Files/Tools/Memory) is deferred |
| Step TTFT | `Step.Ended.ttftMs` | `packages/opencode/src/session/processor.ts` (PR 1B) | First text-start minus step-start; undefined for tool-only steps |
| Step tokens/sec | `Step.Ended.tokensPerSecond` | same | Output tokens / step duration; undefined when duration=0 or output=0 |
| Per-agent cost | `MeshCoordinator.status()` | `packages/core/src/banyancode/mesh-coordinator.ts` (PR 1C) | Absolute `SUM(cost)` from `session_message`, 5s per-peer cache |
| Per-agent status | `MeshCoordinator.peers[].status` | same | "active" / "idle" / "disconnected" |
| CPU usage | `banyancode.system.updated` event | `packages/core/src/banyancode/system-monitor.ts` (PR 1A) | Cross-platform via `os.cpus()` deltas |
| Memory used/total | same event | same | Bytes; format to MB/GB at render time |
| GPU usage | same event | same | Optional; hidden on platforms without nvidia-smi |
| Branch name | `useDirectory()` | `packages/tui/src/context/directory.ts:14` | `directory:branch` from `sync.data.vcs.branch` |
| Active sessions count | `session.list()` filtered by busy/retry | `packages/tui/src/feature-plugins/header/status-pills.tsx` | Refreshed on `session.updated` |
| Codegraph staleness | `banyancode.codegraph.staleness` event | `header/status-pills.tsx:38-45` | Stale / Fresh / not built |
| MCP / LSP status | `api.state.mcp()` / `api.state.lsp()` | `header/status-pills.tsx:69-73` | Existing state APIs |
| Permission requests | `permission.asked` event | `packages/opencode/src/permission/index.ts:121` | Includes `tool: { messageID, callID }` for tool-context asks |
| Permission already replied | `permission.replied` event | same file | For attention-strip dismiss |
| Question requests | `question.asked` event | `packages/opencode/src/question.ts` | Same lifecycle as permission |

---

## 4. Permission → diff linkage (spike result, PR 1D)

`permission.asked` already carries `tool: { messageID, callID }` for any ask that originates from a tool call. The chain is wired end-to-end:

1. `session/tools.ts:71` — every tool that calls `permission.ask` passes `tool: { messageID: message.id, callID: options.toolCallId }`
2. `permission/index.ts:115` — `info.tool = request.tool` is forwarded into the persisted request
3. `permission/index.ts:121` — `events.publish(Event.Asked, info)` includes `tool` in the event payload
4. `effect/permission-bridge.ts:30` — the V2 bridge surfaces `source: { type: "tool", messageID, callID }` back out

**Implication for PR 3 Commit 1** (MessageBlock approve/reject gating):

```ts
const linkedAsk = pendingAsks.find((ask) => ask.tool?.messageID === block.messageID)
const hasPermissionLink = linkedAsk !== undefined
```

- Block has a permission link → render `approve` / `reject` / `view full diff` buttons
- Block has no permission link (e.g., bash output, text-only content) → render `view full diff` only (no dead buttons per the no-dead-buttons rule)

The attention strip's "N diffs awaiting review" count uses the same predicate: count the union of `pendingAsks` where `ask.tool` is set (or, in v1, where `metadata.kind === "diff"` if that's how the metadata field is being used today — confirm during PR 3).

---

## 5. Layout shell

Three-pane grid: `[app_top] / [attention_strip] / [left_sidebar | handle | center | handle | right_inspector] / [bottom_bar]`. Replaces `packages/tui/src/routes/session/index.tsx` in PR 3 Commit 6.

Default widths (KV-persisted — DO NOT change the existing keys without migration):

| Key | Default | Clamp |
|---|---|---|
| `left_sidebar_width` | 30 (PR 1) | 18–38 |
| `right_sidebar_width` | 28 (PR 1) | 18–34 |
| `left_sidebar_collapsed` | `false` | bool |
| `right_sidebar_collapsed` | `false` | bool |

Use the **existing** `kv.signal` calls at `routes/session/index.tsx:253-256` — keys and defaults preserved for muscle memory.

Column-count breakpoints (terminal cells, not px):

| Width | Behavior |
|---|---|
| `<100` | Left + right sidebars auto-hide. Center takes full width. `?` toggles a sidebar overlay. |
| `100–139` | Left sidebar auto-hides. Right sidebar still shown. |
| `≥140` | All three panes. |

Detection: `useTerminalDimensions().width` (already used in `app.tsx:1191-1238`). `ResizableSeparator` clamps to the column-count class, scaling proportionally.

---

## 6. Section specs (PR 3 Commits 2 + 3)

### Left sidebar (4 sections)

| Section | Source | Component (new) | Status pill |
|---|---|---|---|
| Agents | `banyancode.mesh.status` per-peer + aggregate row | `sidebar/agents.tsx` | active=success, idle=warning, disconnected=error, offline=textMuted |
| Context | `Sync.session.last().tokens` | rewrite `sidebar/context.tsx` | 4-segment bar (Thinking / Prompt / Output / Cache); Files/Tools/Memory deferred |
| Performance | `Step.Ended.{ttftMs, tokensPerSecond}` + step latency | `sidebar/performance.tsx` | 3 `BarMetric`s; hide bar if metric undefined |
| System | `SystemStatus` (extended) | rewrite `sidebar/system-status.tsx` | CPU + RAM only; hide fields not available |

> **Note:** The mockup's 5th section "Codebase" (file tree) was carved out to PR 3.5 — it requires a new `BanyanFilesystemService` core service. Not in the big-bang PR.

### Right sidebar (inspector, 3 sections)

| Section | Source | Component (new) | Notes |
|---|---|---|---|
| Agent Details | `Sync.session.last()` + `Data.agent.list` | rewrite `inspector/agent-details.tsx` | Model switcher, task, started, tools, cost, last activity — no "Memory:" line (memory service deferred) |
| Todo | `session.todo(sessionID)` | `inspector/todo.tsx` | Moved from sidebar |
| Agent Activity | `MeshStatus.peers` compact | `inspector/agent-activity.tsx` | Compact peer list |

---

## 7. Chat stream — MessageBlock (PR 3 Commit 1)

New component `packages/tui/src/component/message-block.tsx`. Replaces the inline message rendering. Three subtypes:

- **Plan block** (`theme.accent` label) — for "Plan · Phase N" headings
- **Diff block** (`theme.diffAdded` label) — code lines, conditional `approve` / `reject` / `view full diff` actions
- **Report block** (neutral label) — markdown / code bodies
- **Tool block** (`theme.warning` label) — for `tool-result` content

`approve` / `reject` buttons only render when the block is linked to a `permission.asked` (per §4). No dead buttons.

Composer reskin (`packages/tui/src/component/prompt/index.tsx` — re-skin only, no logic change):
- Input field: min-height 48px, single line for typical prompts
- Right side: agent selector chip (e.g., `Agent: Builder ▾`)
- Above input: "Thought: <ms>" thin strip showing the most recent `ttftMs` during streaming
- Meta row below: shortcuts hint (`enter to send · shift+enter newline`)

---

## 8. Attention strip (PR 3 Commit 4)

New component above the workspace. Subscribes to:

- `banyancode.mesh.status` → blocked peers (e.g., "Reviewer blocked — waiting on Builder Phase 1e")
- `permission.asked` count → "N permissions awaiting" (with diff subset: "N diffs awaiting review" if any have `tool` linkage)
- `question.asked` count → "N questions awaiting"
- `api.state.lsp()` / `api.state.mcp()` → outage messages
- Pending diffs (permission-linked only for now — see §4)

Single dismiss button dismisses all for the session. `?` shows help explaining each item.

`banyancode.mesh.status` events currently have no bridge. Either add one (mirror `banyancode-system-bridge.ts`) or have the attention strip poll `MeshCoordinator.status()` via SDK. Polling is simpler; bridge is a follow-up if push is needed.

Status pill severity (existing `header/status-pills.tsx`): add `theme.warning` for the `Graph: stale` and `theme.error` for `LSP: Disabled` / `MCP: down` / `Graph: not built` states.

---

## 9. Bottom bar (PR 3 Commit 5)

Three slots, all token-only:

| Slot | Content | Source |
|---|---|---|
| Left | `BanyanCode local · Git: <branch>` | `useDirectory()` from `tui/src/context/directory.ts:14` |
| Center | `▲ N need attention` (severity color when N>0) + resize hint | New — pulled from attention strip + render |
| Right | Hotkey legend (`^p cmd palette · ^g build graph · ^m memory search · / search · ^t new tab · ^s save session · ^q quit`) | Static |

---

## 10. Keybinding changes

The `?` key is currently not bound to `help.show` (the `keybind.ts:58` default for `help_show` is `"none"`). The header's `? help` text is decorative only. No collision with anything.

- At ≥140 cols: nothing changes — `?` is still "free".
- At <100 cols: `?` toggles the sidebar overlay (a new context-sensitive binding). Update the header hint to reflect this OR remove it entirely (rely on the bottom-bar legend).

---

## 11. PR sequencing

| PR | Commits | Description |
|---|---|---|
| 1A | 1 | System monitor cross-platform CPU + `forkIn` → `forkDetach` bridge fix. **DONE (`bcc9896`)** |
| 1B | 1 | Add `Step.Ended.ttftMs` + `Step.Ended.tokensPerSecond` (optional). **DONE (`646cab4`)** |
| 1C | 1 | Per-agent cost, mesh HTTP route, SDK regen, TUI no-as-any. **DONE (`f5d3977`)** |
| 1D | 0 (spike) | Verified `permission.asked` already carries `tool.messageID` / `tool.callID` (see §4). No code change. |
| 2 | 1 | This spec doc. |
| 3 | 6 commits | Big-bang UI replacement. |
| 3.5 | TBD | Codebase tree (new `BanyanFilesystemService` + watcher wiring + tree component). Carved out from 3. |

The `ui-v2-overhaul` branch accumulates all of the above. Each commit in PR 3 is independently `bun typecheck`-able.

`routes/session/v1/index.tsx` will be preserved as a manual escape hatch during PR 3 review. To revert: edit `app.tsx` to import the v1 route. Remove the escape hatch in PR 4 (cleanup).

---

## 12. Out of scope (deferred)

| Item | Reason | Land in |
|---|---|---|
| `temperatureC` sensor | No cross-platform sensor without platform-specific deps. PR 1A scope cut. | Future PR |
| `diskUsedBytes` / `diskTotalBytes` | cut from PR 1A | Future PR |
| Apple Silicon GPU | Requires `system_profiler` plumbing | Future PR |
| Files / Tools / Memory context breakdown bars | Need categorization logic + token-attribution heuristic | Future PR |
| Memory intensity metric for agent details | Need `BanyanMemoryAnalyticsService` | Future PR |
| Client-side "dismissed" set for non-permission diffs | Requires KV-backed state + UI surface | Future PR |
| Tying write-tool diffs to `permission.asked` automatically | Affects `permission/index.ts` and the agent runtime | Out of overhaul |
| Codebase tree (5th section) | New core service | PR 3.5 |
| Snapshot regression tests for the new widgets | Depends on opentui's snapshot capability | Verify in PR 1 setup; if absent, manual 9-cell matrix (3 widths × 3 themes) |
| Per-agent memory intensity on agent-details panel | Memory service doesn't exist | Future PR |

---

## 13. Style rules

(From `AGENTS.md` / `tui/AGENTS.md` / `core/AGENTS.md` / `opencode/AGENTS.md`)

- No comments unless non-obvious.
- Avoid `let`, `any`, `try/catch` where possible.
- Functional array methods (`map`, `filter`, `flatMap`) over `for` loops; use type guards on `filter`.
- No `as any` casts in final code. SDK types only after regeneration.
- Use `Effect.fn` for named/traced effects, `Effect.fnUntraced` for internal helpers.
- `Schema.optional(...)` via `.pipe(Schema.optional)` matching the existing pattern.
- Drizzle: `snake_case` field names.
- Theme colors via tokens only — never literal hex.
- BanyanCode namespace: `Banyan.X.Service` for consumers in `packages/opencode`.
- Self-export pattern: `export * as X from "./x"` at the bottom of each module file.
