/**
 * Portable client definitions for the BanyanCode RPC namespaces the CLI calls.
 *
 * The server definitions live in `@banyancode/plugin/rpc/{codegraph,intel,usage}`
 * and are Effect codecs. `packages/cli` does not depend on `@banyancode/plugin`
 * (adding the workspace dependency is a packaging change owned elsewhere), so
 * the definitions are mirrored here as Standard Schemas.
 *
 * `client.rpc()` only reads `definition.id` and the method names at runtime;
 * the schemas exist for type inference and are never validated client-side
 * (see `packages/client/src/promise/rpc.ts`). Keep the ids and method names
 * byte-identical to the server definitions — a rename there is a silent
 * `rpc.method_not_found` here.
 */
import { Rpc } from "@opencode/schema/rpc"
import { Schema } from "effect"

const std = <S extends Schema.Top>(schema: S) =>
  Schema.toStandardSchemaV1(schema as unknown as Schema.Codec<S["Type"], S["Encoded"]>)

const optionalString = Schema.optional(Schema.String)
const optionalNumber = Schema.optional(Schema.Number)
const optionalBoolean = Schema.optional(Schema.Boolean)

// ---------------------------------------------------------------------------
// banyancode.codegraph
// ---------------------------------------------------------------------------

export const BuildResult = Schema.Struct({
  indexed: Schema.Number,
  skipped: Schema.Number,
  duration_ms: Schema.Number,
  symbolsIndexed: Schema.Number,
})

export const BuildState = Schema.Struct({
  status: Schema.Literals(["idle", "running", "completed", "failed", "cancelled"]),
  root: optionalString,
  banyanDir: optionalString,
  dbPath: optionalString,
  done: Schema.Number,
  total: Schema.Number,
  currentFile: optionalString,
  startedAt: optionalNumber,
  lastProgressAt: optionalNumber,
  lastCompletedFile: optionalString,
  lastCompletedPath: optionalString,
  currentlyParsing: optionalString,
  graphVersion: optionalNumber,
  graphCoverage: optionalNumber,
  totalFiles: optionalNumber,
  graphBuiltAt: optionalNumber,
  result: Schema.optional(BuildResult),
  error: optionalString,
})

export type BuildState = typeof BuildState.Type

export const Readiness = Schema.Struct({
  reason: Schema.Literals(["ready", "missing", "stale", "building", "failed"]),
  autoBuilt: Schema.Boolean,
  graphBuiltAt: optionalNumber,
  graphVersion: optionalNumber,
  graphCoverage: optionalNumber,
  totalFiles: optionalNumber,
  indexedFiles: optionalNumber,
  changedFiles: optionalNumber,
  durationMs: optionalNumber,
  warning: optionalString,
  error: optionalString,
})

export const AutoUpdate = Schema.Struct({
  status: Schema.Literals(["idle", "watching", "draining", "paused"]),
  pending: Schema.Number,
  lastChangeAt: optionalNumber,
})

export const CodegraphStatus = Schema.Struct({
  build: BuildState,
  readiness: Readiness,
  autoUpdate: AutoUpdate,
  meta: Schema.optional(Schema.Unknown),
  databasePath: Schema.String,
  schemaVersion: Schema.Number,
})

export type CodegraphStatus = typeof CodegraphStatus.Type

export const RemoveResult = Schema.Struct({
  status: Schema.Literals(["removed", "empty"]),
  sizeBefore: Schema.Number,
  sizeAfter: Schema.Number,
  freedBytes: Schema.Number,
})

export const ForceKillResult = Schema.Struct({
  ok: Schema.Boolean,
  message: Schema.String,
})

export const CodegraphRpc = Rpc.define({
  id: "banyancode.codegraph",
  methods: {
    build: {
      input: std(
        Schema.Struct({
          root: optionalString,
          force: optionalBoolean,
          excludePatterns: Schema.optional(Schema.Array(Schema.String)),
        }),
      ),
      output: std(BuildState),
    },
    cancel: { input: std(Schema.Struct({})), output: std(BuildState) },
    forceKill: { input: std(Schema.Struct({})), output: std(ForceKillResult) },
    remove: { input: std(Schema.Struct({ dropFile: optionalBoolean })), output: std(RemoveResult) },
    status: { input: std(Schema.Struct({ root: optionalString })), output: std(CodegraphStatus) },
  },
  events: {},
})

// ---------------------------------------------------------------------------
// banyancode.intel
// ---------------------------------------------------------------------------

const GraphNode = Schema.Struct({
  id: Schema.String,
  fileID: Schema.String,
  kind: Schema.String,
  name: Schema.String,
  signature: optionalString,
  startLine: Schema.Number,
  endLine: Schema.Number,
})

export type GraphNode = typeof GraphNode.Type

const GraphFile = Schema.Struct({
  id: Schema.String,
  path: Schema.String,
  language: Schema.String,
  indexedAt: Schema.Number,
})

const Workspace = Schema.Struct({
  worktree: Schema.String,
  focusDirs: Schema.Array(Schema.String),
})

const ArchitecturalSlice = Schema.Struct({
  status: Schema.optional(Schema.Literals(["success", "partial", "failed"])),
  reason: optionalString,
  recoveryHint: optionalString,
  fallbackUsed: optionalBoolean,
  degraded: optionalBoolean,
  summary: Schema.String,
  entrypoints: Schema.Array(GraphNode),
  importantSymbols: Schema.Array(GraphNode),
  relatedTests: Schema.Array(GraphNode),
  relatedDocs: Schema.Array(GraphFile),
  configs: Schema.Array(GraphFile),
  routes: Schema.Array(GraphNode),
  directCallers: Schema.Array(GraphNode),
  transitiveDependents: Schema.Array(GraphNode),
})

export type ArchitecturalSlice = typeof ArchitecturalSlice.Type

const RepositoryContext = Schema.Struct({
  status: Schema.optional(Schema.Literals(["success", "partial", "failed"])),
  reason: optionalString,
  query: Schema.String,
  symbols: Schema.Array(GraphNode),
  files: Schema.Array(GraphFile),
  graph: Schema.Struct({
    nodes: Schema.Array(GraphNode),
    edges: Schema.Array(Schema.Unknown),
  }),
  tests: Schema.Array(GraphNode),
  docs: Schema.Array(GraphFile),
  configs: Schema.Array(GraphFile),
  git: Schema.Struct({
    recentCommits: Schema.Array(Schema.Unknown),
    ownership: Schema.Array(Schema.Struct({ path: Schema.String, count: Schema.Number })),
  }),
})

export type RepositoryContext = typeof RepositoryContext.Type

const Ownership = Schema.Struct({
  owner: optionalString,
  count: Schema.Number,
})

export const IntelRpc = Rpc.define({
  id: "banyancode.intel",
  methods: {
    query: {
      input: std(
        Schema.Struct({ query: Schema.String, limit: optionalNumber, workspace: Schema.optional(Workspace) }),
      ),
      output: std(Schema.Struct({ slice: ArchitecturalSlice, context: RepositoryContext })),
    },
    explain: {
      input: std(Schema.Struct({ symbol: Schema.String, workspace: Schema.optional(Workspace) })),
      output: std(ArchitecturalSlice),
    },
    trace: {
      input: std(
        Schema.Struct({
          symbol: Schema.String,
          depth: optionalNumber,
          limit: optionalNumber,
          workspace: Schema.optional(Workspace),
        }),
      ),
      output: std(ArchitecturalSlice),
    },
    impact: {
      input: std(Schema.Struct({ path: Schema.String, workspace: Schema.optional(Workspace) })),
      output: std(ArchitecturalSlice),
    },
    tests: {
      input: std(Schema.Struct({ symbol: Schema.String, limit: optionalNumber })),
      output: std(Schema.Array(GraphNode)),
    },
    relationships: {
      input: std(
        Schema.Struct({ nodeID: optionalString, path: optionalString, depth: optionalNumber }),
      ),
      output: std(Schema.Array(GraphNode)),
    },
    ownership: {
      input: std(Schema.Struct({ path: Schema.String, workspace: Schema.optional(Workspace) })),
      output: std(Ownership),
    },
  },
  events: {},
})

// ---------------------------------------------------------------------------
// banyancode.usage — agent telemetry report/export
// ---------------------------------------------------------------------------

const AgentRoleReport = Schema.Struct({
  events: Schema.Number,
  inputTokens: Schema.NullOr(Schema.Number),
  outputTokens: Schema.NullOr(Schema.Number),
  cost: Schema.NullOr(Schema.Number),
  cachedInputTokens: Schema.NullOr(Schema.Number),
  uncachedInputTokens: Schema.NullOr(Schema.Number),
})

export const AgentReport = Schema.Struct({
  eventCount: Schema.Number,
  runCount: Schema.Number,
  agentCount: Schema.Number,
  modelCallCount: Schema.Number,
  toolCallCount: Schema.Number,
  inputTokens: Schema.Number,
  cachedInputTokens: Schema.Number,
  uncachedInputTokens: Schema.Number,
  outputTokens: Schema.Number,
  totalCost: Schema.Number,
  realizedCacheReadRatio: Schema.NullOr(Schema.Number),
  byRole: Schema.Record(Schema.String, AgentRoleReport),
})

export type AgentReport = typeof AgentReport.Type

const AgentFilter = Schema.Struct({
  runID: optionalString,
  sessionID: optionalString,
  since: optionalNumber,
  limit: optionalNumber,
})

export const UsageRpc = Rpc.define({
  id: "banyancode.usage",
  methods: {
    toolUsage: {
      input: std(Schema.Struct({ session: optionalString })),
      output: std(
        Schema.Struct({
          tools: Schema.Array(
            Schema.Struct({ toolId: Schema.String, useCount: Schema.Number, lastUsedAt: Schema.Number }),
          ),
        }),
      ),
    },
    "telemetry.agentReport": { input: std(AgentFilter), output: std(AgentReport) },
    "telemetry.agentExport": {
      input: std(AgentFilter),
      output: std(
        Schema.Struct({
          jsonl: Schema.String,
          count: Schema.Number,
          events: Schema.Array(Schema.Unknown),
        }),
      ),
    },
  },
  events: {},
})
