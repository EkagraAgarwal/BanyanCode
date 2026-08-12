export * as RepositoryGatewayBackends from "./backends"

import { Effect, Option } from "effect"
import { Service as RepositoryIntelligence } from "../repository-intelligence"
import type { Interface as RepositoryIntelligenceInterface } from "../repository-intelligence"
import type { CodegraphNode } from "../types"
import { ROUTER_IDENTITY, ROUTER_VERSION } from "./router"
import type { RepositoryBackend } from "./gateway"
import type { Relation, RepositoryOperation, RepositoryResult, RepositoryResultItem } from "./types"

// INTELLIGENCE backend for the RepositoryGateway (plan §2.4, Gate C). Executes
// relationship + symbol operations against the code graph through the existing
// `@banyancode/RepositoryIntelligence` service. The backend is a plain
// `RepositoryBackend` — selected by the gateway's BackendSelector seam when the
// router decides `{ route: "intelligence" }`.
//
// Fail-closed by contract (spec §35): the backend NEVER fails and NEVER
// fabricates. Missing RepositoryIntelligence service, an unmapped relation,
// a degraded graph, or any defect resolves to a result with `route: "direct"`,
// which the gateway maps to `{ route: "direct" }` so the original tool runs
// untouched.
//
// Relation -> method mapping (resolved against repository-intelligence/layer.ts):
//
//   callers    -> query({ query: target }) + slice(ctx).directCallers
//                 slice's directCallers is `findCallers` = incoming BFS over
//                 CALLER_EDGE_KINDS { calls, references } at depth 1 — exactly
//                 the "who calls X" semantics.
//   references -> same as callers. References are a subset of the same incoming
//                 CALLER_EDGE_KINDS set the depth-1 BFS traverses.
//   dependents -> query + slice(ctx).directCallers + slice(ctx).transitiveDependents
//                 = all incoming edges (direct depth-1 + transitive depth>1).
//                 Transitive nodes are omitted from the item list when their
//                 fileID is outside the query's file bucket (no path to report)
//                 rather than fabricating one.
//   imports / implementations / extensions -> DIRECT (fail-closed). No
//                 RepositoryIntelligence method isolates a single edge kind:
//                 `slice().dependencies` groups calls/references/imports/extends,
//                 `relationships()` is bidirectional, and there is no
//                 "implements" edge kind in the graph. Routing these to a mixed
//                 dependency set would fabricate precision, so they stay direct.
//   symbol     -> query({ query }).symbols — the graph's symbol resolution
//                 (findSymbol + FTS), with paths resolved from ctx.files.
//
// `symbols()` and `relationships()` on the service are NOT used: both return
// bare CodegraphNode[] without the file table, and RepositoryResultItem
// requires a path. query()'s RepositoryContext carries `files` (fileID -> path)
// so every item is grounded in a real graph row.

// Relations with a clean directional mapping in the RepositoryIntelligence
// interface. Anything else fails closed to DIRECT inside execute().
const SUPPORTED_RELATIONS: ReadonlySet<Relation> = new Set(["callers", "references", "dependents"])

const resolvedOperationName = (operation: RepositoryOperation): string =>
  operation.kind === "relationship" ? `relationship:${operation.relation}` : operation.kind

// Placeholder provenance: the backend is tool-agnostic (it only sees the
// operation), so originalTool here is a stand-in. The gateway overwrites the
// full provenance from the request + RouteDecision before returning the outcome.
const provenanceForOperation = (operation: RepositoryOperation): RepositoryResult["provenance"] => ({
  originalTool: "gateway",
  resolvedOperation: resolvedOperationName(operation),
  router: ROUTER_IDENTITY,
  routerVersion: ROUTER_VERSION,
})

// Fail-closed result: `route: "direct"` signals the gateway to fall through to
// the original tool. `operation`/`source` are carried for trace fidelity.
const directResult = (operation: RepositoryOperation): RepositoryResult => ({
  route: "direct",
  operation,
  source: "codegraph",
  results: [],
  provenance: provenanceForOperation(operation),
})

const intelligenceResult = (operation: RepositoryOperation, results: readonly RepositoryResultItem[]): RepositoryResult => ({
  route: "intelligence",
  operation,
  source: "codegraph",
  results,
  provenance: provenanceForOperation(operation),
})

// CodegraphNode -> RepositoryResultItem. Nodes whose fileID is not in the
// query's file bucket are DROPPED — there is no path to report and inventing
// one would be fabrication.
const itemFor = (node: CodegraphNode, pathByFileID: ReadonlyMap<string, string>): RepositoryResultItem[] => {
  const path = pathByFileID.get(node.fileID)
  if (path === undefined) return []
  return [{ path, line: node.startLine, name: node.name, kind: node.kind }]
}

const filePathMap = (files: readonly { readonly id: string; readonly path: string }[]): ReadonlyMap<string, string> =>
  new Map(files.map((file) => [file.id, file.path.replace(/\\/g, "/")] as const))

const runRelationship = (
  intel: RepositoryIntelligenceInterface,
  operation: Extract<RepositoryOperation, { readonly kind: "relationship" }>,
): Effect.Effect<RepositoryResult, never, never> =>
  Effect.gen(function* () {
    if (!SUPPORTED_RELATIONS.has(operation.relation)) return directResult(operation)
    const ctx = yield* intel.query({ query: operation.target })
    // Degraded graph (symbol-not-found): fail closed — the original grep/read
    // answers from the text index instead of an empty graph result.
    if (ctx.status === "failed") return directResult(operation)
    const pathByFileID = filePathMap(ctx.files)
    const slice = yield* intel.slice(ctx)
    const nodes =
      operation.relation === "dependents"
        ? [...slice.directCallers, ...slice.transitiveDependents]
        : slice.directCallers
    return intelligenceResult(operation, nodes.flatMap((node) => itemFor(node, pathByFileID)))
  })

const runSymbol = (
  intel: RepositoryIntelligenceInterface,
  operation: Extract<RepositoryOperation, { readonly kind: "symbol" }>,
): Effect.Effect<RepositoryResult, never, never> =>
  Effect.gen(function* () {
    const ctx = yield* intel.query({ query: operation.query })
    if (ctx.status === "failed") return directResult(operation)
    const pathByFileID = filePathMap(ctx.files)
    return intelligenceResult(operation, ctx.symbols.flatMap((node) => itemFor(node, pathByFileID)))
  })

const executeOperation = (
  intel: RepositoryIntelligenceInterface,
  operation: RepositoryOperation,
): Effect.Effect<RepositoryResult, never, never> =>
  Effect.gen(function* () {
    if (operation.kind === "symbol") return yield* runSymbol(intel, operation)
    if (operation.kind === "relationship") return yield* runRelationship(intel, operation)
    return directResult(operation)
  })

// The INTELLIGENCE backend wired into the gateway's BackendSelector. Declares
// support for every relationship op + symbol ops (the vocabulary the rules
// router emits); per-relation fail-closed happens inside execute().
export const intelligenceBackend: RepositoryBackend = {
  supports: (operation) => operation.kind === "symbol" || operation.kind === "relationship",
  execute: (operation) =>
    Effect.gen(function* () {
      const intelOpt = yield* Effect.serviceOption(RepositoryIntelligence)
      if (Option.isNone(intelOpt)) return directResult(operation)
      return yield* executeOperation(intelOpt.value, operation).pipe(
        Effect.catchCause(() => Effect.succeed(directResult(operation))),
      )
    }),
}
