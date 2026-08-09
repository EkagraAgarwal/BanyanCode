export * as SymbolResolver from "./symbol-resolver"

import { Context, Effect, Layer } from "effect"
import { CodegraphRepo } from "./codegraph-repo"
import type { Interface as CodegraphRepoInterface } from "./codegraph-repo"
import { isTestFilePath } from "./codegraph-paths"
import type { CodegraphNode } from "./types"

/**
 * Shared, ordered symbol-resolution strategy for every codegraph-aware tool.
 *
 *  Different tools used to ship their own weaker resolvers (some exact-name
 *  only, some substring only, some with a Context.Service tag fallback, some
 *  with a qualified-Namespace.leaf split). The result was that the same
 *  symbol could be resolved by `code_find intent=definition` but reported as
 *  "not found" by every other tool. `resolveGraphTarget` runs the strategies
 *  in a fixed priority order and returns the first non-empty candidate set
 *  together with a `derivation` tag so callers can explain why a match was
 *  chosen.
 */
export type ResolutionDerivation =
  | "tag-fallback"
  | "name-exact"
  | "qualified-split"
  | "code-substring"
  | "name-like"
  | "fts-bm25"

export interface ResolvedTarget {
  readonly nodeID: string
  readonly node: CodegraphNode
  readonly candidates: ReadonlyArray<CodegraphNode>
  readonly derivation: ResolutionDerivation
}

export interface ResolutionMiss {
  readonly target: string
  readonly tried: ReadonlyArray<ResolutionDerivation>
}

export type ResolutionResult =
  | { readonly _tag: "Ok"; readonly value: ResolvedTarget }
  | { readonly _tag: "Miss"; readonly value: ResolutionMiss }

export interface Interface {
  readonly resolveGraphTarget: (input: {
    target: string
    kind?: CodegraphNode["kind"]
    fileID?: string
    limit?: number
  }) => Effect.Effect<ResolutionResult, never, never>
}

export class Service extends Context.Service<Service, Interface>()("@banyancode/SymbolResolver") {}

/**
 * Pure resolver — no Effect/Layer deps — so the logic is unit-testable in
 * isolation and so callers that already have a `CodegraphRepo` reference can
 * use it without spinning up a separate service.
 */
export type ResolveRepo = Pick<
  CodegraphRepoInterface,
  | "findSymbolsByServiceTag"
  | "queryNodes"
  | "searchNodes"
  | "searchNodesLight"
  | "nodesByIDs"
  | "nodeByID"
  | "fileIDsByServiceName"
  | "filesByIDs"
>

export const resolveGraphTargetPure = (
  repo: ResolveRepo,
  input: {
    target: string
    kind?: CodegraphNode["kind"]
    fileID?: string
    limit?: number
  },
): Effect.Effect<ResolutionResult, never, never> => {
  return resolveGraphTargetStrict(repo, { ...input, allowKeywordFallback: true })
}

/**
 * Strict resolver that mirrors `resolveGraphTargetPure` but stops after step 3
 * (qualified-split). Used when the caller passes `includeKeywordFallback: false`
 * to `code_find` so the resolver returns "target-not-resolved" instead of
 * fuzzy substring matches. Sharing the step 1-3 implementation avoids drift
 * between the two strategies.
 */
export const resolveGraphTargetStrict = (
  repo: ResolveRepo,
  input: {
    target: string
    kind?: CodegraphNode["kind"]
    fileID?: string
    limit?: number
    allowKeywordFallback?: boolean
  },
): Effect.Effect<ResolutionResult, never, never> =>
  Effect.gen(function* () {
    const target = input.target.trim()
    if (!target) {
      return {
        _tag: "Miss" as const,
        value: { target, tried: [] as ResolutionDerivation[] },
      }
    }

    const tried: ResolutionDerivation[] = []
    const limit = input.limit ?? 25
    const allowKeywordFallback = input.allowKeywordFallback ?? false

    const filterByKind = (nodes: CodegraphNode[]): CodegraphNode[] =>
      input.kind ? nodes.filter((n) => n.kind === input.kind) : nodes
    const filterByFile = (nodes: CodegraphNode[]): CodegraphNode[] =>
      input.fileID ? nodes.filter((n) => n.fileID === input.fileID) : nodes

    const toResult = (nodes: CodegraphNode[], derivation: ResolutionDerivation): ResolutionResult => {
      const head = nodes[0]
      if (!head) {
        return { _tag: "Miss" as const, value: { target, tried } }
      }
      return {
        _tag: "Ok" as const,
        value: { nodeID: head.id, node: head, candidates: nodes, derivation },
      }
    }

    // Re-order tag-fallback candidates so non-test files rank ahead of test
    // doubles (P0 step 3). Test classes that happen to declare the same tag as
    // the source `Service` (e.g. `class MemoryRepo extends Context.Service<…>("…/MemoryRepo")`
    // in a `*.test.ts`) must not win canonical resolution when both match. We
    // batch-load the candidate files in one query so the test-path check is
    // local and doesn't repeat N path lookups.
    const reorderNonTestFirst = (
      nodes: readonly CodegraphNode[],
    ): Effect.Effect<CodegraphNode[], never, never> =>
      Effect.gen(function* () {
        if (nodes.length <= 1) return [...nodes]
        const fileIDs = [...new Set(nodes.map((n) => n.fileID))]
        const files = yield* repo.filesByIDs(fileIDs)
        const pathByID = new Map(files.map((f) => [f.id, f.path]))
        const isTestFile = (n: CodegraphNode): boolean => {
          const p = pathByID.get(n.fileID)
          return p ? isTestFilePath(p) : false
        }
        const nonTest = nodes.filter((n) => !isTestFile(n))
        const test = nodes.filter(isTestFile)
        return [...nonTest, ...test]
      })

    // 1) Context.Service tag lookup — covers BanyanCode's dominant pattern.
    const tagHitsRaw = filterByKind(filterByFile(yield* repo.findSymbolsByServiceTag(target)))
    const tagHits = dedupeByID(tagHitsRaw)
    tried.push("tag-fallback")
    if (tagHits.length > 0) {
      const ordered = yield* reorderNonTestFirst(tagHits)
      return toResult(ordered.slice(0, limit), "tag-fallback")
    }

    // 2) Exact name match (Drizzle `name = ?`).
    const exactHits = filterByKind(filterByFile(yield* repo.queryNodes({ function: target })))
    tried.push("name-exact")
    if (exactHits.length > 0) {
      return toResult(dedupeByID(exactHits).slice(0, limit), "name-exact")
    }

    // 3) Qualified split: `Namespace.method` → method + parent-file scoping.
    //    `parentName` can match either a node literally named that (most
    //    symbols) OR a file whose `codegraph_service_tags.service_name` equals
    //    `parentName` — the latter is how `extends Context.Service<…>("…/MemoryRepo")`
    //    indexed classes resolve under a `MemoryRepo.leaf` lookup despite the
    //    class node being `name: "Service"`.
    //    The computed `validFileIDs` is hoisted to the surrounding scope so
    //    step 4 can reuse it as a fallback scope when this step finds no
    //    exact `leaf` match — without that, a `Foo.put` lookup that misses
    //    here would fall through to step 4 unscoped and pick an arbitrary
    //    `put` across the whole graph.
    let parentFileIDs: ReadonlySet<string> | undefined
    if (target.includes(".")) {
      const parts = target.split(".")
      const leaf = parts[parts.length - 1] ?? ""
      const parentName = parts.slice(0, -1).join(".")
      if (leaf && parentName) {
        // Phase 2 (P5): bound the qualified-split scan to a light projection
        // (id/fileID/kind/name — the heavy `code` column is never selected).
        // Full rows are fetched via nodesByIDs only for the candidate file
        // scope that survives the filters.
        const lightNodes = yield* repo.searchNodesLight({ limit: 1000 })
        const validFileIDs = new Set(lightNodes.filter((n) => n.name === parentName).map((n) => n.fileID))
        for (const fileID of yield* repo.fileIDsByServiceName(parentName)) {
          validFileIDs.add(fileID)
        }
        // Rank non-test files first so test doubles of the same parent don't
        // widen the scope to bogus paths. Capture for step 4 reuse.
        const validFiles = yield* repo.filesByIDs([...validFileIDs])
        const pathByID = new Map(validFiles.map((f) => [f.id, f.path]))
        for (const id of [...validFileIDs]) {
          const p = pathByID.get(id)
          if (p && isTestFilePath(p)) validFileIDs.delete(id)
        }
        parentFileIDs = validFileIDs
        const splitHits = lightNodes.filter(
          (n) => n.name === leaf && validFileIDs.has(n.fileID) && (input.kind ? n.kind === input.kind : true),
        )
        tried.push("qualified-split")
        const filtered = input.fileID ? splitHits.filter((n) => n.fileID === input.fileID) : splitHits
        if (filtered.length > 0) {
          // Fetch the full rows (including `code`) for the matched candidate
          // scope, preserving the light-projection order so the head node is
          // deterministic across rebuilds.
          const fullByID = new Map((yield* repo.nodesByIDs(filtered.map((n) => n.id))).map((n) => [n.id, n]))
          const full = filtered.map((n) => fullByID.get(n.id) ?? n)
          return toResult(dedupeByID(full).slice(0, limit), "qualified-split")
        }
      }
    }

    if (!allowKeywordFallback) {
      return { _tag: "Miss" as const, value: { target, tried } }
    }

    // 4) Code-substring + last-segment fallback (mirrors code_find definition).
    //    When the target was qualified and step 3 computed a parent file scope,
    //    restrict code-substring hits to that scope AND allow name equality
    //    even for short leaves — a 3-char `put` inside the right file is not
    //    generic. Outside a scope, the original `isShortLeaf` gate stands so
    //    unscoped short targets like bare `put` still fail over to name-like
    //    rather than matching every `put` repo-wide.
    const lowerTarget = target.toLowerCase()
    const leaf = target.includes(".") ? target.split(".").pop()!.toLowerCase() : lowerTarget
    const scoped = parentFileIDs !== undefined && parentFileIDs.size > 0
    const isShortLeaf = leaf.length < 6
    const nameMatches = (n: CodegraphNode): boolean => {
      // Scoped lookups trust the leaf name even when short — the parent file
      // scope is the disambiguator. Unscoped lookups keep the gate.
      if (isShortLeaf && !scoped) return false
      return n.name.toLowerCase() === lowerTarget || n.name.toLowerCase() === leaf
    }
    // Phase 2 (P5): bound the code-substring fallback to a light projection
    // (never the heavy `code` column) and fetch full rows via nodesByIDs only
    // for the bounded candidate set that survives the non-code gates — mirrors
    // the `findTests` pattern in repository-intelligence/layer.ts: bounded
    // candidate filter first, then nodesByIDs for the rows that need `code`.
    // The code-OR (`n.code?.includes(lowerTarget)`) still runs against the
    // fetched set so code-only matches (e.g. `Effect.gen` inside a class body)
    // keep working within the bounded window.
    const lightNodes = yield* repo.searchNodesLight({ limit: 1000 })
    const gated = lightNodes.filter(
      (n) =>
        n.kind !== "file" &&
        (input.kind ? n.kind === input.kind : true) &&
        (!input.fileID || n.fileID === input.fileID) &&
        (scoped ? parentFileIDs!.has(n.fileID) : true),
    )
    const codeCandidates = gated.length > 0 ? yield* repo.nodesByIDs(gated.map((n) => n.id)) : []
    const codeHitsRaw = codeCandidates.filter(
      (n) => nameMatches(n) || n.code?.toLowerCase().includes(lowerTarget) === true,
    )
    const codeHits = sortBySpecificity(codeHitsRaw, lowerTarget)
    tried.push("code-substring")
    if (codeHits.length > 0) {
      return toResult(dedupeByID(codeHits).slice(0, limit), "code-substring")
    }

    // 5) Name LIKE — last resort.
    const likeHits = filterByKind(filterByFile(yield* repo.searchNodes({ name: target })))
    tried.push("name-like")
    if (likeHits.length > 0) {
      return toResult(dedupeByID(likeHits).slice(0, limit), "name-like")
    }

    return { _tag: "Miss" as const, value: { target, tried } }
  })

const dedupeByID = (nodes: CodegraphNode[]): CodegraphNode[] => {
  const seen = new Set<string>()
  const result: CodegraphNode[] = []
  for (const n of nodes) {
    if (seen.has(n.id)) continue
    seen.add(n.id)
    result.push(n)
  }
  return result
}

const KIND_RANK: Partial<Record<CodegraphNode["kind"], number>> = {
  class: 0,
  function: 1,
  method: 2,
  type: 3,
  variable: 5,
  route: 7,
  test: 8,
  file: 9,
  generated: 11,
}

const sortBySpecificity = (nodes: CodegraphNode[], lowerTarget: string): CodegraphNode[] => {
  const score = (n: CodegraphNode): number => {
    let s = (KIND_RANK[n.kind] ?? 99) * 10
    if (n.name.toLowerCase() === lowerTarget) s -= 100
    return s
  }
  // Final tiebreak: `node.id`. Without this, ties fall back to SQLite
  // row order which is non-deterministic across rebuilds (a wiped DB
  // returns rows in a different order than one built up over many
  // incremental updates). Two callers resolving the same
  // `MemoryRepo.update` symbol several minutes apart would otherwise be
  // free to pick different primary nodes.
  return nodes.slice().sort((a, b) => {
    const scoreDelta = score(a) - score(b)
    if (scoreDelta !== 0) return scoreDelta
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const repo = yield* CodegraphRepo.Service
    const resolveGraphTarget: Interface["resolveGraphTarget"] = (input) =>
      resolveGraphTargetPure(repo, input)
    return Service.of({ resolveGraphTarget })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(CodegraphRepo.defaultLayer))