export * as SymbolResolver from "./symbol-resolver"

import { Context, Effect, Layer } from "effect"
import { CodegraphRepo } from "./codegraph-repo"
import type { Interface as CodegraphRepoInterface } from "./codegraph-repo"
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
  "findSymbolsByServiceTag" | "queryNodes" | "searchNodes" | "listAllNodes" | "nodeByID"
>

export const resolveGraphTargetPure = (
  repo: ResolveRepo,
  input: {
    target: string
    kind?: CodegraphNode["kind"]
    fileID?: string
    limit?: number
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

    // 1) Context.Service tag lookup — covers BanyanCode's dominant pattern.
    const tagHits = filterByKind(filterByFile(yield* repo.findSymbolsByServiceTag(target)))
    tried.push("tag-fallback")
    if (tagHits.length > 0) {
      const dedup = dedupeByID(tagHits)
      return toResult(dedup.slice(0, limit), "tag-fallback")
    }

    // 2) Exact name match (Drizzle `name = ?`).
    const exactHits = filterByKind(filterByFile(yield* repo.queryNodes({ function: target })))
    tried.push("name-exact")
    if (exactHits.length > 0) {
      return toResult(dedupeByID(exactHits).slice(0, limit), "name-exact")
    }

    // 3) Qualified split: `Namespace.method` → method + parent-file scoping.
    if (target.includes(".")) {
      const parts = target.split(".")
      const leaf = parts[parts.length - 1] ?? ""
      const parentName = parts.slice(0, -1).join(".")
      if (leaf && parentName) {
        const allNodes = yield* repo.listAllNodes()
        const validFileIDs = new Set(allNodes.filter((n) => n.name === parentName).map((n) => n.fileID))
        const splitHits = allNodes.filter(
          (n) => n.name === leaf && validFileIDs.has(n.fileID) && (input.kind ? n.kind === input.kind : true),
        )
        tried.push("qualified-split")
        const filtered = input.fileID ? splitHits.filter((n) => n.fileID === input.fileID) : splitHits
        if (filtered.length > 0) {
          return toResult(dedupeByID(filtered).slice(0, limit), "qualified-split")
        }
      }
    }

    // 4) Code-substring + last-segment fallback (mirrors code_find definition).
    //    Code-substring uses the FULL lowerTarget (e.g. "Effect.gen"), which is
    //    safe even for short leaves because it's specific enough not to
    //    false-positive on unrelated source. Name-based matching is still gated
    //    by isShortLeaf since short names like "gen" are too generic.
    const lowerTarget = target.toLowerCase()
    const leaf = target.includes(".") ? target.split(".").pop()!.toLowerCase() : lowerTarget
    const isShortLeaf = leaf.length < 6
    const allNodes = yield* repo.listAllNodes()
    const nameMatches = (n: CodegraphNode): boolean => {
      if (isShortLeaf) return false
      return n.name.toLowerCase() === lowerTarget || n.name.toLowerCase() === leaf
    }
    const codeHitsRaw = allNodes.filter(
      (n) =>
        n.kind !== "file" &&
        (input.kind ? n.kind === input.kind : true) &&
        (!input.fileID || n.fileID === input.fileID) &&
        (nameMatches(n) || n.code?.toLowerCase().includes(lowerTarget) === true),
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
  return nodes.slice().sort((a, b) => score(a) - score(b))
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