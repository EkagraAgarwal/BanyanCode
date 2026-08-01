import { Context, Effect, Layer } from "effect"
import path from "path"
import { CodegraphRepo } from "./codegraph-repo"
import type { CodegraphNode } from "./types"

export interface PackageOverview {
  readonly path: string
  readonly files: number
  readonly nodes: number
}

export interface EntryPoint {
  readonly name: string
  readonly kind: string
  readonly path: string
  readonly startLine: number
  readonly endLine: number
  readonly signature?: string
}

export interface OverviewResult {
  readonly packages: ReadonlyArray<PackageOverview>
  readonly entryPoints: ReadonlyArray<EntryPoint>
  readonly fileKindCounts: Readonly<Record<string, number>>
  readonly totalNodes: number
  readonly graphVersion: number
}

export interface DetailResult {
  readonly path: string
  readonly symbols: ReadonlyArray<{
    readonly name: string
    readonly kind: string
    readonly startLine: number
    readonly endLine: number
    readonly signature?: string
  }>
}

export interface SearchResult {
  readonly id: string
  readonly name: string
  readonly kind: string
  readonly path: string
  readonly startLine: number
  readonly endLine: number
  readonly signature?: string
  readonly relevance: number
}

export interface Interface {
  readonly overview: (input: { root: string; limit?: number }) => Effect.Effect<OverviewResult, never, never>
  readonly detail: (input: { root: string; path: string }) => Effect.Effect<DetailResult, never, never>
  readonly search: (input: { root: string; query: string; limit?: number }) => Effect.Effect<ReadonlyArray<SearchResult>, never, never>
}

export class Service extends Context.Service<Service, Interface>()("@banyancode/RepoMapService") {}

const normalize = (value: string) => value.replaceAll("\\", "/").replace(/^\.\//, "")

const packagePath = (filePath: string) => {
  const parts = normalize(filePath).split("/")
  if (parts[0] === "packages" && parts.length > 1) return `packages/${parts[1]}`
  if (parts[0] === "apps" && parts.length > 1) return `apps/${parts[1]}`
  return parts.length > 1 ? parts[0] : "."
}

const fileKind = (filePath: string, language: string) => {
  const name = path.posix.basename(normalize(filePath)).toLowerCase()
  if (/\.(test|spec)\.[^.]+$/.test(name) || name.includes("__tests__")) return "test"
  if (/\.(md|mdx|txt|rst)$/.test(name) || language === "markdown") return "documentation"
  if (/^(package|tsconfig|bunfig|biome|eslint|vite|vitest|jest|docker|compose)/.test(name) || /\.(json|ya?ml|toml)$/.test(name)) return "config"
  if (/^(index|main|mod|app|server|cli)\.[^.]+$/.test(name)) return "entrypoint"
  return language || path.posix.extname(name).slice(1) || "other"
}

const toEntryPoint = (node: CodegraphNode, filePath: string): EntryPoint => ({
  name: node.name,
  kind: node.kind,
  path: filePath,
  startLine: node.startLine,
  endLine: node.endLine,
  ...(node.signature === undefined ? {} : { signature: node.signature }),
})

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const repo = yield* CodegraphRepo.Service

    return Service.of({
      overview: Effect.fn("RepoMapService.overview")(function* (input: { root: string; limit?: number }) {
        const limit = Math.max(1, Math.min(input.limit ?? 50, 500))
        const files = yield* repo.listAllFiles()
        const nodes = yield* repo.listAllNodes()
        const filesByID = new Map(files.map((file) => [file.id, file] as const))
        const packageCounts = new Map<string, { files: Set<string>; nodes: number }>()
        const fileKindCounts: Record<string, number> = {}

        files.forEach((file) => {
          const kind = fileKind(file.path, file.language)
          fileKindCounts[kind] = (fileKindCounts[kind] ?? 0) + 1
          const key = packagePath(file.path)
          const current = packageCounts.get(key) ?? { files: new Set<string>(), nodes: 0 }
          current.files.add(file.id)
          packageCounts.set(key, current)
        })
        nodes.forEach((node) => {
          const file = filesByID.get(node.fileID)
          if (!file) return
          const key = packagePath(file.path)
          const current = packageCounts.get(key) ?? { files: new Set<string>(), nodes: 0 }
          current.nodes += 1
          packageCounts.set(key, current)
        })

        const packages: PackageOverview[] = [...packageCounts.entries()]
          .map(([packageName, counts]) => ({ path: packageName, files: counts.files.size, nodes: counts.nodes }))
          .sort((a, b) => b.nodes - a.nodes || a.path.localeCompare(b.path))
          .slice(0, limit)
        const entryPoints: EntryPoint[] = nodes
          .filter((node) => {
            if (node.isEntrypoint) return true
            const file = filesByID.get(node.fileID)
            if (!file) return false
            return fileKind(file.path, file.language) === "entrypoint"
          })
          .sort((a, b) => (b.inDegree ?? 0) - (a.inDegree ?? 0) || a.name.localeCompare(b.name))
          .flatMap((node) => {
            const file = filesByID.get(node.fileID)
            return file ? [toEntryPoint(node, file.path)] : []
          })
          .slice(0, limit)
        const meta = yield* repo.getMeta()

        return {
          packages,
          entryPoints,
          fileKindCounts,
          totalNodes: nodes.length,
          graphVersion: meta?.graphVersion ?? 0,
        }
      }),
      detail: Effect.fn("RepoMapService.detail")(function* (input: { root: string; path: string }) {
        const root = normalize(path.resolve(input.root))
        const requested = normalize(path.isAbsolute(input.path) ? path.resolve(input.path) : input.path)
        const relative = path.isAbsolute(input.path) ? normalize(path.relative(root, requested)) : requested
        if (relative.startsWith("../") || relative === "..") return { path: relative, symbols: [] }
        const file = yield* repo.getFileByPath(relative)
        if (!file) return { path: relative, symbols: [] }
        const nodes = yield* repo.listNodesByFile(file.id)
        return {
          path: file.path,
          symbols: nodes
            .sort((a, b) => a.startLine - b.startLine || a.name.localeCompare(b.name))
            .map((node) => ({
              name: node.name,
              kind: node.kind,
              startLine: node.startLine,
              endLine: node.endLine,
              ...(node.signature === undefined ? {} : { signature: node.signature }),
            })),
        }
      }),
      search: Effect.fn("RepoMapService.search")(function* (input: { root: string; query: string; limit?: number }) {
        const hits = yield* repo.ftsSearchNodes({ query: input.query, limit: Math.max(1, Math.min(input.limit ?? 25, 100)) })
        const files = yield* repo.filesByIDs([...new Set(hits.map((hit) => hit.fileID))])
        const filesByID = new Map(files.map((file) => [file.id, file.path] as const))
        return hits.flatMap((hit) => {
          const filePath = filesByID.get(hit.fileID)
          if (!filePath) return []
          return [{
            id: hit.id,
            name: hit.name,
            kind: hit.kind,
            path: filePath,
            startLine: hit.startLine,
            endLine: hit.endLine,
            ...(hit.signature === undefined ? {} : { signature: hit.signature }),
            relevance: Math.max(0, -hit.bm25),
          }]
        })
      }),
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(CodegraphRepo.defaultLayer))

export * as RepoMapService from "./repo-map-service"
