# BanyanCode

This repository is a fork of [OpenCode](https://github.com/anomalyco/opencode). BanyanCode adds: (1) an **orchestrator + subagent mesh** for parallel multi-agent workflows, (2) **cross-session memory** with JSONB payloads, (3) a **tree-sitter code graph** utility, and (4) a **researcher agent** with free web search via DuckDuckGo. BanyanCode is TUI/CLI only — `desktop`, `web`, `app`, `storybook` packages are explicitly out of scope.

See [`ARCHITECTURE.md`](ARCHITECTURE.md) for repo layout, runtime layers, and the BanyanCode service architecture. Per-feature design lives in `specs/banyancode/`. Current implementation plan lives in [`plan.md`](plan.md).

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
