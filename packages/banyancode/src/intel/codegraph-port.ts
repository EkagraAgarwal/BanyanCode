import { Effect } from "effect"
import type { EdgeKind, GraphEdge, GraphFile, GraphMeta, GraphNode, NodeKind } from "./types.js"

/**
 * Read-only view of the code graph, owned by the codegraph workstream (`3a`).
 *
 * Workstream `3c` must not import `src/codegraph` internals. This interface is
 * the seam: the lead binds it to the real codegraph service later, and tests
 * bind it to an in-memory fixture of real node/edge rows.
 *
 * Contract:
 * - every method resolves with an empty value instead of failing; a missing
 *   graph is "no rows", not an error (`meta()` returns `undefined`).
 * - `searchByName` is a case-insensitive substring/LIKE lookup, bounded by
 *   `limit` (default 50). Callers re-filter for exactness.
 * - `searchFullText`, `listNodes`, `findByServiceTag`, `fileIDsByServiceName`
 *   and `dependentFiles` are optional so a partial adapter still works; the
 *   resolution/BFS pipeline degrades to the cheaper strategies when absent.
 * - node/edge/file row shapes match the v1 codegraph tables exactly, so a
 *   DB-backed adapter is a projection, not a translation layer.
 */

export interface SearchByNameInput {
  readonly name: string
  readonly limit?: number
  readonly fileID?: string
}

export interface ListNodesInput {
  readonly limit?: number
  readonly kind?: NodeKind
}

export interface DependentFilesInput {
  readonly fileIDs: readonly string[]
  readonly limit?: number
}

export interface CodegraphPort {
  readonly meta: () => Effect.Effect<GraphMeta | undefined>
  readonly listFiles: () => Effect.Effect<readonly GraphFile[]>
  readonly getFileByPath: (path: string) => Effect.Effect<GraphFile | undefined>
  readonly fileByID: (id: string) => Effect.Effect<GraphFile | undefined>
  readonly nodesByFile: (fileID: string) => Effect.Effect<readonly GraphNode[]>
  readonly nodesByIDs: (ids: readonly string[]) => Effect.Effect<readonly GraphNode[]>
  readonly nodeByID: (id: string) => Effect.Effect<GraphNode | undefined>
  /** Outgoing edges for a frontier (batched: one call per breadth level). */
  readonly edgesFrom: (nodeIDs: readonly string[]) => Effect.Effect<readonly GraphEdge[]>
  /** Incoming edges for a frontier (batched: one call per breadth level). */
  readonly edgesTo: (nodeIDs: readonly string[]) => Effect.Effect<readonly GraphEdge[]>
  readonly searchByName: (input: SearchByNameInput) => Effect.Effect<readonly GraphNode[]>
  /**
   * Exact `name = ?` lookup. Optional because `searchByName` can serve the
   * same contract, but a DB adapter should provide it: substring search with
   * a LIMIT can miss the exact row for common names like `update`.
   */
  readonly findByExactName?: (input: SearchByNameInput) => Effect.Effect<readonly GraphNode[]>
  /** FTS5 bm25 search over name/signature/code. Absent when the graph has no FTS table. */
  readonly searchFullText?: (input: { readonly query: string; readonly limit?: number }) => Effect.Effect<readonly GraphNode[]>
  /** Light projection (no `code` column) of indexed nodes. Needed for test discovery. */
  readonly listNodes?: (input?: ListNodesInput) => Effect.Effect<readonly GraphNode[]>
  /** `codegraph_service_tags` lookup (`Context.Service` tags). */
  readonly findByServiceTag?: (tag: string) => Effect.Effect<readonly GraphNode[]>
  /** Files whose service-tag row has `service_name = name`. */
  readonly fileIDsByServiceName?: (name: string) => Effect.Effect<readonly string[]>
  /** Distinct file ids of nodes with incoming edges into `fileIDs`. */
  readonly dependentFiles?: (input: DependentFilesInput) => Effect.Effect<readonly string[]>
}

export type { EdgeKind, GraphEdge, GraphFile, GraphMeta, GraphNode, NodeKind }
