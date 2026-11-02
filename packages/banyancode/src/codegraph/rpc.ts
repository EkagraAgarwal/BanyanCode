/**
 * RPC surface for the codegraph workstream.
 *
 * Replaces v1's `/global/codegraph-*` HTTP routes. Definition id is
 * `banyancode.codegraph`, so events are delivered as
 * `rpc.banyancode.codegraph.{build,autoUpdate,autoUpdateProgress}` — matching
 * the parity table's route→RPC mapping.
 */
import { Rpc } from "@opencode/schema/rpc"
import { Schema } from "effect"
import { State as BuildState } from "./codegraph-build-service.js"
import { ProgressState as AutoUpdateProgressState, State as AutoUpdateState } from "./codegraph-auto-update.js"
import { ReadinessResult } from "./codegraph-readiness.js"
import { GraphMeta } from "./types.js"

const CodegraphFile = Schema.Struct({
  id: Schema.String,
  path: Schema.String,
  contentHash: Schema.String,
  language: Schema.String,
  indexedAt: Schema.Number,
  sizeBytes: Schema.optional(Schema.Number),
  mtimeMs: Schema.optional(Schema.Number),
}).annotate({ identifier: "Banyan.CodegraphFile" })

const CodegraphNode = Schema.Struct({
  id: Schema.String,
  fileID: Schema.String,
  kind: Schema.String,
  name: Schema.String,
  signature: Schema.optional(Schema.String),
  startLine: Schema.Number,
  endLine: Schema.Number,
  isEntrypoint: Schema.optional(Schema.Number),
  inDegree: Schema.optional(Schema.Number),
}).annotate({ identifier: "Banyan.CodegraphNodeRow" })

const CodegraphEdge = Schema.Struct({
  id: Schema.String,
  fromNodeID: Schema.String,
  toNodeID: Schema.String,
  kind: Schema.String,
}).annotate({ identifier: "Banyan.CodegraphEdgeRow" })

export const StatusOutput = Schema.Struct({
  build: BuildState,
  readiness: ReadinessResult,
  autoUpdate: AutoUpdateState,
  meta: Schema.optional(GraphMeta),
  databasePath: Schema.String,
  schemaVersion: Schema.Int,
}).annotate({ identifier: "Banyan.CodegraphStatus" })

export const RemoveOutput = Schema.Struct({
  status: Schema.Literals(["removed", "empty"]),
  sizeBefore: Schema.Number,
  sizeAfter: Schema.Number,
  freedBytes: Schema.Number,
  // Always false: the database is open, so `--drop-file` clears it instead of
  // unlinking it. Exposed so callers can describe what actually happened.
  droppedFile: Schema.Boolean,
}).annotate({ identifier: "Banyan.CodegraphRemoveOutput" })

export const ForceKillOutput = Schema.Struct({
  ok: Schema.Boolean,
  message: Schema.String,
})

export const NodesOutput = Schema.Struct({
  nodes: Schema.Array(CodegraphNode),
  nextCursor: Schema.optional(Schema.String),
})

export const EdgesOutput = Schema.Struct({
  edges: Schema.Array(CodegraphEdge),
  nextCursor: Schema.optional(Schema.String),
})

export const FilesOutput = Schema.Struct({
  files: Schema.Array(CodegraphFile),
  nextCursor: Schema.optional(Schema.String),
})

export const StalenessOutput = Schema.Struct({
  staleFiles: Schema.Int,
  missingFiles: Schema.Int,
  totalFiles: Schema.Int,
  topStale: Schema.Array(
    Schema.Struct({ path: Schema.String, mtimeMs: Schema.Number, indexedAt: Schema.Number }),
  ),
  topMissing: Schema.Array(Schema.Struct({ path: Schema.String, indexedAt: Schema.Number })),
})

export const AutoUpdateFlushOutput = Schema.Struct({
  discovered: Schema.Int,
  indexed: Schema.Int,
  removed: Schema.Int,
  cached: Schema.Int,
  pending: Schema.Int,
})

export const AutoUpdateReconcileOutput = Schema.Struct({
  discovered: Schema.Int,
  changed: Schema.Int,
  removed: Schema.Int,
  cached: Schema.Int,
})

const RootInput = Schema.Struct({
  root: Schema.optional(Schema.String),
})

export const Definition = Rpc.define({
  id: "banyancode.codegraph",
  methods: {
    build: {
      input: Schema.Struct({
        root: Schema.optional(Schema.String),
        force: Schema.optional(Schema.Boolean),
        excludePatterns: Schema.optional(Schema.Array(Schema.String)),
      }),
      output: BuildState,
    },
    cancel: { input: Schema.Struct({}), output: BuildState },
    forceKill: { input: Schema.Struct({}), output: ForceKillOutput },
    remove: {
      input: Schema.Struct({ dropFile: Schema.optional(Schema.Boolean) }),
      output: RemoveOutput,
    },
    status: { input: RootInput, output: StatusOutput },
    nodes: {
      input: Schema.Struct({ cursor: Schema.optional(Schema.String), limit: Schema.optional(Schema.Number) }),
      output: NodesOutput,
    },
    edges: {
      input: Schema.Struct({ cursor: Schema.optional(Schema.String), limit: Schema.optional(Schema.Number) }),
      output: EdgesOutput,
    },
    files: {
      input: Schema.Struct({ cursor: Schema.optional(Schema.String), limit: Schema.optional(Schema.Number) }),
      output: FilesOutput,
    },
    staleness: { input: RootInput, output: StalenessOutput },
    "autoUpdate.status": { input: Schema.Struct({}), output: AutoUpdateState },
    "autoUpdate.flush": {
      input: Schema.Struct({ root: Schema.optional(Schema.String), maxPaths: Schema.optional(Schema.Number) }),
      output: AutoUpdateFlushOutput,
    },
    "autoUpdate.reconcile": { input: RootInput, output: AutoUpdateReconcileOutput },
  },
  events: {
    /** Build progress; replaces `banyancode.codegraph.build` (v1 EventV2). */
    build: { schema: BuildState },
    /** Watcher state; replaces `banyancode.codegraph.auto-update`. */
    autoUpdate: { schema: AutoUpdateState },
    /** Incremental drain progress; replaces `...auto-update.progress`. */
    autoUpdateProgress: { schema: AutoUpdateProgressState },
  },
})

export type Definition = typeof Definition
