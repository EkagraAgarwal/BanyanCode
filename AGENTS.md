# BanyanCode

This repository is a fork of [OpenCode](https://github.com/anomalyco/opencode). BanyanCode adds: (1) an **orchestrator + subagent mesh** for parallel multi-agent workflows, (2) **cross-session memory** with JSONB payloads, (3) a **tree-sitter code graph** utility, and (4) a **researcher agent** with free web search via DuckDuckGo. BanyanCode is TUI/CLI only — `desktop`, `web`, `app`, `storybook` packages are explicitly out of scope.

See [`ARCHITECTURE.md`](ARCHITECTURE.md) for repo layout, runtime layers, and the BanyanCode service architecture. Per-feature design lives in `specs/banyancode/`. Active work is tracked via issues and PRs — there is no separate "implementation plan" doc.

## Branch, commit, and PR conventions

- Default branch is `main`; use `main` or `origin/main` for diffs and as the base for PRs. Tags ship from `main` directly.
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

## Release and publish workflow

BanyanCode ships to npm (`banyancode`) and a GitHub release (`v<version>`) through one CI pipeline (`.github/workflows/publish.yml`). Releases are **npm-only** — AUR and Homebrew tap pushes are intentionally out of scope. See the trailing comment at `packages/opencode/script/publish.ts:81-84`.

### Versioning

- CalVer `YY.MM.PATCH` per `specs/banyancode/versioning.md` (e.g. `26.07.4`). npm drops the leading zero (`banyancode@26.7.4`); git tags keep it (`v26.07.4`).
- Single source of truth: `packages/opencode/package.json:3` `version` field. The version-bump commit (`chore(opencode): bump version to <version>`) touches that file plus `bun.lock`.
- Tags are **annotated**: `git tag -a v<version> -m "BanyanCode <version>" <bump-sha>`. Lightweight tags work but lose tagger info — match the existing `v26.07.0`–`v26.07.4` pattern.

### Release channel

**Every release goes to the npm `latest` dist-tag by default.** `OPENCODE_CHANNEL` defaults to `latest` in both `.github/workflows/publish.yml:112` and `preflight.yml:65`, and `packages/opencode/script/publish.ts:23` runs `npm publish --tag ${Script.channel}` against that value. Operators do not need to set anything to land on `latest`:

- `git tag -a v<version> -m "BanyanCode <version>" <bump-sha> && git push origin v<version>` → `npm install banyancode@<version>` for everyone on the next dep resolution, and `npm install banyancode` (no version) returns the same `latest`.
- The GitHub release is cut as `--prerelease` so you can sanity-check assets before finalizing (the workflow flips `--prerelease=false` automatically after the `publish` job succeeds). If you want to delay the GA promotion, edit the release: `gh release edit v<version> --prerelease=true --repo EkagraAgarwal/BanyanCode` — `npm` users will not see the version until you flip it back.
- To cut a **prerelease** (e.g. `banyancode@26.8.0-rc.1` for a hotfix trial), set `OPENCODE_CHANNEL=next` either via `workflow_dispatch` → `Actions → publish → Run workflow` (no version input override) or by editing the publish workflow's env on a fork. `banyancode@latest` will NOT pick up the prerelease until you re-run with `OPENCODE_CHANNEL=latest` and a fresh tag.

The `Script.channel` indirection lives in `packages/opencode/script/publish.ts` and `build.ts`; both read `OPENCODE_CHANNEL` and fall back to `latest` when unset, so the "default latest" rule survives partial CI failures.

### Cutting a release

```bash
# After the version bump lands on main (or whatever branch you publish from):
git tag -a v26.07.4 -m "BanyanCode 26.07.4" <bump-sha>
git push origin v26.07.4          # the TAG push triggers publish.yml
```

The local `pre-push` hook runs `bun turbo typecheck` across 23 packages (cached after first run). If it fails, the push is rejected — fix the typecheck before tagging. The push only fires `publish.yml`; pushes to `main`/`dev` branches only fire `preflight.yml`.

### What `publish.yml` does

Triggered by `push: tags: v*` or `workflow_dispatch` with optional `version` input. Gated on `github.repository == 'EkagraAgarwal/BanyanCode'` so forks never run it.

| Job | Purpose |
|---|---|
| `version` | Resolves version in priority order: `GITHUB_REF_NAME` (tag push, `v` prefix stripped) → `inputs.version` (manual dispatch) → `packages/opencode/package.json` (fallback). Also chmods script files. |
| `build` (matrix: linux-x64, linux-arm64, darwin-x64, darwin-arm64, windows-x64) | `bun ./packages/opencode/script/build.ts --target=<target> --skip-install`. macOS artifacts are zipped, Linux tar.gz'd, Windows uploaded separately for the signing step. |
| `sign-windows` | Optional Azure code-signing. If any `AZURE_*` secret is missing, falls back to unsigned Windows binaries with a `::warning::` annotation (not a failure). |
| `publish` | Downloads artifacts, creates a `--draft --prerelease` GitHub release, runs `bun ./packages/opencode/script/publish.ts`, then finalizes the draft (`--draft=false`). |

Concurrency: `${{ github.workflow }}-${{ github.ref }}` — each tag is its own group. Pushing the same tag twice re-runs the workflow safely; see the "never move a tag" lesson below.

### `publish.ts` semantics

`packages/opencode/script/publish.ts` reads every per-platform `dist/<target>/package.json`, picks the version from any of them (they should all match), packs each with `bun pm pack`, then `npm publish *.tgz --access public --tag <channel>`. Channel comes from `OPENCODE_CHANNEL` (default `latest`).

- **Idempotent**: `published()` (`packages/opencode/script/publish.ts:12-14`) probes `npm view <name>@<version>` first; already-published tarballs are skipped with `already published <name>@<version>`. Safe to re-run.
- **Per-platform packages + umbrella wrapper**: each `<target>` package is published under its own npm name (e.g. `banyancode-linux-x64`, `banyancode-darwin-arm64`); the umbrella `banyancode` package pulls the right one via `optionalDependencies` and runs a `postinstall.mjs` shim.
- **`OPENCODE_RELEASE=true`** signals a real release (vs a dev build) — affects `build.ts` cross-compile defaults and `OPENCODE_CHANNEL`.

### Required secrets

| Secret | Consumed by | If missing |
|---|---|---|
| `NPM_TOKEN` | `publish.ts` (npm publish) | `publish` job fails. Preflight surfaces the blocker without failing the run (see `.github/workflows/preflight.yml:45-59`). |
| `AZURE_CLIENT_ID` / `_TENANT_ID` / `_SUBSCRIPTION_ID` / `_TRUSTED_SIGNING_ACCOUNT_NAME` / `_TRUSTED_SIGNING_CERTIFICATE_PROFILE` / `_TRUSTED_SIGNING_ENDPOINT` | `sign-windows` | Windows binaries ship unsigned with `::warning::`. Functional but not code-signed. |
| `HOMEBREW_TAP_TOKEN`, `AUR_KEY` | declared in `publish.yml:217-218` but **not consumed** — legacy from the upstream OpenCode pipeline | n/a |
| `GITHUB_TOKEN` | auto-provisioned; release upload + finalize | n/a |

### Manual dispatch

`Actions → publish → Run workflow` accepts an optional `version` input. When blank, it falls back to `packages/opencode/package.json`. Use this to re-run a publish against the same tag (e.g. after a transient npm failure) without retagging or to dry-run a tag at a specific SHA.

### Pre-flight (sanity check before tagging)

`.github/workflows/preflight.yml` runs on `push: branches: main` and `workflow_dispatch`. It validates `NPM_TOKEN`, builds locally with `--single` (linux-x64 only), smoke-tests the binary (`banyancode --version`), and warns about missing Azure secrets. Trigger it manually before cutting a tag to catch issues without burning the tag.

### Post-publish verification

```bash
npm view banyancode version                       # should match the tag (without leading 0)
gh release view v<version> --repo EkagraAgarwal/BanyanCode \
  --json isPrerelease,assets | jq '.assets | length'   # 5 platform assets
```

If the release was cut as `--prerelease` and you want to promote it to GA: `gh release edit v<version> --prerelease=false --repo EkagraAgarwal/BanyanCode`.

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

**Skip-reason counters must be explicit per-bucket, never a residual.** When a code-walker classifies files into multiple skip reasons (gitignored, banyanignored, artifact, tooLarge, minified, tooLargeParse, cached, readError, parseFailure, etc.), never compute one bucket as `total - sumOfOtherBuckets` to avoid double-counting. Hardcoding the missing reasons to `0` or silently merging them into a `tooLarge` aggregate is also wrong — the caller can't tell why files were skipped. Pattern: a `Ref<number>` per bucket, incremented at the exact decision site. The `result.skipped` field is the EXPLICIT SUM of all bucket Refs. Reference: Phase 4 PR 1 `packages/core/src/banyancode/codegraph-indexer.ts:712-738`. Old shape (a debugging black box): `skippedByReason: { gitignored, banyanignored: 0, artifact: 0, tooLarge: skippedBySize + skippedTooLargeParse + skippedMinified, cached, parseFailure: skippedParseFailure + skippedReadError }`. New shape: 9 separate buckets, every counter populated at the exact skip site.

**Regex parsers do not throw — `parseFailure` counters stay at zero forever.** The codegraph typescript/python parsers in `packages/core/src/banyancode/langs/` are pure regex. They silently produce empty node lists for malformed input — they never raise. So `CodegraphRepo.recordParseError` records only Effect failures (e.g., DB write errors, Drizzle typed errors during `tx.insert(...)`), not actual syntax errors. A user reading `codegraph_parse_errors` will see Effect stack traces, not "missing brace on line 42". Real parse-error visibility requires migrating to a real tree-sitter (or other grammar) backend — tracked as Wave 5. Until then, surface this caveat in any tool that claims to report parse failures: `parseErrors.length === 0` does NOT mean the code parsed correctly, only that no Effect failure occurred during indexing. Adding a test that triggers a true parse failure requires either the tree-sitter migration OR injecting a deliberately-malformed Effect throw at the parser level.

**Tree-sitter layer wasm imports must tolerate runtime module-load failure.** Re-applied 2026-07-07 after PRs 5-9 of the codegraph-hardening plan were reverted (root cause: `langs/tree-sitter.ts` exports a top-level `webTreeSitterReady: Promise<void> = ensureWebTreeSitterReady()` that synchronously kicks off `import("web-tree-sitter/tree-sitter.wasm", { with: { type: "wasm" } })`. The `with: { type: "wasm" }` import-attribute syntax is Stage-3 ECMAScript and **not supported in all module loaders** (older Node CJS, some Bun SSR contexts, or when bundled by Bun for opencode distribution). If the dynamic import rejects, `CodegraphIndexer.defaultLayer` (which `Layer.provide`s `TreeSitter.layer`) fails to build, which transitively breaks `BanyanTools.locationLayer` (since `tools-layer.ts:45` provides `codegraphIndexerLayer` to the merged banyancode tool layer), which means **no banyancode tools get registered** at runtime — the agent sees only opencode primitives). Fix pattern: wrap the wasm init in `Effect.catchAll` so the layer always constructs successfully; parser calls fail at use time with a typed error, not at build time with a silent registration failure. Reference: `specs/banyancode/tool-visibility-bisect.md` for the full bisect log and root-cause analysis.

**`Schema.annotate({ identifier })` on a struct used as an HTTP body field can corrupt single-element array decoding.** Symptom: POST with `focusDirs: ["packages"]` returns `Expected array, got "packages"` (HTTP 400); `focusDirs: ["packages", "specs"]` works. Diagnosis: tested all 4 layers in isolation — the Schema decoder handles single-element arrays correctly, the Banyan layer handles them correctly, the OpenAPI spec renders `focusDirs` as `type: array`, the SDK gen renders `focusDirs: Array<string>`. The bug only manifests through the actual HttpApi body pipeline when the struct is extracted into a named `$ref` via `.annotate({ identifier })`. Effect's HttpApi $ref-resolution path drops the wrapper for single-element arrays in this case. Fix: drop `.annotate({ identifier })` so the struct is inlined into each input schema (matches the pattern in `tool/repository-wave2.ts` which never had the bug). Symptom was first reported against `focusDirs` on `WorkspaceContextSchema` in `groups/repository-intel.ts` (Phase 4 PR 4). Add a regression test that POSTs both shapes through the actual HTTP layer — testing only the Schema or the Banyan layer will not catch this. Reference: `packages/opencode/test/banyancode/repository-intel-http.test.ts`.

**`Effect.forkScoped` / `Effect.forkIn(work, Effect.scope)` requires Scope in the fiber's CONTEXT.** It works inside `Effect.scoped` and inside fibers created by `Effect.scoped`. It FAILS with `Service not found: effect/Scope` inside fibers created by `ManagedRuntime.runFork` because `Fiber.runIn(scope)` (the default `onFiberStart`) attaches the fiber as a CHILD of the runtime scope, but does NOT add Scope to the fiber context. Use `Effect.forkDetach(work)` instead when you need a long-lived background task to survive the originating request scope — it attaches to the runtime's global scope (never closed) and doesn't need Scope in context. This bit `CodegraphBuildService.start()` and `banyancode-codegraph-bridge.ts` — both silently forked fibers whose work gen never ran (no `onProgress` ever fired, TUI stuck at `0/0 Running`). Symptom: handler returns successfully, TUI shows the toast, but the DB WAL never grows.

**When wiring a new HTTP route that kicks off a long-running task, the handler must run the kickoff via `AppRuntime.runFork(...)`.** Even after fixing `forkScoped` → `forkDetach` inside the service, the handler itself runs in the REQUEST scope. If the handler does `yield* buildService.start(...)` directly, the call enters the service from the request fiber; the service's `Effect.forkDetach` still works (it attaches to the global scope), but the surrounding gen completes in the request scope. Pattern: wrap the call in `AppRuntime.runFork(Effect.gen(function*() { yield* buildService.start(...) }))` so the whole kickoff runs in the AppRuntime's fiber, isolating it from request teardown. Reference: `packages/opencode/src/server/routes/instance/httpapi/handlers/global.ts:174-189` (the `codegraphBuildHandler`).

**BanyanCode-specific HTTP routes that kick off long-running work must live on `/global/*` (RootHttpApi), not on `/session/{id}/*`.** Slash commands like `/codegraph-build`, `/codegraph-cancel`, `/codegraph-remove` should be exposed as global endpoints (`POST /global/codegraph-build`) so they work whether or not the user has an active session. The TUI command-palette entry and the prompt-input slash handler both call the global endpoint. The session-scoped `/session/{id}/command` route is fine for LLM-driven commands (which need a session context) but wrong for workspace-level utility commands that just take a root and a flag. Reference: `packages/opencode/src/server/routes/instance/httpapi/groups/global.ts:106-118` (`GlobalPaths.codegraphBuild`) and `handlers/global.ts:174-189`.

**Iterating over an Effect without `yield*` doesn't always throw — it can silently yield undefined.** If an interface defines a method returning an `Effect.Effect<ReadonlyMap<K, V>>`, and a consumer expects a synchronous `ReadonlyMap<K, V>` (perhaps due to an `as never` type erasure in the bridge code), a loop like `for (const [key, value] of catalog.list())` will iterate over the Effect object itself rather than failing to compile. This results in undefined values (e.g., `TypeError: undefined is not an object` when accessing properties on the value) instead of a clear "not iterable" error. Always ensure methods returning Effects are `yield*`ed and that interface boundaries between layers (like `ToolCatalog.Interface` vs `ToolRegistry.Interface`) are strictly typed without `as never` casts hiding the return type.

**Sidebar plugin spacing: the wrapper owns the inter-plugin gap, plugins must NOT add their own.** The sidebar renders each `sidebar_content` plugin as a sibling under one `<box flexDirection="column">`. Setting `gap={1}` on that wrapper gives every plugin a consistent 1-row separator. But if any individual plugin's first content element ALSO uses `marginTop={1}` to push itself away from its own header, those two gaps stack into 2 blank rows between sections. Pattern: (a) wrapper has `gap={1}`; (b) every plugin's first content element after the header uses `marginTop={0}`. Internal spacing WITHIN a plugin (e.g. between two bar charts) may still use `marginTop={1}` since it's a different axis. Test it: `packages/tui/test/feature-plugins/sidebar/sidebar-compact-spacing.test.tsx` asserts the wrapper has `gap={1}` AND every plugin's first content element after the header has `marginTop={0}` — if any plugin regresses and adds its own `marginTop={1}`, the test fails. Reference: `packages/tui/src/routes/session/sidebar.tsx:69` and the sidebar plugins under `packages/tui/src/feature-plugins/sidebar/`.

**System-prompt tool guide = static policy header + dynamic catalog rendered from the tool registry.** Hand-typing tool catalogs into agent `.txt` files or provider prompts drifts the moment the registry changes. Pattern: the `CodegraphSystemSource` (`packages/core/src/banyancode/codegraph-system-source.ts`) splits into (a) a static `POLICY_TEXT` header always emitted when BanyanCode is enabled, and (b) a `renderToolGuide(tools)` helper that takes a filtered `Tool.Def[]` and renders the per-tool section. A single `BANYAN_TOOL_IDS` allowlist inside the source decides which IDs are LLM-facing; the upstream `ToolRegistry.tools(agent, model)` call already enforces visibility (public/advanced/internal) and permission. Adding a tool to `registry.ts` automatically updates every prompt. Reference: commits `7998ad094` (source layer), `469b55b18` (provider-prompt fix), and `e8f867236` (test suite) on `main`.

**V1 and V2 runtimes are independent — both need code-graph-policy awareness.** `packages/opencode/src/session/system.ts` (V1, default) and `packages/core/src/session/runner/llm.ts:170-227` (V2, gated by `OPENCODE_EXPERIMENTAL_EVENT_SYSTEM`) each assemble their system prompt from independent sources. A fix that only touches V1 reaches half the agents. The `CodegraphSystemSource` module exports both a V1 adapter (via `Effect.serviceOption` in `system.ts:codegraph`) and a V2 registration helper (`register(registry)` against `SystemContextRegistry.Service`). Any future prompt-level policy needs both seams.

**Default-allowing tools in `permissions` defaults vs per-agent `"*": "deny"` — `Permission.merge` uses `findLast`.** Adding a tool to the `defaults` block (`agent.ts:129-146`) is NOT enough for agents that have `"*": "deny"` at the top of their own config (e.g., `explore:266`). Because `Permission.merge` concatenates and `findLast` (`packages/core/src/permission/index.ts:102-112`) takes the last matching rule, the deny on `*` does NOT silently merge with `defaults["*"]: "allow"` — every tool you want allowed in such an agent must appear explicitly AFTER the `*` deny. Symptom: a test passes for most agents but the agent with `"*": "deny"` denies the new tool. Fix: add the tool allow row to that agent's per-agent permission block, not just the defaults. Reference: `explore` permission block at `packages/opencode/src/agent/agent.ts:265-313` (explicit allow rows for `codegraph_remove`, `blast_radius`, `preflight`, `safe_rename` were required after defaults added them, per audit finding #2 and Phase 5 commit `133231ef0`).

**Three-commit split for parallel subagent work on prompt/system files.** When the work touches both (a) a system-prompt module, (b) per-agent `.txt` prompts and permissions, and (c) provider prompt files, dispatch in parallel but commit separately. The natural seams are the three file groups themselves. Test files that assert on prompt content (e.g., `coder-scout.test.ts:62`'s `toContain("codegraph")`) break when the prompt strips happen (group b), but the fix to the test assertion logically belongs with the prompt change — so bundle the test fix with the prompt commit, not with a separate "tests" commit. Reference: commits `7998ad094`, `133231ef0`, `469b55b18` on `main`.

**`gh run list` defaults to whichever repo GitHub auth's primary is — pass `--repo` explicitly when cutting releases.** When the local checkout has both `origin` (your fork, e.g. `EkagraAgarwal/BanyanCode`) and `upstream` (e.g. `anomalyco/opencode`), `gh run list --workflow=publish` will report runs from the wrong repo: the GitHub CLI follows `gh auth status`'s active account against whichever repo it picks as the current working directory's "owner/repo". For BanyanCode work that owner can easily resolve to `anomalyco/opencode` (the upstream), and you'll see only upstream runs while your own fork's runs are "missing". Always pass `--repo EkagraAgarwal/BanyanCode` (or `--repo <owner>/<name>`) on every `gh run` and `gh release` subcommand when polling or viewing release artifacts. Reference: `gh run view 29563862883 --repo EkagraAgarwal/BanyanCode --json url,status,conclusion,headSha` for the v26.07.4 publish.

**Tags are immutable once a release ships — never move a published tag.** `npm publish` writes a tag at one `banyancode@<version>` per machine forever (npm rejects re-publish of an existing version), and the GitHub release at that tag has its own asset URLs and a unique `releases/<id>`. Force-moving an existing tag with `git tag -f v26.07.4 <new-sha>` plus `git push origin v26.07.4 --force` confuses every consumer that pinned to the tag and re-runs `publish.yml` against stale state. To roll back a bad release, cut a NEW patch version (e.g. `26.07.5`) with the fix and let the workflow publish it normally. The publish workflow's concurrency key is `${{ github.workflow }}-${{ github.ref }}` — pushing the same tag twice is safe (re-runs the same run group) but moving it is not.

**Don't run `publish.ts` locally — it depends on CI-built per-platform artifacts.** `packages/opencode/script/publish.ts` reads `packages/opencode/dist/<target>/package.json` files for each supported platform (linux-x64, linux-arm64, darwin-x64, darwin-arm64, windows-x64). Those are produced by the matrix build in `publish.yml`, not by local builds. Running `publish.ts` locally — even if you've manually copied binaries around — will mis-publish missing platforms or skip the version check entirely. For local sanity, use `bun ./packages/opencode/script/build.ts --single` to produce the single-arch bundle that preflight uses for `banyancode --version`.
