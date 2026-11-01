/**
 * Local RPC definitions for server namespaces the TUI needs before the server
 * package exports them.
 *
 * `packages/banyancode/package.json` currently exports only `.`/`./rpc`, so
 * `@banyancode/plugin/rpc` exposes `banyancode` (status, config.get). The
 * codegraph / mesh / intel definitions already exist in-tree
 * (`packages/banyancode/src/{codegraph,mesh,intel}/rpc.ts`) but are not
 * exported; these are copies of the parts the TUI consumes.
 *
 * Swap path once `packages/banyancode/package.json` exports them
 * (`./codegraph-rpc`, `./mesh-rpc`, `./intel-rpc`): delete the local
 * definitions here and re-export the real ones through a portable wrapper,
 * exactly like `CoreRpc` in `./rpc.ts` (`client.rpc` only accepts Standard
 * Schema / JSON Schema, and the server definitions are Effect codecs).
 *
 * `usage`, `system`, and the intel `trace` method do not exist server-side yet.
 * Their shapes preserve the v1 HTTP payloads:
 *   GET /global/tool-usage            → usage.tools
 *   GET /global/provider-usage        → usage.providers
 *   POST /global/provider-usage/refresh → usage.providersRefresh
 *   banyancode.system.updated event   → system.updated
 *   GET /global/trace (never shipped) → intel.trace
 */
import { Rpc } from "@opencode/schema/rpc"
import { Schema } from "effect"

/**
 * Client-side definitions must be portable (Standard Schema or JSON Schema).
 * Effect codecs are wrapped so `client.rpc(definition)` keeps full type
 * inference while the transport only sees a Standard Schema.
 */
const std = Schema.toStandardSchemaV1

// ---------------------------------------------------------------------------
// banyancode.codegraph — mirror of packages/banyancode/src/codegraph/rpc.ts
// ---------------------------------------------------------------------------

export const BuildState = Schema.Struct({
  status: Schema.Literals(["idle", "running", "completed", "failed", "cancelled"]),
  root: Schema.optional(Schema.String),
  banyanDir: Schema.optional(Schema.String),
  dbPath: Schema.optional(Schema.String),
  done: Schema.Number,
  total: Schema.Number,
  currentFile: Schema.optional(Schema.String),
  startedAt: Schema.optional(Schema.Number),
  lastProgressAt: Schema.optional(Schema.Number),
  lastCompletedFile: Schema.optional(Schema.String),
  lastCompletedPath: Schema.optional(Schema.String),
  currentlyParsing: Schema.optional(Schema.String),
  graphVersion: Schema.optional(Schema.Number),
  graphCoverage: Schema.optional(Schema.Number),
  totalFiles: Schema.optional(Schema.Number),
  graphBuiltAt: Schema.optional(Schema.Number),
  result: Schema.optional(
    Schema.Struct({
      indexed: Schema.Number,
      skipped: Schema.Number,
      duration_ms: Schema.Number,
      symbolsIndexed: Schema.Number,
      skippedByReason: Schema.Struct({
        gitignored: Schema.Number,
        banyanignored: Schema.Number,
        artifact: Schema.Number,
        tooLarge: Schema.Number,
        minified: Schema.Number,
        tooLargeParse: Schema.Number,
        cached: Schema.Number,
        readError: Schema.Number,
        parseFailure: Schema.Number,
      }),
    }),
  ),
  parseErrors: Schema.optional(
    Schema.Array(Schema.Struct({ path: Schema.String, cause: Schema.String, indexedAt: Schema.Number })),
  ),
  error: Schema.optional(Schema.String),
}).annotate({ identifier: "BanyanCodeTui/CodegraphBuildState" })
export type BuildState = typeof BuildState.Type

export const AutoUpdateState = Schema.Struct({
  status: Schema.Literals(["idle", "watching", "draining", "paused"]),
  pending: Schema.Number,
  lastChangeAt: Schema.optional(Schema.Number),
}).annotate({ identifier: "BanyanCodeTui/CodegraphAutoUpdateState" })
export type AutoUpdateState = typeof AutoUpdateState.Type

export const AutoUpdateProgressState = Schema.Struct({
  status: Schema.Literals(["idle", "watching", "draining", "paused"]),
  pending: Schema.Number,
  lastChangeAt: Schema.optional(Schema.Number),
  phase: Schema.optional(Schema.Literals(["preparing", "indexing", "removing", "done"])),
  completed: Schema.optional(Schema.Number),
  total: Schema.optional(Schema.Number),
  currentFile: Schema.optional(Schema.String),
})
export type AutoUpdateProgressState = typeof AutoUpdateProgressState.Type

export const GraphMeta = Schema.Struct({
  graphBuiltAt: Schema.Number,
  graphVersion: Schema.Number,
  graphCoverage: Schema.Number,
  totalFiles: Schema.Number,
  totalNodes: Schema.Number,
  totalEdges: Schema.Number,
}).annotate({ identifier: "BanyanCodeTui/GraphMeta" })
export type GraphMeta = typeof GraphMeta.Type

export const ReadinessResult = Schema.Struct({
  reason: Schema.Literals(["ready", "missing", "stale", "building", "failed"]),
  autoBuilt: Schema.Boolean,
  graphBuiltAt: Schema.optional(Schema.Number),
  graphVersion: Schema.optional(Schema.Number),
  graphCoverage: Schema.optional(Schema.Number),
  totalFiles: Schema.optional(Schema.Number),
  indexedFiles: Schema.optional(Schema.Number),
  changedFiles: Schema.optional(Schema.Number),
  durationMs: Schema.optional(Schema.Number),
  warning: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
}).annotate({ identifier: "BanyanCodeTui/CodegraphReadiness" })
export type ReadinessResult = typeof ReadinessResult.Type

export const CodegraphNode = Schema.Struct({
  id: Schema.String,
  fileID: Schema.String,
  kind: Schema.String,
  name: Schema.String,
  signature: Schema.optional(Schema.String),
  startLine: Schema.Number,
  endLine: Schema.Number,
  isEntrypoint: Schema.optional(Schema.Number),
  inDegree: Schema.optional(Schema.Number),
}).annotate({ identifier: "BanyanCodeTui/CodegraphNodeRow" })
export type CodegraphNode = typeof CodegraphNode.Type

export const CodegraphEdge = Schema.Struct({
  id: Schema.String,
  fromNodeID: Schema.String,
  toNodeID: Schema.String,
  kind: Schema.String,
}).annotate({ identifier: "BanyanCodeTui/CodegraphEdgeRow" })
export type CodegraphEdge = typeof CodegraphEdge.Type

export const CodegraphFile = Schema.Struct({
  id: Schema.String,
  path: Schema.String,
  contentHash: Schema.String,
  language: Schema.String,
  indexedAt: Schema.Number,
  sizeBytes: Schema.optional(Schema.Number),
  mtimeMs: Schema.optional(Schema.Number),
}).annotate({ identifier: "BanyanCodeTui/CodegraphFile" })
export type CodegraphFile = typeof CodegraphFile.Type

export const CodegraphStatusOutput = Schema.Struct({
  build: BuildState,
  readiness: ReadinessResult,
  autoUpdate: AutoUpdateState,
  meta: Schema.optional(GraphMeta),
  databasePath: Schema.String,
  schemaVersion: Schema.Int,
}).annotate({ identifier: "BanyanCodeTui/CodegraphStatus" })
export type CodegraphStatusOutput = typeof CodegraphStatusOutput.Type

export const CodegraphNodesOutput = Schema.Struct({
  nodes: Schema.Array(CodegraphNode),
  nextCursor: Schema.optional(Schema.String),
})
export type CodegraphNodesOutput = typeof CodegraphNodesOutput.Type

export const CodegraphEdgesOutput = Schema.Struct({
  edges: Schema.Array(CodegraphEdge),
  nextCursor: Schema.optional(Schema.String),
})
export type CodegraphEdgesOutput = typeof CodegraphEdgesOutput.Type

export const CodegraphFilesOutput = Schema.Struct({
  files: Schema.Array(CodegraphFile),
  nextCursor: Schema.optional(Schema.String),
})
export type CodegraphFilesOutput = typeof CodegraphFilesOutput.Type

const RootInput = Schema.Struct({ root: Schema.optional(Schema.String) })
const Page = {
  cursor: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.Number),
}

export const CodegraphRpc = Rpc.define({
  id: "banyancode.codegraph",
  methods: {
    build: {
      input: std(
        Schema.Struct({
          root: Schema.optional(Schema.String),
          force: Schema.optional(Schema.Boolean),
          excludePatterns: Schema.optional(Schema.Array(Schema.String)),
        }),
      ),
      output: std(BuildState),
    },
    cancel: { input: std(Schema.Struct({})), output: std(BuildState) },
    forceKill: {
      input: std(Schema.Struct({})),
      output: std(Schema.Struct({ ok: Schema.Boolean, message: Schema.String })),
    },
    remove: {
      input: std(Schema.Struct({ dropFile: Schema.optional(Schema.Boolean) })),
      output: std(
        Schema.Struct({
          status: Schema.Literals(["removed", "empty"]),
          sizeBefore: Schema.Number,
          sizeAfter: Schema.Number,
          freedBytes: Schema.Number,
        }),
      ),
    },
    status: { input: std(RootInput), output: std(CodegraphStatusOutput) },
    nodes: { input: std(Schema.Struct(Page)), output: std(CodegraphNodesOutput) },
    edges: { input: std(Schema.Struct(Page)), output: std(CodegraphEdgesOutput) },
    files: { input: std(Schema.Struct(Page)), output: std(CodegraphFilesOutput) },
  },
  events: {
    build: { schema: std(BuildState) },
    autoUpdate: { schema: std(AutoUpdateState) },
    autoUpdateProgress: { schema: std(AutoUpdateProgressState) },
  },
})

// ---------------------------------------------------------------------------
// banyancode.mesh — mirror of packages/banyancode/src/mesh/rpc.ts
// ---------------------------------------------------------------------------

const MeshTokens = Schema.Struct({
  input: Schema.Number,
  output: Schema.Number,
  reasoning: Schema.Number,
  cache: Schema.Struct({ read: Schema.Number, write: Schema.Number }),
})
export type MeshTokens = typeof MeshTokens.Type

const MeshModel = Schema.Struct({
  providerID: Schema.String,
  id: Schema.String,
  variant: Schema.optional(Schema.String),
})

export interface MeshNode {
  readonly sessionID: string
  readonly parentID?: string
  readonly title?: string
  readonly agent?: string
  readonly model?: { readonly providerID: string; readonly id: string; readonly variant?: string }
  readonly state: "running" | "retry" | "idle" | "failed" | "interrupted" | "unknown"
  readonly cost: number
  readonly tokens: MeshTokens
  readonly createdAt: number
  readonly updatedAt: number
  readonly lastActivityAt?: number
  readonly children: ReadonlyArray<MeshNode>
}

export const MeshNodeSchema: Schema.Codec<MeshNode> = Schema.Struct({
  sessionID: Schema.String,
  parentID: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  agent: Schema.optional(Schema.String),
  model: Schema.optional(MeshModel),
  state: Schema.Literals(["running", "retry", "idle", "failed", "interrupted", "unknown"]),
  cost: Schema.Number,
  tokens: MeshTokens,
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
  lastActivityAt: Schema.optional(Schema.Number),
  children: Schema.Array(Schema.suspend((): Schema.Codec<MeshNode> => MeshNodeSchema)),
})

export const MeshStatusOutput = Schema.Struct({
  roots: Schema.Array(MeshNodeSchema),
  generatedAt: Schema.Number,
})
export type MeshStatusOutput = typeof MeshStatusOutput.Type

export const MeshRpc = Rpc.define({
  id: "banyancode.mesh",
  methods: {
    status: {
      input: std(Schema.Struct({ sessionID: Schema.optional(Schema.String) })),
      output: std(MeshStatusOutput),
    },
    sessionStatus: {
      input: std(Schema.Struct({ sessionID: Schema.String })),
      output: std(MeshStatusOutput),
    },
    "limits.get": {
      input: std(Schema.Struct({})),
      output: std(
        Schema.Struct({
          maxSubagents: Schema.Number,
          backgroundSubagents: Schema.Boolean,
          swarmMode: Schema.Boolean,
          maxSubagentsLimit: Schema.Number,
          maxSubagentsDefault: Schema.Number,
        }),
      ),
    },
  },
  events: {
    "status.updated": {
      schema: std(Schema.Struct({ rootSessionID: Schema.String, tree: MeshNodeSchema })),
    },
  },
})

// ---------------------------------------------------------------------------
// banyancode.usage — v1 /global/tool-usage + /global/provider-usage
// ---------------------------------------------------------------------------

export const ToolUsageRow = Schema.Struct({
  toolId: Schema.String,
  useCount: Schema.Number,
  lastUsedAt: Schema.Number,
}).annotate({ identifier: "BanyanCodeTui/ToolUsageRow" })
export type ToolUsageRow = typeof ToolUsageRow.Type

export const ToolUsageOutput = Schema.Struct({ tools: Schema.Array(ToolUsageRow) }).annotate({
  identifier: "BanyanCodeTui/ToolUsage",
})
export type ToolUsageOutput = typeof ToolUsageOutput.Type

export const ProviderUsageWindow = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  kind: Schema.Literals(["quota", "rate_limit"]),
  usedPercent: Schema.optional(Schema.Number),
  remainingPercent: Schema.optional(Schema.Number),
  resetsAt: Schema.optional(Schema.Number),
  durationSeconds: Schema.optional(Schema.Number),
  limit: Schema.optional(Schema.Number),
  remaining: Schema.optional(Schema.Number),
}).annotate({ identifier: "BanyanCodeTui/ProviderUsageWindow" })
export type ProviderUsageWindow = typeof ProviderUsageWindow.Type

export const ProviderUsageSnapshot = Schema.Struct({
  providerID: Schema.String,
  displayName: Schema.String,
  status: Schema.Literals(["available", "stale", "unsupported", "unauthenticated", "error"]),
  confidence: Schema.Literals(["exact", "reported", "estimated"]),
  windows: Schema.Array(ProviderUsageWindow),
  balance: Schema.optional(Schema.Struct({ remaining: Schema.Number, currency: Schema.optional(Schema.String) })),
  message: Schema.optional(Schema.String),
  fetchedAt: Schema.Number,
}).annotate({ identifier: "BanyanCodeTui/ProviderUsageSnapshot" })
export type ProviderUsageSnapshot = typeof ProviderUsageSnapshot.Type

export const ProviderUsageOutput = Schema.Struct({ snapshots: Schema.Array(ProviderUsageSnapshot) }).annotate({
  identifier: "BanyanCodeTui/ProviderUsage",
})
export type ProviderUsageOutput = typeof ProviderUsageOutput.Type

export const UsageRpc = Rpc.define({
  id: "banyancode.usage",
  methods: {
    tools: {
      input: std(Schema.Struct({ session: Schema.optional(Schema.String) })),
      output: std(ToolUsageOutput),
    },
    providers: { input: std(Schema.Struct({})), output: std(ProviderUsageOutput) },
    providersRefresh: {
      input: std(
        Schema.Struct({
          providerID: Schema.optional(
            Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9._-]+$/), Schema.isMaxLength(128)),
          ),
        }),
      ),
      output: std(ProviderUsageOutput),
    },
  },
  events: {},
})

// ---------------------------------------------------------------------------
// banyancode.system — v1 `banyancode.system.updated` EventV2 payload
// ---------------------------------------------------------------------------

export const SystemStatus = Schema.Struct({
  cpuPercent: Schema.optional(Schema.Number),
  memoryUsedBytes: Schema.Number,
  memoryTotalBytes: Schema.Number,
  gpuPercent: Schema.optional(Schema.Number),
  vramUsedBytes: Schema.optional(Schema.Number),
  gpuTotalBytes: Schema.optional(Schema.Number),
  diskUsedBytes: Schema.optional(Schema.Number),
  diskTotalBytes: Schema.optional(Schema.Number),
  platform: Schema.Literals(["windows", "linux", "darwin"]),
}).annotate({ identifier: "BanyanCodeTui/SystemStatus" })
export type SystemStatus = typeof SystemStatus.Type

export const SystemRpc = Rpc.define({
  id: "banyancode.system",
  methods: {
    status: { input: std(Schema.Struct({})), output: std(SystemStatus) },
  },
  events: {
    updated: { schema: std(SystemStatus) },
  },
})

// ---------------------------------------------------------------------------
// banyancode.intel.trace — v1 GET /global/trace (declared, never shipped)
// ---------------------------------------------------------------------------

export const TraceRow = Schema.Struct({
  ts: Schema.Number,
  tool: Schema.String,
  inputSummary: Schema.String,
  resultSummary: Schema.String,
  ms: Schema.optional(Schema.Number),
}).annotate({ identifier: "BanyanCodeTui/TraceRow" })
export type TraceRow = typeof TraceRow.Type

export const IntelTraceOutput = Schema.Struct({ events: Schema.Array(TraceRow) })
export type IntelTraceOutput = typeof IntelTraceOutput.Type

export const IntelRpc = Rpc.define({
  id: "banyancode.intel",
  methods: {
    trace: {
      input: std(Schema.Struct({ session: Schema.String, limit: Schema.optional(Schema.Number) })),
      output: std(IntelTraceOutput),
    },
  },
  events: {},
})
