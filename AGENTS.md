# BanyanCode

This repository is a fork of [OpenCode](https://github.com/anomalyco/opencode). BanyanCode adds: (1) an **orchestrator + subagent mesh** for parallel multi-agent workflows, (2) **cross-session memory** with JSONB payloads, (3) a **tree-sitter code graph** utility, and (4) a **researcher agent** with free web search via DuckDuckGo. BanyanCode is TUI/CLI only — `desktop`, `web`, `app`, `storybook` packages are explicitly out of scope.

See [`ARCHITECTURE.md`](ARCHITECTURE.md) for repo layout, runtime layers, and the BanyanCode service architecture. Per-feature design lives in `specs/banyancode/`. Active work is tracked via issues and PRs — there is no separate "implementation plan" doc.

## Branch, commit, and PR conventions

- Default branch is `dev`; use `dev` or `origin/dev` for diffs. Local `main` ref may not exist.
- Branch names: ≤ three words, hyphen-separated, no type prefixes (`feat/`, `fix/`). Examples: `session-recovery`, `fix-scroll-state`, `regenerate-sdk`.
- Commits and PR titles: `type(scope): summary`. Valid types: `feat`, `fix`, `docs`, `chore`, `refactor`, `test`. Useful scopes: `core`, `opencode`, `tui`, `sdk`, `plugin`.
- One logical change per commit. Run `bun typecheck` and the relevant `bun test` between commits.
- Regenerate the JS SDK after any HTTP route or schema change: `./packages/sdk/js/script/build.ts`.

## Style guide

- Keep things in one function unless composable or reusable. Don't extract single-use helpers preemptively.
- Inline values that are only used once.
- Prefer `const` over `let`. Use ternaries or early returns instead of reassignment.
- Avoid `else`; prefer early returns.
- Avoid `try`/`catch` where possible; let errors propagate.
- Avoid the `any` type. Rely on type inference; declare types only for exports or clarity.
- Prefer functional array methods (`flatMap`, `filter`, `map`) over `for` loops; use type guards on `filter` to keep downstream inference.
- Avoid unnecessary destructuring; use dot notation to preserve context.
- Never alias imports (`import { foo as bar }`) and never use star imports.
- Use Bun APIs where possible (`Bun.file()`).
- In `src/config`, follow the self-export pattern (`export * as ConfigAgent from "./agent"`) when adding a config module.
- Drizzle: use `snake_case` field names so column names don't need redefinition.
- Comments only for non-obvious constraints or surprising behavior.

## Testing and type checking

- Tests cannot run from repo root (guard: `do-not-run-tests-from-root`). Run from package directories, e.g. `packages/opencode` or `packages/core`.
- Avoid mocks. Test actual implementation. Use `tmpdir()` + `Database.layerFromPath(tmpDbPath)` for any BanyanCode repo test that hits a real DB.
- Always run `bun typecheck` from a package directory; never `tsc` directly.

## BanyanCode product identity

BanyanCode is its own product, NOT a plugin or config of OpenCode. Both install side by side and never read or write each other's files.

| Concern | OpenCode | BanyanCode |
|---|---|---|
| Per-project config | `./opencode.json` | `./banyancode.json` |
| Per-project dir | `./.opencode/` | `./.banyancode/` |
| Global config | `~/.config/opencode/` | `~/.config/banyancode/` |
| Data dir | `~/.local/share/opencode/` | `~/.local/share/banyancode/` |
| DB filename | `opencode.db` | `banyancode.db` |
| Env var prefix | `OPENCODE_*` | `BANYANCODE_*` |
| Config schema | `ConfigV1.Info` | `BanyanConfig.Info` |
| Service namespace | (n/a) | `Banyan.X.Service` |

BanyanCode-specific keys (`banyancode_yolo_mode`, `banyancode_max_subagents`, `banyancode_telegram_*`, future runtime keys) live in `BanyanConfig.Info` (`packages/core/src/v1/config/banyan-config.ts`). They were removed from `ConfigV1.Info`. Consumers MUST use `Banyan.BanyanConfigService` — `Config.Service.getGlobal().banyancode_*` will fail typecheck.

For each sub-directory loader in `packages/opencode/src/config/`, the loader iterates BOTH `.opencode/` and `.banyancode/`. So `.opencode/agents/foo.md` AND `.banyancode/agents/foo.md` are both discovered and merged. Convention: `agent/`, `agents/`, `command/`, `commands/`, `skill/`, `skills/`, `plugin/`, `plugins/`, `plans/`, plus `tui.json`.

## Parallel subagent work

When dispatching multiple `@coder` subagents in parallel, expect git index.lock races and commit content races (one subagent's `git add` can pick up files meant for another). Pattern:
- The lead agent does all commits.
- Each subagent returns a list of files modified, never commits.
- Lead runs `git add <specific files>` and commits each change separately.
- Run `bun typecheck` and `bun test` between phases.

## Hard-won lessons (update this section as we learn more)

**Path traversal in HTTP schemas is the default — always validate.** Any string that ends up in `path.join` (filenames, slugs, identifiers written to disk) MUST be `Schema.isPattern` constrained at the schema boundary AND escape-validated in the handler. Defense-in-depth: strip disallowed chars AND verify the resolved absolute path is still inside the resolved parent directory. Reference: `BanyanAgentSaveInput.name` validation in `packages/opencode/src/server/routes/instance/httpapi/groups/global.ts:68` + `handlers/global.ts:242`.

**Schema migrations are dangerous — preserve data across destructive refactors.** Default to non-destructive migrations; reserve `{ force: true }` for explicit "wipe everything" calls.

**`Effect.runSync` from a non-Fiber runtime throws `FiberFailure`.** Any service method that reads from `Ref` / `Queue` / `Stream` MUST be `Effect.Effect<A, E, R>`, never a sync accessor that internally does `Effect.runSync(...)`. If callers legitimately need sync, do `Effect.runSync` at the call site, not in the service impl.

**Subscription leaks come from `bus.on(...)` inside component bodies.** Every `useEvent().on(type, handler)` or `event.on(type, handler)` inside a Solid component body MUST be paired with `onCleanup(unsub)`. Otherwise listeners accumulate across remounts and the bus fires the handler N times for N visits. The two correct patterns are `const unsub = ev.on(...); onCleanup(unsub)` and inline `onCleanup(event.on(...))`.

**Hot-path collections need explicit bounds.** A `Queue.unbounded` polled by an event loop grows without limit if no consumer is attached. Use `Queue.bounded(N)` where N is the max acceptable back-pressure window. Per-call `Effect.runForkWith(context)` spawns fibers with no scope; replace with `Stream.fromQueue(sharedQueue)` (throttled if needed) instead of one fiber per consumer.

**Count and stream, don't `SELECT *` + `.length`.** `bumpVersion` originally loaded every node and every edge into JS just to call `.length`. Use `SELECT COUNT(*)` for cardinality and stream with cursors for bulk iteration. 10K-node codegraphs blew up RSS on every indexer cycle before this was fixed.

**Read-modify-write in repos is a data-loss bug by default.** Any repo method that does `SELECT` then `UPDATE` (or read-then-write to a file) MUST be wrapped in a single `db.transaction()` (or a `Flock.withLock` for files) so the check and the write are atomic. Phase 1 caught four of these — `MemoryRepo.update`, `BanyanConfig.update`, `CodegraphRepo.bumpVersion`, plus `SubagentConsumer` re-delivery duplicating memory entries. Pattern: the public repo signature stays the same, the body becomes `db.transaction((tx) => Effect.gen(...))` and uses `tx` for every statement. For files, `Flock.withLock(key, async () => { ... })` from `@opencode-ai/core/util/flock` (or `EffectFlock.Service` for Effect-native callers) is the existing primitive.

**Idempotency on at-least-once consumers is the consumer's job, not the bus's.** When a consumer crashes after a side-effect (e.g. `memory.put`) but before the dedup marker (e.g. `markDelivered`), the next start will reprocess and duplicate. Fix: side-effect rows must use a **deterministic natural key** (e.g. `msg.id` not `crypto.randomUUID()`) so the storage layer's `onConflictDoNothing` / upsert is idempotent on redelivery. `subagent-consumer.plan` was generating fresh UUIDs per call — fixed by reusing the message id.

**`Effect.runSync` from a returned callback is a footgun even when the function "looks sync".** `bridge.bind` was returning `(...args) => Effect.runSync(...)` — a sync function that internally crossed the Effect boundary. The caller could not tell, and any invocation from an event handler / async callback / non-Fiber context crashed with `FiberFailure`. The fix is to make the bridge return an `async (...args) => Promise<A>` and use `Effect.runPromise` internally. The shape of the bridge interface must change too: `bind` now takes `fn: (...args) => Effect.Effect<A, unknown, never>` and returns `(...args) => Promise<A>`. Callers that had `bind(syncFn)` become `bind(() => Effect.sync(() => syncFn()))` or migrate to `Effect.gen`.

**Malformed `JSON.parse` in socket handlers must not kill the socket.** WebSocket `onmessage` handlers, provider response parsing, and any inbound boundary MUST wrap `JSON.parse` in try/catch. On failure, emit a structured error event (e.g. `bus.publish("rpc.error", ...)`) and keep the socket alive. The `Workspace` and `Provider` paths were already guarded; `util/rpc` was not. New tests post a malformed message and assert the socket survives — these tests catch regressions if someone later removes the try/catch "for cleanliness".

**Effect v4 beta: `catchAll` is gone — use `catchCause` / `catchTag` / `catchIf`.** The old `Effect.catchAll((error) => ...)` does not exist in effect-smol. Use `Effect.catchCause((cause) => ...)` for catch-all, `Effect.catchTag("TagName", (error) => ...)` for specific tagged errors, `Effect.catchIf(predicate, (error) => ...)` for predicate-based handling. Reference: Phase 2 health handlers use `Effect.catchCause` to convert DB errors to a structured failure response.

**Effect v4: `Schema.Union` takes an array, not multiple args.** `Schema.Union(A, B)` silently produces the wrong type. Use `Schema.Union([A, B])`. Reference: Phase 2 `GlobalHealth = Schema.Union([GlobalHealthSuccess, GlobalHealthFailure])` in `packages/opencode/src/server/routes/instance/httpapi/groups/global.ts:29`.

**Drizzle: `db.select(...)` requires `SelectedFields`, not raw SQL.** The `select` builder takes a record of column references (or `sql\`x\`` aliased), NOT a raw `SQL` object. For raw probes like `SELECT 1`, use `db.run(sql\`SELECT 1\`)` which takes any SQL. Reference: Phase 2 health handlers use `db.run(sql\`SELECT 1\`).pipe(Effect.timeout("2 seconds"))`.

**Effect `Queue` is single-consumer — never add a second drain in the layer AND a bridge.** The `CodegraphBuildService` exposed an `events()` `Queue.Dequeue` so a downstream bridge (e.g. `banyancode-codegraph-bridge.ts`) could drain and re-publish through `EventV2Bridge` (which stamps the instance/workspace location). The layer ALSO had an internal `Effect.forkScoped(Effect.forever(Queue.take(events) → eventBus.publish(...)))` worker. Both consumers pulled from the same `Queue.bounded(64)`, so each event went to exactly one of them. The TUI's `banyancode.codegraph.build` subscription lost roughly half of the progress events and the progress widget stayed at `0/0 Running` forever, even though the indexer was happily writing nodes to the DB. Rule: a service that exposes its `events()` queue for an external consumer MUST NOT also drain it internally. Pick one owner — the consumer that can stamp the location correctly is the right one. Reference: `packages/core/src/banyancode/codegraph-build-service.ts` (commit `32f307a`, re-applied from `ecfb2eb` on `review-fixes`). Regression test in `codegraph-manual-build.test.ts` drains the queue the same way the bridge does and asserts every progress event arrives — fails on the unfixed code (last event eaten by the rogue drain) and passes after the fix.

**`Layer.effect(Service, Effect.fail(...))` fails the service at access time (a defect), not via the Effect error channel.** This means `Effect.catchCause` in the consumer cannot observe the failure — the layer access itself throws. To test Effect error handling in a layer, use a working service and force a failure inside the operation (e.g. invalid SQL on a real DB connection). Reference: Phase 2 test files use `db.run(sql\`THIS IS INVALID SQL\`)` to force a typed `DrizzleQueryError` that `Effect.catchCause` can handle.

**Hot-path callbacks that need Effect queue handoff: use `Queue.bounded + runFork(offer) + forkScoped(Stream.fromQueue)`.** Native callbacks (parcel watcher, node-pty, file watchers) can't `await` Effect. Old pattern was per-event `Effect.runForkWith(context)` which spawned an unbounded number of fibers. New pattern: one `Queue.bounded(N)` per watcher instance, the callback does `Effect.runFork(Queue.offer(queue, event))`, and a single `Effect.forkScoped(Stream.fromQueue(queue))` drains. Bounded backpressure + single drain fiber replaces unbounded forks. Reference: Phase 5 `packages/core/src/filesystem/watcher.ts:86-99`.

**Versioned JSONB payloads enable non-destructive schema evolution.** Drizzle `text({ mode: "json" })` columns should be paired with `.$type<Shape>()` AND wrapped at write time as `{ _v: 1, data: T }`. Reads use a defensive parser that accepts BOTH versioned (`{ _v, data }`) and legacy (raw `T`) shapes so old rows continue to work. This avoids the "default to non-destructive migrations" lesson failing for JSONB columns specifically. Reference: Phase 9 `packages/core/src/banyancode/memory-payload.ts` (new file) and `memory-repo.ts` defensive `unwrapMemoryValue`.

**`Effect.forkScoped` / `Effect.forkIn(work, Effect.scope)` requires Scope in the fiber's CONTEXT.** It works inside `Effect.scoped` and inside fibers created by `Effect.scoped`. It FAILS with `Service not found: effect/Scope` inside fibers created by `ManagedRuntime.runFork` because `Fiber.runIn(scope)` (the default `onFiberStart`) attaches the fiber as a CHILD of the runtime scope, but does NOT add Scope to the fiber context. Use `Effect.forkDetach(work)` instead when you need a long-lived background task to survive the originating request scope — it attaches to the runtime's global scope (never closed) and doesn't need Scope in context. This bit `CodegraphBuildService.start()` and `banyancode-codegraph-bridge.ts` — both silently forked fibers whose work gen never ran (no `onProgress` ever fired, TUI stuck at `0/0 Running`). Symptom: handler returns successfully, TUI shows the toast, but the DB WAL never grows.

**When wiring a new HTTP route that kicks off a long-running task, the handler must run the kickoff via `AppRuntime.runFork(...)`.** Even after fixing `forkScoped` → `forkDetach` inside the service, the handler itself runs in the REQUEST scope. If the handler does `yield* buildService.start(...)` directly, the call enters the service from the request fiber; the service's `Effect.forkDetach` still works (it attaches to the global scope), but the surrounding gen completes in the request scope. Pattern: wrap the call in `AppRuntime.runFork(Effect.gen(function*() { yield* buildService.start(...) }))` so the whole kickoff runs in the AppRuntime's fiber, isolating it from request teardown. Reference: `packages/opencode/src/server/routes/instance/httpapi/handlers/global.ts:174-189` (the `codegraphBuildHandler`).

**BanyanCode-specific HTTP routes that kick off long-running work must live on `/global/*` (RootHttpApi), not on `/session/{id}/*`.** Slash commands like `/codegraph-build`, `/codegraph-cancel`, `/codegraph-remove` should be exposed as global endpoints (`POST /global/codegraph-build`) so they work whether or not the user has an active session. The TUI command-palette entry and the prompt-input slash handler both call the global endpoint. The session-scoped `/session/{id}/command` route is fine for LLM-driven commands (which need a session context) but wrong for workspace-level utility commands that just take a root and a flag. Reference: `packages/opencode/src/server/routes/instance/httpapi/groups/global.ts:106-118` (`GlobalPaths.codegraphBuild`) and `handlers/global.ts:174-189`.
