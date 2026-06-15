# TUI Patterns

## Command registration

Slash commands have two layers:
- **TUI keymap commands** (`packages/tui/src/app.tsx:600-720`) — appear in the command palette (`<leader>:`) and the slash autocomplete. Use `slashName` to make them callable via `/name`.
- **Server-side commands** (`packages/opencode/src/command/index.ts`) — appear in the prompt autocomplete only. NOT in the command palette.

For commands users should be able to find via the palette, register a keymap command. For commands users only find via typing `/`, server-side is fine.

## Dialog discoverability

If a server-side command does important work (like codegraph build, embeddings, YOLO toggle), add a quick-action UI surface:
- Idle state hint in the relevant widget (e.g. `codegraph-progress.tsx` shows "not built" when idle)
- Home screen quick action (`routes/home.tsx`)
- Slash command in autocomplete with good description

Don't rely on `/command-name` being discoverable — most users won't type it.

## SDK as any cast

When the SDK doesn't have a new method yet (e.g. immediately after adding an HTTP endpoint, before regen), use:
```ts
;(sdk.client as any).groupName?.endpointName?.({...})
```

Then add a follow-up commit that regenerates the SDK and removes the cast. Don't leave `as any` casts in the final code.

## Event subscription

Subscribe to events via `event.on(type, handler)` in `app.tsx` (around the existing handlers for `tui.toast.show` etc.). For namespaced event types, use the `as any` cast on the type string until the event is added to the EventV2 union (typecheck will fail otherwise).

## Sidebar plugin pattern

New sidebar widgets go in `packages/tui/src/feature-plugins/sidebar/` and register in `packages/tui/src/feature-plugins/builtins.ts`. Use `sidebar_content` for the main panel, `sidebar_footer` for the bottom. The `TuiPluginApi` from `@opencode-ai/plugin/tui` provides the slot registration API.

To auto-update from server events, subscribe in the plugin's `View` component:
```ts
useEvent().on("event.type", (evt) => setLocalState(evt.properties))
```

For the initial state, use `sync.data` from the sync context to get the current value.
