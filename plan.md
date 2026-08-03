# Goal

(verbatim) can you fix a few bugs/ implement features? 1. there is too much space between 2 sessions in the sessions tab. make it more compact. 2. add a pin icon that pins a chat to the top (marks it as favourite). use a ui similar to how apple music has a star for adding songs to liked songs. if that is not possible, just add a button next to continue, rename, and delete called pin. 3. do a deep review of /goal command. if you call it from plan mode, it switches to orchestration which is correct but that loop is stuck in read only mode. 4. /goal cannot be used multiple times in the same session, even if a goal has ended. make /goal be reusable. fix any other bugs with /goal command. 5. the reviewer agent doesnt seem to be working. review it and fix it. it should have fresh cleean context and access to the plan to verify everything.

## Findings (investigation complete)

- **Items 1–2 (sessions tab):** already implemented on `dev` by `ca0d806ac` (`packages/tui/src/feature-plugins/tabs/tab-sessions.tsx`): wrapper `gap={0}` (line 217), per-card `paddingBottom={0}` (line 237), Apple-Music-style pin star `★`/`☆` (lines 286-291), pinned-first sort via `orderSessions` (31-40), `ctrl+f` (`session_pin_toggle`), state persisted TUI-locally (`local.tsx` `togglePin`). Tests in `tab-sessions.test.tsx`. → Verify-only step.
- **Item 3 (read-only loop):** `/goal` (command/index.ts:249-360) overrides the agent per-turn (`agent:"orchestrator"`) but never persists it; session agent stays `plan`, `session.permission` deny rules persist and are merged into every effective ruleset (session/tools.ts:73), and subagents inherit parent denies (`agent/subagent-permissions.ts:14-27`). → Persist `orchestrator` on the session + neutralize deny rules when a goal starts.
- **Item 4 (reuse):** goals only reach terminal state via an explicit tool call; a dead loop leaves an `active` row → `setGoal` conflict blocks every later `/goal`. Also `banyancode_max_goal_iterations` never enforced, `planPath` default mismatch (`null` vs `"./plan.md"`), `tool/goal.ts:153` swallows errors. → Auto-cancel stale active goals on new `setGoal`; enforce max iterations; fix defaults/error mapping.
- **Item 5 (reviewer):** `banyancode-review-bridge.ts` dispatches with `model = subagent.model ?? {modelID:"",providerID:""}` (reviewer has no model) → `Provider.getModel("","")` throws → row stuck `dispatched`, verdict never reaches the orchestrator; `mesh_control` description omits `review`; no e2e test. Fresh child session per dispatch already exists (good). → Model fallback (parent session model / `banyancode_goal_evaluator_model`), verdict delivery into the parent session, tool-description fix, e2e test.

## Steps

1. **Sessions tab verify (items 1–2):** confirm `tab-sessions.tsx` compact spacing + star pin exist on HEAD and spacing tests pass; fix any deviation from the user's ask (e.g. residual inter-card gaps).
2. **/goal read-only fix (item 3):** in the GOAL command handler (`packages/opencode/src/command/index.ts`), after persisting the goal, persist `agent = "orchestrator"` on the session and clear/neutralize `session.permission` deny rules so the goal loop can edit files, call `goal(action=...)`, and dispatch coders/reviewer even when invoked from plan mode.
3. **/goal reusability + enforcement (item 4):**
   a. `goal-service.setGoal`: auto-transition any existing `active` goal for the same `parentSessionID` → `cancelled` (reason "superseded by new goal") before inserting, so `/goal` works repeatedly in one session even after an aborted loop.
   b. `tool/goal.ts record_review`: enforce `banyancode_max_goal_iterations` — when `iterationCount` reaches the max with a fail/blocked verdict, auto-transition the goal to `blocked` (reason "max iterations reached") and report it.
   c. `tool/goal.ts set`: default `planPath` to `"./plan.md"` when absent (match the command's default).
   d. `tool/goal.ts`: stop swallowing the original error (`mapError` → preserve message, translate only expected typed errors).
4. **Reviewer agent fix (item 5):**
   a. `banyancode-review-bridge.ts`: model fallback — use `banyancode_goal_evaluator_model` config if set, else the parent session's model (pattern: `task.ts:278-281`); never dispatch with an empty model.
   b. Deliver the reviewer result (VERDICT + reasoning) into the parent session after completion (pattern: task-result injection, `task.ts:318-322`) so the orchestrator LLM can read it and call `record_review` with the `reviewID` returned by `mesh_control(action="review")`.
   c. `mesh-control.ts`: add the `review` action to the tool description so the orchestrator's tool guide documents it.
   d. Add an e2e test: dispatch a review via the bridge with a real model and assert the verdict row completes and the result reaches the parent.
5. **Verification:** `bun typecheck` + `bun test` in `packages/core`, `packages/opencode`, `packages/tui`; run goal-service tests, review-bridge tests, tab-sessions tests.

## Exit criteria

Reviewer judges **pass** when ALL hold:

1. **Sessions tab:** `tab-sessions.tsx` on HEAD has wrapper `gap={0}`, per-card `paddingBottom={0}`, and the `★`/`☆` pin star wired to `onTogglePin`/`local.session.togglePin`; `orderSessions` sorts pinned first; `tab-sessions.test.tsx` spacing assertions exist and pass on non-win32 CI (source-assertions pass locally).
2. **Goal loop not read-only:** the GOAL command handler persists `agent: "orchestrator"` on the session (SessionTable/update path) and neutralizes `session.permission` deny rules at goal start; a test proves a plan-mode session starting a goal yields orchestrator permissions (edit/task allowed).
3. **Goal reuse:** `setGoal` auto-cancels a stale `active` goal for the same parent session; `goal-service.test.ts` covers: (i) set → set again after cancel works, (ii) set while active auto-cancels the old one.
4. **Goal enforcement:** `record_review` blocks the goal when `iterationCount >= banyancode_max_goal_iterations` with a fail/blocked verdict; `set` defaults `planPath` to `"./plan.md"`; `goal` tool failures preserve the original error message.
5. **Reviewer works:** `banyancode-review-bridge.ts` never dispatches with an empty model (falls back to config `banyancode_goal_evaluator_model` or parent session model); completed reviews deliver the verdict into the parent session; `mesh_control` description lists `review`; e2e test passes with a real model and asserts the review row reaches a terminal state and the parent sees the result.
6. **Clean context:** the review bridge creates a fresh child session per dispatch (no reuse); verified by the e2e test.
7. **No regressions:** `bun typecheck` passes in `packages/core`, `packages/opencode`, `packages/tui`; `bun test` passes for `packages/core/test/banyancode/goal-service.test.ts`, the new review-bridge test, `packages/tui/test/feature-plugins/tabs/tab-sessions.test.tsx`, and `packages/tui/test/config.test.tsx` (pre-existing unrelated failures documented, not caused by this change).

## Out of scope

- Restoring the pre-goal agent after the goal ends (user can switch back; agent-switch event already shows).
- TUI live goal-progress events (goal event queue drain) — the queue stays bounded; not part of the 5 items.
- Anything outside the 5 numbered items.
