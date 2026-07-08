import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import path from "path"
import { Database } from "@opencode-ai/core/database/database"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import { CodegraphRepo, defaultLayer as codegraphRepoDefaultLayer } from "../../src/banyancode/codegraph-repo"
import { CodegraphAnalyzer, defaultLayer as codegraphAnalyzerDefaultLayer } from "../../src/banyancode/codegraph-analyzer"
import { tmpdir } from "../fixture/tmpdir"
import type { CodegraphNode, CodegraphEdge, CodegraphFile } from "../../src/banyancode/types"

process.env.BANYANCODE_ENABLE = "1"

const normalizeOutput = (output: Record<string, unknown>) => {
  const normalized = JSON.parse(JSON.stringify(output))
  if (normalized.meta) {
    normalized.meta.graphBuiltAt = 0
    normalized.meta.graphVersion = 0
    normalized.meta.graphCoverage = 0
    normalized.meta.totalFiles = 0
    normalized.meta.totalNodes = 0
    normalized.meta.totalEdges = 0
  }
  for (const match of normalized.matches ?? []) {
    if (match.node?.id) match.node.id = "[NODE_ID]"
    if (match.node?.fileID) match.node.fileID = "[FILE_ID]"
  }
  return normalized
}

const seedDatabase = () =>
  Effect.gen(function* () {
    const repo = yield* CodegraphRepo.Service
    const now = Date.now()
    const files: CodegraphFile[] = [
      { id: "f-context-svc", path: "src/context-service.ts", contentHash: "h1", language: "typescript", indexedAt: now },
      { id: "f-banyan-config", path: "src/banyan-config.ts", contentHash: "h2", language: "typescript", indexedAt: now },
      { id: "f-permission", path: "src/permission/index.ts", contentHash: "h3", language: "typescript", indexedAt: now },
      { id: "f-codegraph-repo", path: "src/banyancode/codegraph-repo.ts", contentHash: "h4", language: "typescript", indexedAt: now },
      { id: "f-code-find", path: "src/tool/code-find.ts", contentHash: "h5", language: "typescript", indexedAt: now },
      { id: "f-route-handler", path: "src/server/routes/global.ts", contentHash: "h6", language: "typescript", indexedAt: now },
      { id: "f-event-handler", path: "src/banyancode/events.ts", contentHash: "h7", language: "typescript", indexedAt: now },
      { id: "f-caller-1", path: "src/caller-a.ts", contentHash: "h8", language: "typescript", indexedAt: now },
      { id: "f-caller-2", path: "src/caller-b.ts", contentHash: "h9", language: "typescript", indexedAt: now },
      { id: "f-caller-3", path: "src/caller-c.ts", contentHash: "h10", language: "typescript", indexedAt: now },
      { id: "f-transitive-1", path: "src/transitive-a.ts", contentHash: "h11", language: "typescript", indexedAt: now },
      { id: "f-transitive-2", path: "src/transitive-b.ts", contentHash: "h12", language: "typescript", indexedAt: now },
    ]

    for (const file of files) {
      yield* repo.putFile(file)
    }

    const nodes: CodegraphNode[] = [
      {
        id: "n-context-svc",
        fileID: "f-context-svc",
        kind: "class",
        name: "ContextService",
        signature: "class ContextService extends Context.Service<ContextService, Interface>()",
        startLine: 1,
        endLine: 20,
        code: 'export class ContextService extends Context.Service<ContextService, Interface>()("@test/ContextService") {}',
      },
      {
        id: "n-banyan-config",
        fileID: "f-banyan-config",
        kind: "class",
        name: "BanyanConfigService",
        signature: "class BanyanConfigService",
        startLine: 1,
        endLine: 50,
        code: "export class BanyanConfigService extends Context.Service<BanyanConfigService, Interface>()(\"@banyancode/BanyanConfig\") {}",
      },
      {
        id: "n-permission-svc",
        fileID: "f-permission",
        kind: "class",
        name: "PermissionV2",
        signature: "class PermissionV2",
        startLine: 1,
        endLine: 30,
        code: "class PermissionV2 extends Context.Service<PermissionV2, Interface>() {}",
      },
      {
        id: "n-bump-version",
        fileID: "f-codegraph-repo",
        kind: "function",
        name: "bumpVersion",
        signature: "bumpVersion(input: {...})",
        startLine: 576,
        endLine: 650,
        code: "const bumpVersion = Effect.fn(...)(function* (input: {...}) {...})",
      },
      {
        id: "n-resolve-target",
        fileID: "f-code-find",
        kind: "function",
        name: "resolveTarget",
        signature: "resolveTarget(repo, target)",
        startLine: 116,
        endLine: 134,
        code: "const resolveTarget = (repo, target) => Effect.gen(function* () { ... })",
      },
      {
        id: "n-get-meta",
        fileID: "f-codegraph-repo",
        kind: "method",
        name: "getMeta",
        signature: "getMeta()",
        startLine: 496,
        endLine: 514,
        code: "const getMeta = Effect.fn(...)(function* () { ... })",
      },
      {
        id: "n-clear-parse-errors",
        fileID: "f-codegraph-repo",
        kind: "method",
        name: "clearParseErrors",
        signature: "clearParseErrors()",
        startLine: 671,
        endLine: 673,
        code: "const clearParseErrors = Effect.fn(...)(function* () { ... })",
      },
      {
        id: "n-codegraph-build-route",
        fileID: "f-route-handler",
        kind: "route",
        name: "/global/codegraph-build",
        signature: "HttpApiEndpoint.post(...)",
        startLine: 1,
        endLine: 20,
        code: "HttpApiEndpoint.post('codegraphBuild', '/global/codegraph-build', {...})",
      },
      {
        id: "n-event-handler",
        fileID: "f-event-handler",
        kind: "function",
        name: "banyancode.codegraph.build",
        signature: "EventV2.on('banyancode.codegraph.build', handler)",
        startLine: 1,
        endLine: 30,
        code: "export const onCodegraphBuild = (handler) => EventV2.on('banyancode.codegraph.build', handler)",
      },
      {
        id: "n-permission-ask",
        fileID: "f-permission",
        kind: "function",
        name: "Permission.ask",
        signature: "ask(input: {...})",
        startLine: 40,
        endLine: 60,
        code: "const ask = (input) => Effect.gen(function* () { const session = yield* ... })",
      },
      {
        id: "n-caller-a",
        fileID: "f-caller-1",
        kind: "function",
        name: "callerA",
        signature: "callerA()",
        startLine: 1,
        endLine: 10,
      },
      {
        id: "n-caller-b",
        fileID: "f-caller-2",
        kind: "function",
        name: "callerB",
        signature: "callerB()",
        startLine: 1,
        endLine: 10,
      },
      {
        id: "n-caller-c",
        fileID: "f-caller-3",
        kind: "function",
        name: "callerC",
        signature: "callerC()",
        startLine: 1,
        endLine: 10,
      },
      {
        id: "n-transitive-a",
        fileID: "f-transitive-1",
        kind: "function",
        name: "transitiveA",
        signature: "transitiveA()",
        startLine: 1,
        endLine: 10,
      },
      {
        id: "n-transitive-b",
        fileID: "f-transitive-2",
        kind: "function",
        name: "transitiveB",
        signature: "transitiveB()",
        startLine: 1,
        endLine: 10,
      },
    ]

    for (const node of nodes) {
      yield* repo.putNode(node)
    }

    const edges: CodegraphEdge[] = [
      { id: "e-ca-ncs", fromNodeID: "n-caller-a", toNodeID: "n-context-svc", kind: "calls" },
      { id: "e-cb-ncs", fromNodeID: "n-caller-b", toNodeID: "n-context-svc", kind: "calls" },
      { id: "e-cc-ncs", fromNodeID: "n-caller-c", toNodeID: "n-context-svc", kind: "calls" },
      { id: "e-ta-ncs", fromNodeID: "n-transitive-a", toNodeID: "n-caller-a", kind: "calls" },
      { id: "e-tb-ncs", fromNodeID: "n-transitive-b", toNodeID: "n-caller-b", kind: "calls" },
    ]

    for (const edge of edges) {
      yield* repo.putEdge(edge)
    }

    yield* repo.setMeta({
      id: "singleton",
      graphBuiltAt: now,
      graphVersion: 1,
      graphCoverage: 1.0,
      totalFiles: files.length,
      totalNodes: nodes.length,
      totalEdges: edges.length,
      schemaVersion: 1,
    })
  })

interface TestSymbol {
  name: string
  target: string
  category: string
}

const TEST_SYMBOLS: TestSymbol[] = [
  { name: "ContextService", target: "ContextService", category: "class with Context.Service tag" },
  { name: "BanyanConfigService", target: "BanyanConfigService", category: "namespace re-export class" },
  { name: "PermissionV2", target: "PermissionV2", category: "plain class" },
  { name: "bumpVersion", target: "bumpVersion", category: "exported function" },
  { name: "resolveTarget", target: "resolveTarget", category: "function with yield* calls" },
  { name: "getMeta", target: "getMeta", category: "instance method" },
  { name: "clearParseErrors", target: "clearParseErrors", category: "static method" },
  { name: "/global/codegraph-build", target: "/global/codegraph-build", category: "route (HttpApiEndpoint)" },
  { name: "banyancode.codegraph.build", target: "banyancode.codegraph.build", category: "event handler (EventV2)" },
  { name: "Permission.ask", target: "Permission.ask", category: "function with Effect.gen" },
]

const INTENTS = ["definition", "callers", "dependents", "impact"] as const

describe("codegraph-tool-golden", () => {
  for (const symbol of TEST_SYMBOLS) {
    describe(`${symbol.name} (${symbol.category})`, () => {
      for (const intent of INTENTS) {
        test(`intent=${intent}`, async () => {
          await using tmp = await tmpdir()
          const dbPath = path.join(tmp.path, "test.db")
          const dbLayer = Database.layerFromPath(dbPath)

          const testLayer = Layer.mergeAll(
            codegraphRepoDefaultLayer,
            codegraphAnalyzerDefaultLayer,
          )

          const result = await Effect.runPromise(
            Effect.gen(function* () {
              const { db } = yield* Database.Service
              yield* DatabaseMigration.apply(db)

              const repo = yield* CodegraphRepo.Service
              const analyzer = yield* CodegraphAnalyzer.Service

              yield* seedDatabase()

              const metaRow = yield* repo.getMeta()
              const meta = metaRow
                ? {
                    graphBuiltAt: metaRow.graphBuiltAt,
                    graphVersion: metaRow.graphVersion,
                    graphCoverage: metaRow.graphCoverage,
                    totalFiles: metaRow.totalFiles,
                    totalNodes: metaRow.totalNodes,
                    totalEdges: metaRow.totalEdges,
                  }
                : undefined

              const resolveTarget = (target: string) =>
                Effect.gen(function* () {
                  const tagHits = yield* repo.findSymbolsByServiceTag(target)
                  if (tagHits.length > 0) {
                    return { nodeID: tagHits[0]!.id, derivation: "tag-fallback" as const }
                  }
                  const byName = yield* repo.queryNodes({ function: target })
                  if (byName.length > 0) {
                    return { nodeID: byName[0]!.id, derivation: "name-match" as const }
                  }
                  const byCode = yield* repo.searchNodes({ name: target })
                  if (byCode.length > 0) {
                    return { nodeID: byCode[0]!.id, derivation: "code-substring" as const }
                  }
                  return null
                })

              let output: Record<string, unknown>

              switch (intent) {
                case "definition": {
                  const target = symbol.target
                  const allNodes = yield* repo.listAllNodes()
                  const lowerTarget = target.toLowerCase()
                  const matchedNodes = allNodes.filter((n: CodegraphNode) =>
                    n.name.toLowerCase() === lowerTarget || (n.code?.toLowerCase().includes(lowerTarget) ?? false)
                  ).slice(0, 50)
                  const matches = matchedNodes.map((n: CodegraphNode) => ({ node: n, derivation: "name-match" as const }))
                  output = { matches, files: [], meta, intent, dispatchedTo: "codegraph_query" }
                  break
                }
                case "callers": {
                  if (!symbol.target) {
                    output = { matches: [], files: [], meta, intent, dispatchedTo: "codegraph_callers", _diagnostic: "empty-target" as const }
                  } else {
                    const resolved = yield* resolveTarget(symbol.target)
                    if (!resolved) {
                      output = { matches: [], files: [], meta, intent, dispatchedTo: "codegraph_callers", _diagnostic: "symbol-not-in-graph" as const }
                    } else {
                      const result = yield* analyzer.callers({ nodeID: resolved.nodeID }).pipe(
                        Effect.matchEffect({
                          onFailure: (err: { _tag: string }) => err._tag === "Banyan/SymbolNotFoundError"
                            ? Effect.succeed<CodegraphNode[]>([])
                            : Effect.fail(err),
                          onSuccess: (nodes: CodegraphNode[]) => Effect.succeed(nodes),
                        }),
                      )
                      const matches = result.map((n: CodegraphNode) => ({ node: n, derivation: resolved.derivation }))
                      const isEmpty = matches.length === 0
                      output = {
                        matches,
                        files: [],
                        meta,
                        intent,
                        dispatchedTo: "codegraph_callers",
                        ...(isEmpty ? { _diagnostic: "symbol-not-in-graph" as const } : {}),
                      }
                    }
                  }
                  break
                }
                case "dependents": {
                  if (!symbol.target) {
                    output = { matches: [], files: [], meta, intent, dispatchedTo: "codegraph_dependents", _diagnostic: "empty-target" as const }
                  } else {
                    const resolved = yield* resolveTarget(symbol.target)
                    if (!resolved) {
                      output = { matches: [], files: [], meta, intent, dispatchedTo: "codegraph_dependents", _diagnostic: "symbol-not-in-graph" as const }
                    } else {
                      const result = yield* analyzer.dependents({ nodeID: resolved.nodeID }).pipe(
                        Effect.matchEffect({
                          onFailure: (err: { _tag: string }) => err._tag === "Banyan/SymbolNotFoundError"
                            ? Effect.succeed<CodegraphNode[]>([])
                            : Effect.fail(err),
                          onSuccess: (nodes: CodegraphNode[]) => Effect.succeed(nodes),
                        }),
                      )
                      const matches = result.map((n: CodegraphNode) => ({ node: n, derivation: resolved.derivation }))
                      const isEmpty = matches.length === 0
                      output = {
                        matches,
                        files: [],
                        meta,
                        intent,
                        dispatchedTo: "codegraph_dependents",
                        ...(isEmpty ? { _diagnostic: "symbol-not-in-graph" as const } : {}),
                      }
                    }
                  }
                  break
                }
                case "impact": {
                  if (!symbol.target) {
                    output = { matches: [], files: [], meta, intent, dispatchedTo: "codegraph_impact", _diagnostic: "empty-target" as const }
                  } else {
                    const resolved = yield* resolveTarget(symbol.target)
                    if (!resolved) {
                      output = { matches: [], files: [], meta, intent, dispatchedTo: "codegraph_impact", _diagnostic: "symbol-not-in-graph" as const }
                    } else {
                      const result = yield* analyzer.impact({ nodeID: resolved.nodeID }).pipe(
                        Effect.matchEffect({
                          onFailure: (err: { _tag: string }) => err._tag === "Banyan/SymbolNotFoundError"
                            ? Effect.succeed<{ dependents: CodegraphNode[]; transitive: CodegraphNode[] }>({ dependents: [], transitive: [] })
                            : Effect.fail(err),
                          onSuccess: (impact: { dependents: CodegraphNode[]; transitive: CodegraphNode[] }) => Effect.succeed(impact),
                        }),
                      )
                      const matches = [
                        ...result.dependents.map((n: CodegraphNode) => ({ node: n, derivation: resolved.derivation })),
                        ...result.transitive.map((n: CodegraphNode) => ({ node: n, derivation: resolved.derivation })),
                      ].slice(0, 50)
                      const isEmpty = matches.length === 0
                      output = {
                        matches,
                        files: [],
                        meta,
                        intent,
                        dispatchedTo: "codegraph_impact",
                        ...(isEmpty ? { _diagnostic: "symbol-not-in-graph" as const } : {}),
                      }
                    }
                  }
                  break
                }
                default:
                  output = { matches: [], files: [], meta, intent, dispatchedTo: "unknown" }
              }

              return normalizeOutput(output)
            }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
          )

          expect(result).toMatchSnapshot()
        })
      }
    })
  }
})
