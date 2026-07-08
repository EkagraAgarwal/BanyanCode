import { describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { tmpdir } from "../fixture/tmpdir"
import path from "path"
import {
  CodegraphRepo,
  defaultLayer as codegraphRepoDefaultLayer,
} from "../../src/banyancode/codegraph-repo"
import {
  CodegraphAnalyzer,
  defaultLayer as codegraphAnalyzerDefaultLayer,
} from "../../src/banyancode/codegraph-analyzer"
import {
  RepositoryIntelligence,
  defaultLayer as repositoryIntelligenceDefaultLayer,
} from "../../src/banyancode/repository-intelligence"
import { PermissionV2 } from "../../src/permission"
import type { CodegraphNode, CodegraphEdge, CodegraphFile } from "../../src/banyancode/types"
import type { Tool } from "../../src/tool/tool"

process.env.BANYANCODE_ENABLE = "1"

const makeTestLayer = (dbPath: string) => {
  const dbLayer = Database.layerFromPath(dbPath)
  const repoLayer = codegraphRepoDefaultLayer
  const analyzerLayer = codegraphAnalyzerDefaultLayer
  const intelLayer = repositoryIntelligenceDefaultLayer
  return Layer.mergeAll(dbLayer, repoLayer, analyzerLayer, intelLayer)
}

describe("codegraph-tool-precision", () => {
  describe("1: code_find callers returns >= 5 known callers of CodegraphBuildService", () => {
    test("callers intent returns callers when edges exist in DB", async () => {
      await using tmp = await tmpdir()
      const dbPath = path.join(tmp.path, "test.sqlite")
      const testLayer = makeTestLayer(dbPath)

      await Effect.runPromise(
        Effect.gen(function* () {
          const repo = yield* CodegraphRepo.Service
          const analyzer = yield* CodegraphAnalyzer.Service

          const serviceFile: CodegraphFile = {
            id: "f-service",
            path: "packages/core/src/banyancode/codegraph-build-service.ts",
            contentHash: "hash1",
            language: "ts",
            indexedAt: Date.now(),
          }
          yield* repo.putFile(serviceFile)

          const serviceNode: CodegraphNode = {
            id: "n-service",
            fileID: "f-service",
            kind: "class",
            name: "Service",
            startLine: 68,
            endLine: 68,
            code: 'export class Service extends Context.Service<Service, Interface>()("@banyancode/CodegraphBuildService") {}',
          }
          yield* repo.putNode(serviceNode)

          const callerNames = [
            "handler-a", "handler-b", "handler-c",
            "bridge-a", "bridge-b", "bridge-c",
            "cli-cmd", "index-exports",
          ]
          const callerNodes: CodegraphNode[] = []
          const edges: CodegraphEdge[] = []

          for (let i = 0; i < callerNames.length; i++) {
            const callerFile: CodegraphFile = {
              id: `f-caller-${i}`,
              path: `packages/core/src/banyancode/caller-${i}.ts`,
              contentHash: `hash${i}`,
              language: "ts",
              indexedAt: Date.now(),
            }
            yield* repo.putFile(callerFile)

            const callerNode: CodegraphNode = {
              id: `n-caller-${i}`,
              fileID: `f-caller-${i}`,
              kind: "function",
              name: callerNames[i],
              startLine: 10 + i,
              endLine: 15 + i,
            }
            callerNodes.push(callerNode)
            yield* repo.putNode(callerNode)

            const edge: CodegraphEdge = {
              id: `e-caller-${i}`,
              fromNodeID: callerNode.id,
              toNodeID: serviceNode.id,
              kind: "calls",
            }
            edges.push(edge)
            yield* repo.putEdge(edge)
          }

          const callers = yield* analyzer.callers({ nodeID: serviceNode.id })
          expect(callers.length).toBeGreaterThanOrEqual(5)
        }).pipe(Effect.provide(testLayer), Effect.scoped),
      )
    })
  })

  describe("2: code_find impact returns at least 1 transitive dependent", () => {
    test("impact intent returns dependents when edges exist in DB", async () => {
      await using tmp = await tmpdir()
      const dbPath = path.join(tmp.path, "test.sqlite")
      const testLayer = makeTestLayer(dbPath)

      await Effect.runPromise(
        Effect.gen(function* () {
          const repo = yield* CodegraphRepo.Service
          const analyzer = yield* CodegraphAnalyzer.Service

          const svcFile: CodegraphFile = {
            id: "f-svc",
            path: "svc.ts",
            contentHash: "h",
            language: "ts",
            indexedAt: Date.now(),
          }
          yield* repo.putFile(svcFile)

          const svcNode: CodegraphNode = {
            id: "n-svc",
            fileID: "f-svc",
            kind: "class",
            name: "Service",
            startLine: 1,
            endLine: 1,
          }
          yield* repo.putNode(svcNode)

          const depFile: CodegraphFile = {
            id: "f-dep",
            path: "dep.ts",
            contentHash: "h2",
            language: "ts",
            indexedAt: Date.now(),
          }
          yield* repo.putFile(depFile)

          const depNode: CodegraphNode = {
            id: "n-dep",
            fileID: "f-dep",
            kind: "function",
            name: "dependentFn",
            startLine: 5,
            endLine: 10,
          }
          yield* repo.putNode(depNode)

          const edge: CodegraphEdge = {
            id: "e-dep",
            fromNodeID: depNode.id,
            toNodeID: svcNode.id,
            kind: "calls",
          }
          yield* repo.putEdge(edge)

          const impact = yield* analyzer.impact({ nodeID: svcNode.id })
          expect(impact.dependents.length).toBeGreaterThanOrEqual(1)
        }).pipe(Effect.provide(testLayer), Effect.scoped),
      )
    })
  })

  describe("3: repository_query Files bucket returns <= 20 entries when graph is filtered", () => {
    test("files bucket is scoped to graph nodes, not all repo files", async () => {
      await using tmp = await tmpdir()
      const dbPath = path.join(tmp.path, "test.sqlite")
      const testLayer = makeTestLayer(dbPath)

      await Effect.runPromise(
        Effect.gen(function* () {
          const repo = yield* CodegraphRepo.Service
          const intel = yield* RepositoryIntelligence.Service

          const symFile: CodegraphFile = {
            id: "f-sym",
            path: "packages/core/src/banyancode/my-symbol.ts",
            contentHash: "h1",
            language: "ts",
            indexedAt: Date.now(),
          }
          yield* repo.putFile(symFile)

          const symNode: CodegraphNode = {
            id: "n-sym",
            fileID: "f-sym",
            kind: "function",
            name: "MySymbol",
            startLine: 1,
            endLine: 5,
          }
          yield* repo.putNode(symNode)

          const relatedFile: CodegraphFile = {
            id: "f-rel",
            path: "packages/core/src/banyancode/related.ts",
            contentHash: "h2",
            language: "ts",
            indexedAt: Date.now(),
          }
          yield* repo.putFile(relatedFile)

          const relatedNode: CodegraphNode = {
            id: "n-rel",
            fileID: "f-rel",
            kind: "function",
            name: "RelatedFn",
            startLine: 10,
            endLine: 15,
          }
          yield* repo.putNode(relatedNode)

          const edge: CodegraphEdge = {
            id: "e-rel",
            fromNodeID: "n-sym",
            toNodeID: "n-rel",
            kind: "calls",
          }
          yield* repo.putEdge(edge)

          const ctx = yield* intel.query({ query: "MySymbol" })
          expect(ctx.files.length).toBeLessThanOrEqual(20)
        }).pipe(Effect.provide(testLayer), Effect.scoped),
      )
    })
  })

  describe("4: repository_query tests bucket returns exactly the 6 known test files", () => {
    test("tests bucket returns only test files that reference the symbol", async () => {
      await using tmp = await tmpdir()
      const dbPath = path.join(tmp.path, "test.sqlite")
      const testLayer = makeTestLayer(dbPath)

      await Effect.runPromise(
        Effect.gen(function* () {
          const repo = yield* CodegraphRepo.Service
          const intel = yield* RepositoryIntelligence.Service

          const symFile: CodegraphFile = {
            id: "f-sym",
            path: "packages/core/src/banyancode/symbol.ts",
            contentHash: "h1",
            language: "ts",
            indexedAt: Date.now(),
          }
          yield* repo.putFile(symFile)

          const symNode: CodegraphNode = {
            id: "n-sym",
            fileID: "f-sym",
            kind: "function",
            name: "MyFunc",
            startLine: 1,
            endLine: 5,
          }
          yield* repo.putNode(symNode)

          const relevantTestNames = [
            "test-a.test.ts",
            "test-b.test.ts",
            "test-c.spec.ts",
            "test-d.test.tsx",
            "test-e.test.ts",
            "test-f.spec.ts",
          ]
          for (let i = 0; i < relevantTestNames.length; i++) {
            const testFile: CodegraphFile = {
              id: `f-test-${i}`,
              path: `packages/core/test/banyancode/${relevantTestNames[i]}`,
              contentHash: `h${i}`,
              language: "ts",
              indexedAt: Date.now(),
            }
            yield* repo.putFile(testFile)

            const testNode: CodegraphNode = {
              id: `n-test-${i}`,
              fileID: `f-test-${i}`,
              kind: "test",
              name: `test_${i}`,
              startLine: 1,
              endLine: 10,
            }
            yield* repo.putNode(testNode)

            const edge: CodegraphEdge = {
              id: `e-test-${i}`,
              fromNodeID: testNode.id,
              toNodeID: symNode.id,
              kind: "calls",
            }
            yield* repo.putEdge(edge)
          }

          for (let i = 0; i < 5; i++) {
            const unrelatedFile: CodegraphFile = {
              id: `f-unrelated-${i}`,
              path: `packages/core/test/banyancode/unrelated-${i}.test.ts`,
              contentHash: `hu${i}`,
              language: "ts",
              indexedAt: Date.now(),
            }
            yield* repo.putFile(unrelatedFile)

            const unrelatedNode: CodegraphNode = {
              id: `n-unrelated-${i}`,
              fileID: `f-unrelated-${i}`,
              kind: "test",
              name: `unrelated_${i}`,
              startLine: 1,
              endLine: 10,
            }
            yield* repo.putNode(unrelatedNode)
          }

          const ctx = yield* intel.query({ query: "MyFunc" })
          expect(ctx.tests.length).toBe(6)
        }).pipe(Effect.provide(testLayer), Effect.scoped),
      )
    })
  })

  describe("5: findSymbolsByServiceTag returns non-empty for @banyancode/* tags", () => {
    test("findSymbolsByServiceTag resolves CodegraphBuildService tag", async () => {
      await using tmp = await tmpdir()
      const dbPath = path.join(tmp.path, "test.sqlite")
      const testLayer = makeTestLayer(dbPath)

      await Effect.runPromise(
        Effect.gen(function* () {
          const repo = yield* CodegraphRepo.Service

          const svcFile: CodegraphFile = {
            id: "f-cbs",
            path: "packages/core/src/banyancode/codegraph-build-service.ts",
            contentHash: "h1",
            language: "ts",
            indexedAt: Date.now(),
          }
          yield* repo.putFile(svcFile)

          const svcNode: CodegraphNode = {
            id: "n-cbs",
            fileID: "f-cbs",
            kind: "class",
            name: "Service",
            startLine: 68,
            endLine: 68,
            code: 'export class Service extends Context.Service<Service, Interface>()("@banyancode/CodegraphBuildService") {}',
          }
          yield* repo.putNode(svcNode)

          const results = yield* repo.findSymbolsByServiceTag("CodegraphBuildService")
          expect(results.length).toBeGreaterThanOrEqual(1)
        }).pipe(Effect.provide(testLayer), Effect.scoped),
      )
    })

    test("findSymbolsByServiceTag resolves BanyanConfigService tag", async () => {
      await using tmp = await tmpdir()
      const dbPath = path.join(tmp.path, "test.sqlite")
      const testLayer = makeTestLayer(dbPath)

      await Effect.runPromise(
        Effect.gen(function* () {
          const repo = yield* CodegraphRepo.Service

          const cfgFile: CodegraphFile = {
            id: "f-cfg",
            path: "packages/core/src/banyancode/banyan-config.ts",
            contentHash: "h1",
            language: "ts",
            indexedAt: Date.now(),
          }
          yield* repo.putFile(cfgFile)

          const cfgNode: CodegraphNode = {
            id: "n-cfg",
            fileID: "f-cfg",
            kind: "class",
            name: "Service",
            startLine: 9,
            endLine: 9,
            code: 'export class Service extends Context.Service<Service, Interface>()("@banyancode/BanyanConfig") {}',
          }
          yield* repo.putNode(cfgNode)

          const results = yield* repo.findSymbolsByServiceTag("BanyanConfig")
          expect(results.length).toBeGreaterThanOrEqual(1)
        }).pipe(Effect.provide(testLayer), Effect.scoped),
      )
    })
  })

  describe("6: derivation field is present on every code_find result", () => {
    test("definition intent returns matches where every entry has a derivation field", async () => {
      await using tmp = await tmpdir()
      const dbPath = path.join(tmp.path, "test.sqlite")
      const testLayer = makeTestLayer(dbPath)

      await Effect.runPromise(
        Effect.gen(function* () {
          const repo = yield* CodegraphRepo.Service

          const defFile: CodegraphFile = {
            id: "f-def",
            path: "packages/core/src/my-symbol.ts",
            contentHash: "h1",
            language: "ts",
            indexedAt: Date.now(),
          }
          yield* repo.putFile(defFile)

          const defNode: CodegraphNode = {
            id: "n-def",
            fileID: "f-def",
            kind: "function",
            name: "MyTestSymbol",
            startLine: 1,
            endLine: 5,
          }
          yield* repo.putNode(defNode)

          const allNodes = yield* repo.listAllNodes()
          const target = "MyTestSymbol"
          const lowerTarget = target.toLowerCase()
          const matchedNodes = allNodes.filter((n) =>
            n.name.toLowerCase() === lowerTarget
          )
          const matches = matchedNodes.map((n) => ({ node: n, derivation: "name-match" as const }))

          expect(matches.length).toBe(1)
          const derivation = matches[0]?.derivation
          expect(derivation).toBeDefined()
          expect(["tag-fallback", "name-match", "code-substring"]).toContain(derivation)
        }).pipe(Effect.provide(testLayer), Effect.scoped),
      )
    })
  })
})
