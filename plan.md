# Plan — TUI visual fixes (3 user-reported issues + 1 found while writing)

Working branch: `stable` (HEAD `39f3032`, tag `last-stable`). Verified-working state — do **not** revert.

---

## Issue 1 — "Current variant" toast + missing model variants

### 1a — Toast formatting is awkward

**Location:** `packages/tui/src/component/prompt/index.tsx:1006-1011`

```ts
toast.show({
  message: `Current variant: ${current}. Available variants: ${list.join(", ") || "none"}`,
  variant: "info",
})
```

The toast box is `maxWidth={Math.min(60, dimensions().width - 6)}` and the text wraps with `wrapMode="word"`. One long sentence wraps awkwardly across the narrow toast.

**Fix:** split into two readable pieces. Either newline-separated or two short sentences.

```ts
toast.show({
  message: `Current variant: ${current}\nAvailable variants: ${list.length ? list.join(", ") : "none"}`,
  variant: "info",
})
```

(Toast renderer already handles `\n` via `wrapMode="word"`.)

### 1b — Variants show "none" in BanyanCode, work in upstream OpenCode

**Root cause:** the `Catalog.Service` populates `ModelV2.Info.variants` only from `model.experimental?.modes` in the `models.dev` API. The provider-side path has a `ProviderTransform.variants()` fallback that synthesizes `{ none, thinking, … }` for known provider/model patterns; that fallback is **not wired into the catalog path**, so the TUI's `variant.list()` (`packages/tui/src/context/local.tsx:409-413`) returns `[]` for any model the catalog didn't see variants for in the live API response.

The `models-dev` data the catalog receives is likely cached at `~/.local/share/banyancode/models-{hash}.json`. If that cache was populated when the upstream API didn't yet expose the variant for a given model, the cache will keep returning empty variants.

**Fix (defense in depth):**

1. **TUI-side fallback** in `packages/tui/src/context/local.tsx:409-413` — when `info.variants` is empty, ask the SDK for the synthesized variants. The SDK already exposes `client.v2.provider.list()` which returns provider-synthesized variants. Concretely:

   ```ts
   list() {
     const m = currentModel()
     if (!m) return []
     const info = models().find(item => item.providerID === m.providerID && item.id === m.modelID)
     if (info?.variants?.length) return info.variants.map(v => v.id)
     // Fallback: synthesize from provider model info (which has ProviderTransform logic applied)
     const providerInfo = providers().find(p => p.id === m.providerID)
     const providerModel = providerInfo?.models?.[m.modelID]
     if (!providerModel?.variants) return []
     return Object.keys(providerModel.variants)
   }
   ```

   This way the TUI shows variants even if the catalog cache is stale.

2. **Catalog-side fix** in `packages/core/src/plugin/models-dev.ts:42-50` — when `experimental?.modes` is empty but the model matches known patterns (e.g. `minimax-m3`, `deepseek-r1`), populate variants from a shared helper. Either extract `ProviderTransform.variants()` into core, or duplicate the small match table in `models-dev.ts`. Prefer the extract.

3. **Cache invalidation** — bump the cache key so stale `models-{hash}.json` gets refreshed after the upstream `models.dev` API changes. Look at where the hash is computed (likely `packages/core/src/plugin/models-dev.ts` near the file write).

### 1c — Tests

- Add a test for `local.variant.list()` that returns at least `none` for any model, even with an empty catalog.
- Add a test for the toast formatting (snapshot or string assertion).

---

## Issue 2 — Slash command dropdown too short

### 2a — Height capped at cursor Y position

**Location:** `packages/tui/src/component/prompt/autocomplete.tsx:701-706`

```ts
const height = createMemo(() => {
  const count = options().length || 1
  if (!store.visible) return Math.min(10, count)
  positionTick()
  return Math.min(10, count, Math.max(1, props.anchor().y))  // BUG
})
```

`anchor().y` is the cursor row (≈ bottom of the prompt). When the cursor is at y=4, the dropdown caps at 4 rows. That's why the user sees ~3 visible commands.

### 2b — Comparison with other panels

| Component | File:line | Height |
|---|---|---|
| Slash autocomplete (BUG) | `autocomplete.tsx:705` | `Math.min(10, count, anchor().y)` |
| DialogSelect | `dialog-select.tsx:208` | `Math.min(rows, floor(height / 2) - 6)` |
| Prompt textarea | `prompt/index.tsx:1421` | `floor(height / 3)` |
| Tab panels (sessions/agents/…) | tab-*.tsx | `flexGrow={1}` |

All others use terminal height or `flexGrow`. Only the autocomplete is capped by cursor Y.

### Fix

```ts
const height = createMemo(() => {
  const count = options().length || 1
  if (!store.visible) return Math.min(10, count)
  positionTick()
  // Show up to 15 commands, but don't exceed terminal height below the anchor.
  const dims = dimensions()
  const spaceBelow = Math.max(0, dims.height - props.anchor().y - 2)
  const spaceAbove = Math.max(0, props.anchor().y - 2)
  // Place above cursor (per existing top=anchor.y - height), so use spaceAbove.
  return Math.min(15, count, spaceAbove)
})
```

Bump `10 → 15` so default + a few MCP + skill commands are visible.

---

## Issue 3 — `[e rename]` rendered as raw text

### 3a — Current rendering

**Location:** `packages/tui/src/feature-plugins/tabs/tab-sessions.tsx:215`

```tsx
<text fg={toHex(isSelected() ? c().theme.primary : c().theme.textMuted)}>[e rename]</text>
```

The brackets are literal text — looks like `[e rename]` instead of "**e** rename" with the key styled.

### 3b — Existing styling patterns

| Pattern | File:line | Notes |
|---|---|---|
| `TextAttributes.BOLD` for keys | `which-key.tsx:494-495` | `<text attributes={TextAttributes.BOLD}>{binding.key}</text>` |
| `<span>` inline styling | `tips-view.tsx:158` | `<span style={{ fg, ... }}>{part.text}</span>` |

### Fix

```tsx
import { TextAttributes } from "@opentui/core"

<text fg={toHex(c().theme.textMuted)}>
  <span
    style={{
      fg: toHex(isSelected() ? c().theme.primary : c().theme.warning),
      attributes: TextAttributes.BOLD,
    }}
  >
    e
  </span>
  {" "}rename
</text>
```

Renders "**e** rename" with `e` as a styled key chip (warning gold when idle, primary blue when row is selected). Removes the literal brackets.

Apply the same pattern to any other `[<key> <verb>]` placeholders in the TUI (grep for `\[e \w+\]`, `\[q \w+\]`, etc. as a sweep).

---

## Issue 4 — Autocomplete renders BEHIND tabs (z-order)

Found while writing this plan. The user's screenshot shows the AGENTS tab text bleeding through the `/command` dropdown:

> "the layer height for slash commands is below the layer for the different tabs like agents, settings, sessions, etc."

> "the text for the agents tab renders over the /command panel … the t comes from /agent-tree, which should be in the foreground"

### 4a — Current zIndex

**Location:** `packages/tui/src/component/prompt/autocomplete.tsx:714-722`

```tsx
<box
  position="absolute"
  top={position().y - height()}
  zIndex={100}
  backgroundColor={theme.backgroundMenu}
  {...SplitBorder}
  borderColor={theme.border}
>
```

`zIndex={100}` is set, but the items inside have **transparent backgrounds** when not selected (`backgroundColor={index === store.selected ? theme.primary : undefined}` at line 742), and the outer box height matches the (too-short) scrollbox height, so anything that overflows renders on top of the agent panel behind it.

Even when items fit, the items themselves are transparent, so the agents tab text shows through.

### 4b — Two-part fix

**Part 1 — opaque item backgrounds:** give every item a non-transparent background so the agents tab behind can't bleed through:

```tsx
<box
  paddingLeft={1}
  paddingRight={1}
  backgroundColor={index === store.selected ? theme.primary : theme.backgroundMenu}
  ...
>
```

**Part 2 — bump zIndex and verify layer placement:** bump `zIndex={100}` to `zIndex={1000}`. The sidebar/inspector layers likely use lower zIndex. If 1000 still doesn't help, check whether the sidebar is rendered inside an OpenTUI layer that ignores zIndex on children — if so, render the autocomplete via a portaled `<Show>` mounted at the root with a higher layer number.

### 4c — Test

Add a snapshot test that renders the autocomplete and asserts no row has `backgroundColor={undefined}` (i.e., every row is opaque).

---

## Suggested execution order

1. **Issue 2 (height)** — smallest, lowest risk. Fixes the immediate "I can't see all my commands" complaint.
2. **Issue 3 (rename chip)** — isolated CSS-style change.
3. **Issue 1a (toast format)** — one-line string change.
4. **Issue 4 (z-order)** — depends on Issue 2's height fix to be visible.
5. **Issue 1b (variants fallback)** — needs the SDK call surface confirmed and a unit test before merging.

## Risk & test plan

- Each TUI fix is visual — verify in tmux after each commit. Type `bun --cwd packages/opencode typecheck` from the opencode package directory before committing.
- Issue 1b touches the catalog layer. Run `bun --cwd packages/core test packages/core/test/catalog` and the banyancode tests after.
- No new dependencies required.

## Commit policy

One commit per issue, per AGENTS.md. No pushes — the lead agent does all commits; the user decides when to push.