# BanyanCode Tool Transport Abstraction — Wave 2.5

> Source-doc status: locked. Edits below track architectural decisions, not "implementation history." Once the tool infra is verified end-to-end visible + executable, this doc marks `core/src/tool/*` as frozen and engineering effort shifts to `RepositoryIntelligence`, `ArchitecturalSlice`, ranking, and benchmarks.

## Target architecture

```
                           ToolCatalog.Service (canonical)
                                       │
                            materialize(permissions?) → {definitions, settle}
                                       │
              ┌──────────────────┬──────┴─────────┬───────────────────┐
              │                  │                │                   │
   V1 legacy (s.builtin)   AiSdkTransport   McpTransport      future...
   (transport-v1 inside    .buildTools()    .buildTools()
    opencode registry)         │                │
              │               ▼                ▼
              ▼           AI SDK tool({})   MCP Tool
        opencode V1           │
        Tool.Def              ▼
              │          Model
              ▼
          Model
```

Invariants:

1. **`ToolCatalog.materialize()`** is the only path through which new tools reach the LLM.
2. **`AiSdkTransport.buildTools(catalog, ctx)`** is one peer transport. Future transports (MCP, CLI, REST, plugin-runtime, REST) are peers; each contributes one entry in a `Transport[]` loop in `SessionTools.resolve`.
3. **`s.builtin`** is an implementation detail of the V1 legacy transport. V2 banyan tools do NOT get merged into `s.builtin`. They flow exclusively through `AiSdkTransport`.
4. **No edits to `core/src/tool/*`** in this PR. The canonical pipeline stays untouched. Integration fixes are entirely inside `packages/opencode/`.
5. **Every materialized tool must be executable.** Banyan services that tool wrappers `yield*` must be present in AppLayer before the tool is materialized. Visible AND executable, or visibly degraded with a meaningful message via `Effect.serviceOption`.
6. **Future transports** (MCP, CLI, REST, plugins) compose into `SessionTools.resolve` via the transport loop.

## File changes

```
packages/opencode/src/effect/transport-v2.ts              → DELETE (renamed)
packages/opencode/src/effect/transport-ai-sdk.ts           → NEW (renamed + restructured)
packages/opencode/src/effect/tool-transport.ts             → NEW (peer interface + types)
packages/opencode/src/session/tools.ts                     → REFACTOR SessionTools.resolve to be a transport loop
packages/opencode/src/effect/app-runtime.ts                → add AiSdkTransport + missing Banyan services
packages/opencode/test/effect/transport-ai-sdk.test.ts    → NEW (unit + smoke)
packages/opencode/test/effect/tool-catalog.test.ts         → extend (smoke invocation per visible tool)
specs/banyancode/tool-capability-declarations.md            → NEW (Wave 3 design doc)
```

No edits to `core/`.

## Public types

```ts
// packages/opencode/src/effect/tool-transport.ts

export interface ToolMaterializationContext {
  readonly sessionID: string
  readonly assistantMessageID: string
  readonly agent: string
  readonly model: Parameters<typeof ProviderTransform.schema>[0]
  readonly messages: SessionV1.WithParts[]
  readonly workspace: WorkspaceV2.ID | undefined
  readonly permissions: PermissionV2.Ruleset
  readonly run: EffectBridge.Shape
  readonly pluginTrigger: (
    event: "tool.execute.before" | "tool.execute.after",
    payload: unknown,
    out: unknown,
  ) => Effect.Effect<void, unknown, never>
}

export interface ToolMaterialization<T> {
  readonly id: string
  readonly tool: T
}

export interface ToolTransport<T> {
  readonly buildTools: (
    catalog: ToolCatalog.Service,
    context: ToolMaterializationContext,
  ) => Effect.Effect<readonly ToolMaterialization<T>[], never, never>
}
```

```ts
// packages/opencode/src/effect/transport-ai-sdk.ts (renamed from transport-v2.ts)

export class AiSdkTransport extends Context.Service<AiSdkTransport, ToolTransport<AITool>>()(
  "@opencode/AiSdkToolTransport",
) {}

export const layer: Layer.Layer<AiSdkTransport, never, ToolCatalog.Service>
```

## SessionTools.resolve (refactored)

The loop is the seed: every transport contributes; first-write-wins on collision.

```ts
// packages/opencode/src/session/tools.ts (refactored)

export const resolve = Effect.fn("SessionTools.resolve")(function* (input: {...}) {
  const tools: Record<string, AITool> = {}
  const ctx: ToolMaterializationContext = {
    sessionID: input.session.id,
    assistantMessageID: input.processor.message.id,
    agent: input.agent.name,
    model: input.model,
    messages: input.messages,
    workspace: undefined,
    permissions: /* agent + session rules */,
    run,
    pluginTrigger: (event, payload, out) =>
      plugin.trigger(event, payload as never, out as never),
  }

  for (const transport of yield* resolveTransports()) {
    for (const { id, tool } of yield* transport.buildTools(toolCatalog, ctx)) {
      if (tools[id]) continue
      tools[id] = tool
    }
  }

  return tools
})
```

MCP is folded into its own `McpTransport: ToolTransport<MCPTool>` in a follow-up.

## Missing Banyan services in this PR (added to AppLayer)

Per the "visible AND executable" invariant:

| Service | Wrappers depending on it | Action |
|---|---|---|
| `Banyan.SystemMonitorService` | (read by `systeminfo` via `serviceOption`) | add |
| `Banyan.CodegraphAnalyzer` | `codegraph_impact/dependents/callers` | add |
| `Banyan.Search` | `codegraph_search` | add |
| `Banyan.StructuralQueries` | `code_find`, `codegraph_search` | add |
| `Banyan.Git` | `repo_findOwner` (in `findOwner`) | add |

Existing (verified present): `codegraphBuildService`, `repositoryIntelligence`, `editPlanner`, `codegraphRepo`, `toolRegistryDefaultLayer`, `toolCatalogDefaultLayer`.

## Regression tests

1. **`AiSdkTransport.buildTools(catalog, ctx)` returns one entry per `materialize().definitions` entry.** IDs match exactly.
2. **Smoke invocation per visible tool.** Every `AiSdkTransport.buildTools` entry's `execute` is called with schema-valid dummy input. Errors must be `PermissionDenied`, `UnknownTool`, or genuine execution failure — NOT `Effect.serviceOption` returning None, NOT an unhandled defect.
3. **`SessionTools.resolve` end-to-end.** Mock minimal provider. Resolved `tools` object contains every V1 primitive and every banyan V2 tool by name with non-empty `description`.
4. **Drift check.** `ToolCatalog.list().size === ToolCatalog.materialize().definitions.length`.
5. **Transport loop shape.** Loop iterates the registered transports in defined order.

## Status log

- 2026-07-04: Plan locked. Starting build.
