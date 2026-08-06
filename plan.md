# Plan: Fix the "+ Add agent" wizard (New Agent dialog)

## Goal

The Add Agent wizard (`DialogAgentConfig`) is broken in four ways, per the user report:

1. At "Step 3/4: Model (optional)" neither **Enter** nor **Space** works — `[enter use default]` and `[space picker]` are mouse-only `<text onMouseUp>` affordances with no keymap binding. Same problem for `[enter confirm]` in `DialogMultiSelect` (Step 4/4) and `[enter save]` on the review step.
2. The tools list (Step 4/4) is a hardcoded 17-tool snapshot (`TOOL_GROUPS`) that does not list **all** tools from the actual tool registry, and has no **"select all" per category** (codegraph, repository, memory, read, etc.).
3. After the wizard saves an agent, **no agent gets added to the config tab** (Agents tab) — the saved `~/.config/banyancode/agent/<name>.md` frontmatter (`model: {...json...}`, `tools: [...]`) does not round-trip through `ConfigAgentV1.Info` (`model: String`, `tools: Record<String, Boolean>`), so `ConfigParse.schema` rejects the file and it never appears in `app.agents`.
4. "Add memory does nothing" — root cause is the same mouse-only wizard; the Memory tab `[+ Add memory]` flow (`dialog-memory-add.tsx`) must be verified to still work after the wizard fix.

## Steps

1. **Keyboard support in `DialogAgentConfig`** (`packages/tui/src/component/dialog-agent-config.tsx`)
   - Use `useBindings` from `packages/tui/src/keymap` to bind, when `step === "model"`:
     - `enter` → skip model, advance to `"tools"` step
     - `space` → open the `DialogModel` picker (same handler as `[space picker]` onMouseUp)
   - Bind, when `step === "review"`: `enter` → `save()`, `escape` → cancel (escape is already global in the Dialog, confirm it still applies).
   - Keep all existing onMouseUp handlers working (mouse + keyboard both drive the same actions).
   - Steps 1/2 already work (input `onSubmit`); don't regress them.

2. **Keyboard + select-all in `DialogMultiSelect`** (`packages/tui/src/ui/dialog-multi-select.tsx`)
   - Bind `enter` → `confirm()` (currently mouse-only).
   - Add a per-group **"select all" / "clear"** toggle in each group header (renders when the group has options; toggling selects/deselects every option in that group, respecting the current search filter if one is active).
   - Keep `[enter confirm]` and `[esc cancel]` affordances.

3. **Complete, registry-backed tools list in the wizard**
   - Replace the hardcoded `TOOL_GROUPS` with the full tool list:
     - Try fetching the real registry via the SDK (`sdk.client.tool.list({ provider, model })` with the current model from `useData`/`local.model`, falling back to `tool.ids` if list fails) — the TUI already has `createOpencodeClient` in `packages/tui/src/context/sdk`.
     - Group tools by category prefix (e.g. `codegraph_*` → Codegraph, `repository_*` → Repository, `memory_*` → Memory, `banyan_*` → BanyanCode, plus Read/Write/Execute/Web/Codegraph/Memory groups for the built-ins like read/glob/grep/write/edit/bash/task/webfetch/websearch/websearch_free/code_find/systeminfo).
     - Keep a static fallback list (updated to be complete) for when the server fetch fails or returns empty.
   - Pass the resulting groups to `DialogMultiSelect` (which now supports per-group select-all).

4. **Fix the save round-trip so the agent appears in the Agents tab** (`packages/opencode/src/server/routes/instance/httpapi/handlers/global.ts` — `banyanAgentSaveHandler`)
   - Write frontmatter that `ConfigAgentV1.Info` (from `packages/core/src/v1/config/agent.ts`) can decode:
     - `model` as a string `"providerID/modelID"` (not JSON) — ConfigAgentV1.Info.model is `Schema.optional(Schema.String)`.
     - `tools` as a record `{ "read": true, "write": true }` (not an array) — ConfigAgentV1.Info.tools is `Schema.optional(Schema.Record(Schema.String, Schema.Boolean))`.
     - Keep `name`, `description`, `mode`, `hidden`, `permission` (string list is fine for permission? verify against `ConfigPermissionV1.Info`) — verify the whole written frontmatter decodes via `ConfigAgentV1.Info` before landing.
   - Verify the `banyancode.config.updated` event → `sync.tsx` refetch of `app.agents` → Agents tab update path still works after the frontmatter fix.

5. **Fix the dialog's save call site** (`dialog-agent-config.tsx` `save()`)
   - Replace the `(sdk.client as any).global?.banyanAgent?.save?.(...)` optional-chaining call (which silently no-ops if the method is missing) with the typed `sdk.client.global.banyanAgent.save(...)`, and check the response for `.error` so failures surface as a toast instead of a false "Saved agent" success.

6. **Verify "Add memory" flow** (`packages/tui/src/component/dialog-memory-add.tsx` + `feature-plugins/tabs/tab-memory.tsx`)
   - Confirm `openAddMemoryDialog` → `runFlow` still works after the wizard changes (it uses `DialogPrompt.show` which has its own keymap). Fix anything the wizard changes broke.

7. **Fix dialog-stack lifecycle so the wizard can actually reach `save()`** (reviewer iteration 1, VERDICT: fail)
   - **Defect 1 — `DialogMultiSelect.confirm()` destroys the wizard** (`packages/tui/src/ui/dialog-multi-select.tsx`): `confirm()` calls `props.onConfirm(...)` then `dialog.clear()`. The wizard is a single dialog-stack entry (pushed via `dialog.replace(() => <DialogAgentConfig />)` at `tab-agents.tsx:237`), so `dialog.clear()` empties the whole stack and unmounts the wizard in the same synchronous handler — `setStep("review")` in the wizard's `onConfirm` lands on a destroyed component, so the review step never renders and `save()` never runs. Fix: make `DialogMultiSelect` NOT clear the dialog on confirm — it should only call `props.onConfirm(...)` and let the parent decide navigation (the wizard advances to the review step). Keep escape → cancel behavior. Verify the only consumer is the wizard (reviewer confirmed it is); if not, add an opt-in prop so the wizard-friendly behavior is default.
   - **Defect 2 — model picker destroys the wizard** (`packages/tui/src/component/dialog-agent-config.tsx`): `openModelPicker` does `dialog.replace(() => <DialogModel onSelect={...}/>)`, and `DialogModel.onSelect` (`dialog-model.tsx:141-146`) calls the wizard's `setModel`/`setStep` closures (on an unmounted component — a no-op) then `dialog.clear()`. Selecting a model closes the dialog instead of returning to the wizard at the tools step. Fix: do NOT `dialog.replace` the wizard. Either (a) render `DialogModel` inline as a sub-view of the wizard (a `showModelPicker` signal; the picker's `onSelect` sets the model, hides the picker, and advances to the tools step without touching the dialog stack), or (b) give `DialogModel` an opt-in prop (e.g. `onDismiss`/`inline`) so its `onSelect` does not call `dialog.clear()` when the wizard is hosting it. Prefer the inline sub-view (a) if `DialogModel`'s layout allows it; otherwise use (b). Preserve the existing `openModelPicker` flow in `tab-agents.tsx` (that one is a top-level dialog replace and is correct).
   - After the fix, the flow must be: Step 3 Space → picker opens → pick model (or Enter to skip) → wizard advances to Step 4 tools → Enter confirms → review step renders → Enter saves → `banyanAgent.save` fires → `banyancode.config.updated` → Agents tab shows the new agent.
   - Add/extend tests in `packages/tui/test/feature-plugins/tabs/tab-agents.test.tsx` (source-assertion style, matching the existing tests) asserting: `DialogMultiSelect`'s confirm no longer clears the dialog, and the wizard hosts the model picker inline (no `dialog.replace` for `DialogModel` inside `dialog-agent-config.tsx`, or assert a `showModelPicker`-style signal / `onDismiss`-style prop exists).

8. **Tests**
   - TUI: extend `packages/tui/test/feature-plugins/tabs/tab-agents.test.tsx` (existing source-assertion style) to assert:
     - the model step has enter/space keymap wiring (`useBindings`, `"enter"`, `"space"` present),
     - the tools list is no longer the tiny hardcoded snapshot (assert registry-fetch or a much larger fallback),
     - `DialogMultiSelect` renders a per-group select-all control (or source assertion for the select-all handler),
     - the save call uses `banyanAgent.save` without the optional-chaining no-op.
   - Server: extend `packages/opencode/test/banyancode/banyan-agent-save.test.ts` (or add a new test) to assert that a file written by `banyanAgentSaveHandler`'s frontmatter format **round-trips** through `ConfigAgentV1.Info` decode (model as string, tools as record) — this is the regression test for the "agent never appears" bug.

## Exit criteria

- `bun typecheck` passes in `packages/tui` and `packages/opencode` (run from each package dir).
- New/extended tests pass:
  - `packages/tui/test/feature-plugins/tabs/tab-agents.test.tsx` (keyboard + tools + select-all + save + dialog-stack-lifecycle assertions)
  - `packages/opencode/test/banyancode/banyan-agent-save.test.ts` (round-trip decode of handler frontmatter)
- The wizard can reach the review step and `save()` in the interactive flow (no `dialog.clear()`/`dialog.replace` that unmounts the wizard mid-flow): `DialogMultiSelect.confirm` does not clear the dialog, and the model picker is hosted inline (no `dialog.replace` of `DialogModel` from the wizard).
- Existing related tests still pass: `packages/opencode/test/banyancode/banyan-agent-save-validation.test.ts`, `packages/tui/test/feature-plugins/tabs/tab-agents-compact-spacing.test.tsx`, `tab-agent-tree.test.tsx`, and the memory-tab render test if present.
- `grep -rn "as any).global?.banyanAgent" packages/tui/src` returns no hits (the silent no-op save is gone).
- Manual sanity (documented for the user): in the TUI, `+ Add agent` → Step 3/4 responds to Enter (skip) and Space (picker); Step 4/4 lists all tools grouped with a per-group select-all; after save the new agent appears in the Agents tab with an editable system prompt.
