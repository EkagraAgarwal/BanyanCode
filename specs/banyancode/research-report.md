# BanyanCode Research Report

> Compiled from exploration of the OpenCode fork at `D:\OpenCode`. READ-ONLY. All file paths are absolute. All line numbers are 1-indexed.

---

## Area 1 — Agent Registry and Built-in Agents

**Files:**
- `D:\OpenCode\packages\opencode\src\agent\agent.ts` (lines 1–459)
- `D:\OpenCode\packages\opencode\src\agent\generate.txt` (prompt template)
- `D:\OpenCode\packages\opencode\src\agent\subagent-permissions.ts` (lines 1–27)
- `D:\OpenCode\packages\opencode\src\agent\prompt/` (directory)

### Public Interface (signatures only)

```ts
// agent.ts:35–56
export const Info = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  mode: Schema.Literals(["subagent", "primary", "all"]),
  native: Schema.optional(Schema.Boolean),
  hidden: Schema.optional(Schema.Boolean),
  topP: Schema.optional(Schema.Finite),
  temperature: Schema.optional(Schema.Finite),
  color: Schema.optional(Schema.String),
  permission: PermissionV1.Ruleset,
  model: Schema.optional(Schema.Struct({ modelID: ModelV2.ID, providerID: ProviderV2.ID })),
  variant: Schema.optional(Schema.String),
  prompt: Schema.optional(Schema.String),
  options: Schema.Record(Schema.String, Schema.Unknown),
  steps: Schema.optional(Schema.Finite),
})

// agent.ts:64–80
export interface Interface {
  readonly get: (agent: string) => Effect.Effect<Info>
  readonly list: () => Effect.Effect<Info[]>
  readonly defaultInfo: () => Effect.Effect<Info>
  readonly defaultAgent: () => Effect.Effect<string>
  readonly generate: (input: { description: string; model?: { providerID: ProviderV2.ID; modelID: ModelV2.ID } }) =>
    Effect.Effect<{ identifier: string; whenToUse: string; systemPrompt: string }, Provider.DefaultModelError>
}
```

### Registration Seam

The `agents` table at `agent.ts:138–263` is where new built-in agents are defined. The table is built as a plain `Record<string, Info>` literal. The user-config loop at `agent.ts:265–292` iterates `Object.entries(cfg.agent ?? {})` and mutates entries **after** the table — so user overrides win.

**`native: true` / `native: false` convention:**
- `native: true` marks hardcoded built-in agents (e.g., `build`, `plan`, `general`, `explore`, `compaction`, `title`, `summary`).
- `native: false` is assigned to user-defined agents that override or extend (agent.ts:277).
- When adding a new built-in agent, always set `native: true`.

**`PROMPT_*` import style:**
- Prompt text files are imported as default imports with uppercase names: `import PROMPT_GENERATE from "./generate.txt"` (agent.ts:12).
- Prompt files for named agents live in `src/agent/prompt/` and are imported individually.
- Example: `import PROMPT_EXPLORE from "./prompt/explore.txt"` (agent.ts:14).

### Constraints
- New built-in agents must be inserted **before** line 265 (the user loop) so user config can override them.
- The `mode` field must be `"primary"`, `"subagent"`, or `"all"`. Orchestrator and researcher should be `"primary"` and `"subagent"` respectively.
- `Permission.merge(defaults, Permission.fromConfig({...}), user)` is the canonical merge chain (agent.ts:143–150). Never skip `defaults`.
- The `Info` schema at line 35–56 is the source of truth for agent shape.

---

## Area 2 — Tool System

**Files:**
- `D:\OpenCode\packages\core\src\tool\tool.ts` (lines 1–144)
- `D:\OpenCode\packages\core\src\tool\tools.ts` (lines 1–13)
- `D:\OpenCode\packages\core\src\tool\registry.ts` (lines 1–139)
- `D:\OpenCode\packages\core\src\tool\application-tools.ts` (lines 1–58)
- `D:\OpenCode\packages\core\src\tool\websearch.ts` (lines 1–246)
- `D:\OpenCode\packages\opencode\src\tool\registry.ts` (lines 1–440)
- `D:\OpenCode\packages\opencode\src\tool\task.ts` (lines 1–346)
- `D:\OpenCode\packages\opencode\src\tool\shell\prompt.ts` (lines 1–307)
- `D:\OpenCode\packages\core\src\tool\AGENTS.md` (lines 1–59)

### Canonical `Tool.make` Shape

```ts
// tool.ts:62–114
export function make<Input, Output>(config: Config<Input, Output>): Definition<Input, Output>

// where Config is:
{
  readonly description: string
  readonly input: Input          // Effect Schema
  readonly output: Output        // Effect Schema
  readonly execute: (input: Schema.Schema.Type<Input>, context: Context) =>
    Effect.Effect<Schema.Schema.Type<Output>, ToolFailure>
  readonly toModelOutput?: (input: { readonly input: Schema.Schema.Type<Input>; readonly output: Output["Encoded"] }) =>
    ReadonlyArray<Content>
}
```

### `Tools.Service.register` Seam

```ts
// packages/core/src/tool/tools.ts:6–12
export interface Interface {
  readonly register: (tools: Readonly<Record<string, Tool.AnyTool>>) =>
    Effect.Effect<void, Tool.RegistrationError, Scope.Scope>
}
export class Service extends Context.Service<Service, Interface>()("@opencode/v2/Tools") {}
```

The canonical registration pattern for a built-in tool is a `Layer.effectDiscard` that calls `Tools.Service.register({ [name]: Tool.make({...}) })` — see `packages/core/src/tool/websearch.ts:184–245`.

### `ApplicationTools.Service.register` Seam

`packages/core/src/tool/application-tools.ts:21–28`. Process-scoped and shared by all Locations. The opencode layer at `packages/opencode/src/tool/registry.ts:198–215` uses `Tool.init(tool)` (not `Tool.make`) to resolve deferred tool definitions before registration.

### How a New Tool Is Added in Opencode Layer

`packages/opencode/src/tool/registry.ts:198–215`:
```ts
const tool = yield* Effect.all({
  invalid: Tool.init(invalid),
  shell: Tool.init(shell),
  read: Tool.init(read),
  // ...
  search: Tool.init(websearch),
  // ...
})
```

New tools should be added to this `Effect.all` call and to the `builtin` array at lines 219–236.

### `packages/core/src/tool/AGENTS.md` Invariants

- `tool.ts` defines the opaque canonical `Tool.make(...)` value. Application tools and shipped built-ins use the same type.
- Built-ins register through `Tools.Service.register(...)`. Application tools register through `ApplicationTools.Service.register(...)`, exposed publicly as `opencode.tools.register(...)`.
- The registry has no `PermissionV2.Service` dependency and performs no execution authorization. Definition filtering is catalog visibility, not execution authorization.

### Additional Constraints

- `Tool.make` input/output must be Effect `Schema` types (not Zod).
- `Tool.init` (opencode layer) resolves a deferred tool definition (`Tool.define` result) before use.
- `Tool.define` (tool.ts) is the factory used by opencode tool files; `Tool.make` is the underlying canonical constructor.
- The registry validates tool names with `validateName` (tool.ts:116–119): `/^[A-Za-z][A-Za-z0-9_-]{0,63}$/`.
- `websearch.ts:17–19` sets constraints that `websearch_free` must mirror: 25s timeout, 256KB body cap, `numResults` ≤ 20.

---

## Area 3 — Background Jobs and Parallel Subagents

**Files:**
- `D:\OpenCode\packages\opencode\src\background\job.ts` (lines 1–39)
- `D:\OpenCode\packages\opencode\src\tool\task.ts` (lines 1–346)
- `D:\OpenCode\packages\opencode\src\agent\subagent-permissions.ts` (lines 1–27)

### Confirmations

- **`task` with `background: true` is the path to parallel subagents.** `task.ts:97–102`; `task.ts:291–293`.
- **`OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true` is the gate.** `task.ts:98–101`; `runtime-flags.ts:43`.
- **`BackgroundJob.wait` is the wait affordance.** `task.ts:232–239`, `task.ts:309–321`.
- **`task_id` reuses a prior child session.** `task.ts:121–123`.

### BackgroundJob Material

```ts
// job.ts:7–15 (Interface)
export interface Interface {
  readonly list: () => Effect.Effect<Info[]>
  readonly get: (id: string) => Effect.Effect<Info | undefined>
  readonly start: (input: StartInput) => Effect.Effect<Info>
  readonly extend: (input: ExtendInput) => Effect.Effect<boolean>
  readonly wait: (input: WaitInput) => Effect.Effect<WaitResult>
  readonly waitForPromotion: (id: string) => Effect.Effect<Info | undefined>
  readonly promote: (id: string) => Effect.Effect<Info | undefined>
  readonly cancel: (id: string) => Effect.Effect<Info | undefined>
}
```

### Constraints

- Background subagent sessions are children of the parent session (`parentID: ctx.sessionID` at task.ts:145).
- The orchestrator must **never** use `Effect.sleep` to wait for a subagent. Use `BackgroundJob.wait` or `pollWithTimeout`.
- `BackgroundJob.extend` chains additional work onto a running job; returns `true` if the job was running and the extension was scheduled.

---

## Area 4 — Command System

**Files:**
- `D:\OpenCode\packages\opencode\src\command\index.ts` (lines 1–184)
- `D:\OpenCode\packages\opencode\src\command\template/` (directory)

### Registration Seams

Built-in commands at `index.ts:78–96` via `Default.INIT` and `Default.REVIEW`. External commands join via three loops:

1. **`cfg.command` loop** at `index.ts:98–111`
2. **`mcp.prompts()`** at `index.ts:113–140`
3. **`skill.all()`** at `index.ts:142–153`

### `hints()` Helper

```ts
// index.ts:44–52
export function hints(template: string) {
  const result: string[] = []
  const numbered = template.match(/\$\d+/g)
  if (numbered) {
    for (const match of [...new Set(numbered)].sort()) result.push(match)
  }
  if (template.includes("$ARGUMENTS")) result.push("$ARGUMENTS")
  return result
}
```

### Public Interface

```ts
// index.ts:30–42
export const Info = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  agent: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  source: Schema.optional(Schema.Literals(["command", "mcp", "skill"])),
  template: Schema.Unknown,
  subtask: Schema.optional(Schema.Boolean),
  hints: Schema.Array(Schema.String),
})

// index.ts:59–62
export interface Interface {
  readonly get: (name: string) => Effect.Effect<Info | undefined>
  readonly list: () => Effect.Effect<Info[]>
}
```

---

## Area 5 — Skill Discovery

**Files:**
- `D:\OpenCode\packages\opencode\src\skill\discovery.ts` (lines 1–109)
- `D:\OpenCode\packages\opencode\src\skill\index.ts` (lines 1–366)

### Where a `SKILL.md` Is Placed

Skills are discovered by glob-scanning for `**/SKILL.md` in:

1. **Global external dirs** (walk up from directory to worktree): `.claude/`, `.agents/`. Pattern: `skills/**/SKILL.md`
2. **Config dirs** (from `Config.directories()`). Pattern: `{skill,skills}/**/SKILL.md`
3. **User-configured skill paths** (`cfg.skills?.paths`)
4. **Remote URLs** (`cfg.skills?.urls`)

### Frontmatter Rules

```ts
// index.ts:53–59
function isSkillFrontmatter(data: unknown): data is { name: string; description?: string } {
  return (
    isRecord(data) &&
    typeof data.name === "string" &&
    (data.description === undefined || typeof data.description === "string")
  )
}
```

### Walk-up-to-worktree

```ts
// index.ts:196–202
const upDirs = yield* fsys
  .up({ targets: externalDirs, start: directory, stop: worktree })
  .pipe(Effect.catch(() => Effect.succeed([] as string[])))
```

### Public Interface

```ts
// index.ts:37–43
export const Info = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  location: Schema.String,
  content: Schema.String,
})

// index.ts:97–103
export interface Interface {
  readonly get: (name: string) => Effect.Effect<Info | undefined>
  readonly require: (name: string) => Effect.Effect<Info, NotFoundError>
  readonly all: () => Effect.Effect<Info[]>
  readonly dirs: () => Effect.Effect<string[]>
  readonly available: (agent?: Agent.Info) => Effect.Effect<Info[]>
}
```

---

## Area 6 — Storage and Drizzle Schema

**Files:**
- `D:\OpenCode\packages\core\src\database\schema.sql.ts` (lines 1–10) — only a `Timestamps` helper
- `D:\OpenCode\packages\core\src\database\migration.ts` (lines 1–59)
- `D:\OpenCode\packages\core\script\migration.ts` (lines 1–132)
- `D:\OpenCode\packages\core\src\database\migration.gen.ts` (auto-generated registry)
- `D:\OpenCode\packages\core\src\database\migration\` — 32 migration files

### Migration Naming Convention

Migrations are named `YYYYMMDDHHMMSS_<descriptive>.ts`. Latest:
- `20260605042240_add_context_epoch_agent.ts`

**The next BanyanCode migration should be `20260606NNNNNN_banyan_phase1.ts`** (e.g., `20260606000001_banyan_phase1.ts`). The plan's original reference to `0009_banyan_phase1.sql` does not follow the existing pattern and must be corrected.

### Schema Style

Per the root `AGENTS.md` style guide: use `snake_case` for column names so Drizzle column names don't need to be redefined as strings.

```ts
// Good
id: text().primaryKey(),
project_id: text().notNull(),
created_at: integer().notNull(),

// Bad
id: text("id").primaryKey(),
projectID: text("project_id").notNull(),
createdAt: integer("created_at").notNull(),
```

### `effect-drizzle-sqlite` Boundary

`packages/effect-drizzle-sqlite` is a generic Drizzle/Effect/SQLite adapter. Per its `AGENTS.md`: it must stay generic; do not add opencode-specific tables or paths. BanyanCode tables live in `packages/core/src/database/`.

---

## Area 7 — Effect Runtime, InstanceState, and Bus

**Files:**
- `D:\OpenCode\packages\opencode\src\effect\run-service.ts` (lines 1–47)
- `D:\OpenCode\packages\opencode\src\effect\instance-state.ts` (lines 1–69)
- `D:\OpenCode\packages\opencode\src\effect\bridge.ts` (lines 1–84)
- `D:\OpenCode\packages\opencode\src\effect\runtime-flags.ts` (lines 1–79)
- `D:\OpenCode\packages\opencode\src\bus\global.ts` (lines 1–22)

### Adding a New `Context.Service`

```ts
export class MyService extends Context.Service<MyService, Interface>()("@opencode/MyService") {}

export const layer = Layer.effect(
  MyService,
  Effect.gen(function* () {
    // ... initialize service
    return MyService.of({ /* methods */ })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(SomeDependency.defaultLayer))

export * as MyService from "./my-service"
```

### `InstanceState` — Per-Directory State

```ts
// instance-state.ts:26–45
export const make = <A, E, R>(
  init: (ctx: InstanceContext) => Effect.Effect<A, E, R | Scope.Scope>,
): Effect.Effect<...> =>
  Effect.gen(function* () {
    const cache = yield* ScopedCache.make<string, A, E, R>({ /* ... */ })
    // ...
  })
```

`InstanceState` uses `ScopedCache` keyed by `directory`. Each open project directory gets its own state, cleaned up on disposal.

### `EffectBridge` — Native Callbacks to Effect

```ts
// bridge.ts:54–82
export function make(): Effect.Effect<Shape> {
  return Effect.gen(function* () {
    const captured = captureSync()
    return {
      promise: <A, E, R>(effect) => restoreWorkspace(workspace, () => Effect.runPromise(wrap(effect))),
      fork: <A, E, R>(effect) => restoreWorkspace(workspace, () => Effect.runFork(wrap(effect))),
      run: <A, E, R>(effect) => Effect.callback<A, E>((resume) => { /* ... */ }),
      bind: <Args extends readonly unknown[], Result>(fn: (...args: Args) => Result) =>
        (...args: Args) => restoreWorkspace(workspace, () => Effect.runSync(wrap(Effect.sync(() => fn(...args))))),
    } satisfies Shape
  })
}
```

### Bus Event Shape

```ts
// bus/global.ts:4–9
export type GlobalEvent = {
  directory?: string
  project?: string
  workspace?: string
  payload: any
}
```

The bus is process-global. Events are published via `GlobalBus.emit("event", event)` and subscribed via `GlobalBus.on("event", handler)`.

### `makeRuntime`

`run-service.ts:33–46` exposes `runSync`, `runPromiseExit`, `runPromise`, `runFork`, `runCallback` over a `ManagedRuntime`.

---

## Area 8 — Permission System

**Files:**
- `D:\OpenCode\packages\core\src\permission\schema.ts` (lines 1–16)
- `D:\OpenCode\packages\core\src\permission.ts` (lines 1–329)
- `D:\OpenCode\packages\core\src\config.ts` (permission schema at lines 59–60)

### Permission Schema

```ts
// permission/schema.ts:5–16
export const Effect = Schema.Literals(["allow", "deny", "ask"])
export const Rule = Schema.Struct({
  action: Schema.String,
  resource: Schema.String,
  effect: Effect,
})
export const Ruleset = Schema.Array(Rule)
```

### Adding a New Permission Key

Permission keys are free-form strings in the `action` field. No schema change required. To add `websearch_free`:

1. Use `action: "websearch_free"` in the tool's permission check.
2. Add to the agent's ruleset: `Permission.fromConfig({ websearch_free: "allow" })`.

### Wildcard Rules

`Wildcard.match(action, rule.action)` performs glob-style matching. The last matching rule wins.

### Per-Agent Overrides

`Permission.merge(defaults, Permission.fromConfig({...agent-specific...}), user)` is the canonical chain. `user` is always last, so user config wins.

### `PermissionV2.evaluate`

```ts
// permission.ts:102–112
export function evaluate(action: string, resource: string, ...rulesets: Ruleset[]): Rule {
  return (
    rulesets
      .flat()
      .findLast((rule) => Wildcard.match(action, rule.action) && Wildcard.match(resource, rule.resource)) ??
    { action, resource: "*", effect: "ask" }
  )
}
```

---

## Area 9 — Test Infrastructure

**Files:**
- `D:\OpenCode\packages\opencode\test\AGENTS.md` (lines 1–204)
- `D:\OpenCode\packages\opencode\test\fixture\fixture.ts` (lines 1–224)
- `D:\OpenCode\packages\opencode\test\lib\effect.ts` (lines 1–177)
- `D:\OpenCode\packages\opencode\test\server\AGENTS.md` (lines 1–15)
- `D:\OpenCode\packages\opencode\test\background\job.test.ts` (lines 1–243)

### `testEffect` / `it.effect` / `it.live` / `it.instance`

```ts
// test/lib/effect.ts:139–140
export const testEffect = <R, E>(layer: Layer.Layer<R, E>) =>
  make<R, E>(Layer.provideMerge(layer, testEnv), Layer.provideMerge(layer, liveEnv))

// test/lib/effect.ts:137
export const it = make<never, never>(testEnv, liveEnv)
```

`make` (effect.ts:67–129) returns an object with:
- `it.effect(name, fn, opts?)` — runs with `TestClock` + `TestConsole`
- `it.live(name, fn, opts?)` — runs with real clock, `TestConsole`
- `it.instance(name, fn, opts?, opts2?)` — runs with `tmpdirScoped` + `withTmpdirInstance`

Usage:
```ts
const it = testEffect(MyService.defaultLayer)
it.instance("does the thing", () =>
  Effect.gen(function* () {
    const svc = yield* MyService.Service
    // ...
  }),
)
```

### `tmpdir` Fixture

```ts
// fixture/fixture.ts:80–115
export async function tmpdir<T>(options?: TmpDirOptions<T>) {
  const dirpath = sanitizePath(path.join(os.tmpdir(), "opencode-test-" + Math.random().toString(36).slice(2)))
  await fs.mkdir(dirpath, { recursive: true })
  // ...
  return {
    [Symbol.asyncDispose]: async () => { /* cleanup */ },
    path: realpath,
    extra: extra as T,
  }
}
```

Use: `await using tmp = await tmpdir({ git: true, config: {...} })`.

### Concurrency Helpers

```ts
// test/lib/effect.ts:149–159
export const awaitWithTimeout = <A, E, R>(
  self: Effect.Effect<A, E, R>,
  message: string,
  duration: Duration.Input = "2 seconds",
) => self.pipe(
  Effect.timeoutOrElse({ duration, orElse: () => Effect.fail(new Error(message)) }),
)

// test/lib/effect.ts:161–177
export const pollWithTimeout = <A, E, R>(
  self: Effect.Effect<A | undefined, E, R>,
  message: string,
  duration: Duration.Input = "5 seconds",
) => Effect.gen(function* () {
  while (true) {
    const result = yield* self
    if (result !== undefined) return result
    yield* Effect.sleep("20 millis")
  }
}).pipe(Effect.timeoutOrElse({ duration, orElse: () => Effect.fail(new Error(message)) }))
```

`BackgroundJob.wait({ id, timeout })` for waiting on a specific job.

### `Layer.mock` Partial-Stub Pattern

```ts
const failingAccountLayer = Layer.mock(Account.Service, {
  orgsByAccount: () => Effect.fail(new Account.AccountServiceError({ message: "simulated upstream failure" })),
})
```

`Layer.mock` throws `UnimplementedError` for any method not explicitly stubbed.

### Constraints

- **Never** use `Effect.sleep(N)` to wait for a forked fiber — this races the scheduler.
- Tests cannot run from repo root (guard in `bunfig.toml`). Run from package dirs.
- `it.live` is for tests that depend on real time, filesystem mtimes, child processes, git, or live HTTP.
- `it.effect` uses `TestClock` — time-dependent tests should use `it.live`.

---

## Reuse Map — BanyanCode Concept to OpenCode Module

| BanyanCode Concept | OpenCode Module | File | Line Range |
|---|---|---|---|
| New built-in agents (`orchestrator`, `researcher`) | `Agent.Service` + `agents` table | `packages/opencode/src/agent/agent.ts` | 138–263 |
| Agent prompt imports (`PROMPT_*`) | `agent.ts` imports | `packages/opencode/src/agent/agent.ts` | 12–16 |
| `native: true` convention | agent definition | `packages/opencode/src/agent/agent.ts` | 138–263 |
| User-config overrides win | `for (const [key, value] of Object.entries(cfg.agent ?? {}))` | `packages/opencode/src/agent/agent.ts` | 265–292 |
| Canonical `Tool.make` shape | `tool.ts` | `packages/core/src/tool/tool.ts` | 62–114 |
| `Tools.Service.register` seam | tool registration | `packages/core/src/tool/tools.ts` | 6–12 |
| `ApplicationTools.Service.register` seam | application tool registration | `packages/core/src/tool/application-tools.ts` | 21–28 |
| `Tool.init` / `Tool.define` | opencode tool init | `packages/opencode/src/tool/registry.ts` | 198–215 |
| `background: true` for parallel subagents | `task.ts` | `packages/opencode/src/tool/task.ts` | 97–102, 291–293 |
| `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS` gate | `runtime-flags.ts` | `packages/opencode/src/effect/runtime-flags.ts` | 43 |
| `BackgroundJob.wait` | background job wait | `packages/opencode/src/background/job.ts` | 7–15 |
| `task_id` session reuse | task tool | `packages/opencode/src/tool/task.ts` | 121–123 |
| Built-in commands (`Default.INIT`, `Default.REVIEW`) | command registry | `packages/opencode/src/command/index.ts` | 54–96 |
| External commands via `cfg.command` | command loop | `packages/opencode/src/command/index.ts` | 98–111 |
| MCP prompts join | `mcp.prompts()` loop | `packages/opencode/src/command/index.ts` | 113–140 |
| Skills join | `skill.all()` loop | `packages/opencode/src/command/index.ts` | 142–153 |
| `hints()` for `$1`, `$2`, `$ARGUMENTS` | command hints | `packages/opencode/src/command/index.ts` | 44–52 |
| `SKILL.md` discovery | skill discovery | `packages/opencode/src/skill/index.ts` | 142–233 |
| Frontmatter `{ name, description }` | skill frontmatter validation | `packages/opencode/src/skill/index.ts` | 53–59 |
| Walk-up-to-worktree | `fsys.up()` | `packages/opencode/src/skill/index.ts` | 196–202 |
| Drizzle schema barrel (timestamps helper) | `schema.sql.ts` | `packages/core/src/database/schema.sql.ts` | 1–10 |
| Migration runner | `script/migration.ts` | `packages/core/script/migration.ts` | 1–132 |
| Migration naming pattern | `YYYYMMDDHHMMSS_*` | `packages/core/src/database/migration/` | latest: `20260605042240` |
| `snake_case` column convention | schema style | per root `AGENTS.md` | — |
| `effect-drizzle-sqlite` boundary | DB adapter | `packages/core/src/database/` | — |
| New `Context.Service` | service pattern | per `packages/opencode/AGENTS.md` | — |
| `InstanceState` for per-directory state | instance-scoped state | `packages/opencode/src/effect/instance-state.ts` | 26–45 |
| `EffectBridge` for native callbacks | callback bridge | `packages/opencode/src/effect/bridge.ts` | 54–82 |
| `makeRuntime` | runtime factory | `packages/opencode/src/effect/run-service.ts` | 33–46 |
| Bus event shape | `GlobalBus` | `packages/opencode/src/bus/global.ts` | 4–9 |
| New permission key | free-form `action` string | `packages/core/src/permission/schema.ts` | 8–12 |
| Wildcard rules | `Wildcard.match` | `packages/core/src/util/wildcard.ts` | — |
| Config permission schema | `config.ts` | `packages/core/src/config.ts` | 59–60 |
| Per-agent permission overrides | `Permission.merge` | `packages/opencode/src/agent/agent.ts` | 143–150, 291 |
| `testEffect` / `it.effect` / `it.live` / `it.instance` | test helpers | `packages/opencode/test/lib/effect.ts` | 139–140, 67–129 |
| `tmpdir` fixture | test fixture | `packages/opencode/test/fixture/fixture.ts` | 80–115 |
| `pollWithTimeout` / `awaitWithTimeout` | concurrency helpers | `packages/opencode/test/lib/effect.ts` | 149–177 |
| `BackgroundJob.wait` for concurrency | background wait | `packages/opencode/src/background/job.ts` | 7–15 |
| `Layer.mock` partial-stub pattern | test stubs | per `packages/opencode/test/AGENTS.md` | 150–157 |
| Subagent permission derivation | `deriveSubagentSessionPermission` | `packages/opencode/src/agent/subagent-permissions.ts` | 14–26 |
| WebSearchTool (mirror for websearch_free) | existing tool | `packages/core/src/tool/websearch.ts` | 1–246 |
| 25s timeout / 256KB cap constraint | websearch constraints | `packages/core/src/tool/websearch.ts` | 17–19 |
| `httpparser2` for HTML parsing | already in deps | `packages/opencode/package.json` | — |
| `HttpClient` from `effect/unstable/http` | HTTP client | `packages/core/src/tool/websearch.ts` | 154–177 |

---

## Cross-cutting findings

1. **Migration naming pattern.** Migrations are `YYYYMMDDHHMMSS_*.ts` (timestamp-prefixed). The next BanyanCode migration should be `20260606NNNNNN_banyan_phase1.ts`. The plan's earlier reference to `0009_banyan_phase1.sql` is incorrect and must be updated.

2. **Schema barrel is `schema.sql.ts`, not `schema.ts`.** It contains only a `Timestamps` helper. Tables are individual files. There is no central re-export.

3. **Existing `packages/core/src/permission/schema.ts` is the v2 schema.** v1 rules are still in `permission.ts` and agent definitions. Both must agree for a new permission key to be useful.

4. **Effect v4 fork/dedup.** `Effect.fork` and `Effect.forkDaemon` do not exist; use `Effect.forkIn(scope)`. The orchestrator code must not use sleep-based polling.

5. **`opencode.json` permission syntax.** Per the OpenCode docs, a new permission key can be added as a plain string in the agent's `permission` ruleset. No schema change is required. The user config layer (in `cfg.permission`) must still parse the new key — the schema in `config.ts:59–60` uses `Ruleset` which is `Schema.Array(Rule)` with free-form `action: Schema.String`, so it accepts any string.

6. **The `tools.ts` `Service` tag is `"@opencode/v2/Tools"`** — keep this canonical. New BanyanCode service tags should be `"@banyancode/<Name>"` for namespacing, e.g. `"@banyancode/SubagentBus"`.
