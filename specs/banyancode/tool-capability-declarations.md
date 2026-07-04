# Tool capability declarations — Wave 3 design

> Status: design only, no code. Targets Wave 3 after the Wave 2.5 transport abstraction lands. Affects three systems simultaneously — registration, materialization, runtime execution — so it gets its own wave.

## Motivation

Today the banyan tool wrappers register via `Tool.make({...})` and at execution-time directly `yield*` the Banyan services they need:

```ts
// packages/core/src/tool/codegraph.ts (wave-2 pattern)
export const locationLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const permission = yield* PermissionV2.Service
    const buildService = yield* Banyan.CodegraphBuildService
    const repo = yield* Banyan.CodegraphRepo
    const analyzer = yield* Banyan.CodegraphAnalyzer
    yield* tools.register({...})
  }),
)
```

If a service is missing from scope (e.g. `Banyan.Search` not in AppLayer) the wrapper's `Layer.effectDiscard` build **fails silently** through `withBanyanDeps`'s optional-service path, and the tool is dropped from the catalog without any user-visible signal. The user sees a smaller catalog with no explanation.

Three issues:

1. **Silent drop**: The catalog shrinks; the LLM doesn't know why.
2. **Deferred failure**: If a service IS present at registration time but missing at execution time, the executor throws deep in the Effect stack instead of degrading gracefully.
3. **Coupling**: Each tool wrapper re-implements the same `Effect.serviceOption` defensive pattern by hand.

## Proposal

Extend `Tool.make` with explicit **capability** declarations. The materializer reads them and decides:

- A required capability missing → drop the tool from the catalog (refuse to expose).
- An optional capability missing → expose the tool, the executor degrades.

```ts
type Capability = Context.Tag<any, any>

Tool.make({
    id: "systeminfo",
    requires: [SystemMonitorService] satisfies Capability[],   // hard dep
    optional: [WorkspaceContext] satisfies Capability[],      // soft dep

    description: "...",
    input: Input,
    output: Output,
    toModelOutput: ({ output }) => [...],

    execute: (input, context) => Effect.gen(function* () {
        // yarn-typed as Service; if missing we never reached here.
        const monitor = yield* SystemMonitorService
        // workspaceOpt is `Option<Service>` — defensive but no try/catch
        const workspaceOpt = yield* Effect.serviceOption(WorkspaceContext)
        ...
    }),
})
```

### Three-system implications

The declaration touches three systems simultaneously:

| System | Today | After |
|---|---|---|
| Registration (`Tool.make`) | — | Optional `requires`/`optional` arrays |
| Materialization (`ToolCatalog.materialize`) | Reads every registration | Filters registrations whose `requires` aren't in scope, ordered by `optional` coverage |
| Runtime execution (`Tool.make` executor) | Direct `yield* Banyan.X` per service | Optional services come back as `Option<Service>` |

The materialization step is where the new logic lives. `Tool.make` only adds metadata. Executors don't change shape.

### Outline API

```ts
// packages/core/src/tool/tool.ts

declare const Capability: unique symbol
type Capability<T> = Context.Tag<T, T> | ServiceIdentifier<T>

Tool.make({
    id: "search_auto" as string,
    requires: [SearchService, ToolRegistryService],
    optional: [WorkspaceContext, TelemetryService],

    description: "...",
    input: Schema.Struct({...}),
    output: Schema.Struct({...}),
    toModelOutput: ...,
    execute: (input, ctx) => Effect.gen(function* () {
        const search = yield* SearchService                  // hard dep
        const workspace = yield* WorkspaceContext            // Option<WorkspaceContext>
        ...
    }),
})
```

Service identity flows through `Capability<T> = Context.Tag<T, T>`. Materialization receives a list of `(definition, capability-snapshot)` pairs; for each:

- Compute `available: required ⊆ scope ∧ required ∩ pending-permissions-allow ∧ settled-permissions-allow`
- Decide: drop, expose-disabled, or expose-full.
- Emit a log entry per drop so the startup `Building Tool Catalog...` block shows exactly which tools the user is missing and why.

### Migration plan

Wave 3 (this proposal):

- Add `Capability<T>` type and `requires`/`optional` fields to `Tool.make` (default empty, backward-compatible).
- Add a `ToolCapabilities` snapshot to `Materialization` so executors receive the resolved set of available services.
- Refactor the 6 banyan service kinds (`SystemMonitorService`, `CodegraphAnalyzer`, `Search`, `StructuralQueries`, `EditPlanner`, `CodegraphRepo`) to declare capabilities against the relevant tools.
- AppLayer no longer needs to bring all 6 services — only the ones declared as `requires` for visible tools.

Wave 4 (follow-up):

- Capability-aware permission evaluation: a `requires` set that requires a `Permission.Service` can be auto-allowed if `permissions[]` says so.
- Capability-aware plugin / MCP registration: external transports tag their tools with capabilities instead of inheriting AppLayer ambient services.

### Open design questions

1. **Capability snapshot at materialize vs at execute?** Snapshot at materialize is cheaper (cache), but stale if services move in/out of scope mid-session. Snapshot at execute is correct, slower per-call. Default: materialize-time snapshot, with a fast-path refresh.
2. **Optional capability degradation message**: how does the executor signal "I would have used this but it wasn't there"? A `ToolResult` shape with a `degraded: true` flag? Or a structured `output: { kind: "degraded", missing: string, partial: string }`?
3. **Permission interaction**: when a `Permission.Service` is in `requires[]`, do we silently drop the tool if the user denies it, or surface a permission prompt? Today tools call `permission.assert(...)` and get an exception. Wave 3 keeps the same flow but moves the check earlier — into materialization.

### Why this is a separate wave

- Touches `core/src/tool/tool.ts` (the `Tool.make` API surface).
- Touches `core/src/tool/registry.ts` (the materialize filter).
- Touches every banyan tool wrapper's `Tool.make({...})` call (requires/optional declarations).
- Touches `materializeToToolCallOutput` equivalents in each `Transport` to handle degraded results.

Too large to bundle into the Wave 2.5 transport PR. Doing it as Wave 3 keeps the current architectural boundary intact while this proposal goes through review.

### Status

- 2026-07-04: Drafted after the Wave 2.5 transport abstraction landed. Not yet implemented.
