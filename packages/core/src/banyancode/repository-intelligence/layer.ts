import { Effect, Layer } from "effect"
import { CodegraphRepo } from "../codegraph-repo"
import { Service } from "./service"
import type { Interface } from "./service"
import type { CodegraphNode } from "../types"

export type { Interface }
export { Service }

const KIND_PRIORITY: CodegraphNode["kind"][] = [
  "class",
  "function",
  "method",
  "type",
  "variable",
  "file",
]

function kindRank(kind: CodegraphNode["kind"]): number {
  const idx = KIND_PRIORITY.indexOf(kind)
  return idx === -1 ? Infinity : idx
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const repo = yield* CodegraphRepo.Service

    // ------------------------------------------------------------------
    // findSymbol
    // ------------------------------------------------------------------
    const findSymbol = (input: {
      name: string
      kind?: CodegraphNode["kind"]
      file?: string
      exact?: boolean
    }): Effect.Effect<CodegraphNode[], never, never> =>
      Effect.gen(function* () {
        let fileID: string | undefined
        if (input.file) {
          const file = yield* repo.getFileByPath(input.file)
          fileID = file?.id
          if (!fileID) return []
        }

        const results = yield* repo.searchNodes({ name: input.name, kind: input.kind })
        const filtered = fileID ? results.filter((n) => n.fileID === fileID) : results

        if (input.exact) return filtered

        const exactMatch = filtered.find((n) => n.name === input.name)
        if (exactMatch) return filtered

        const all = yield* repo.listAllNodes()
        const prefixResults = all.filter((n) => n.name.startsWith(input.name))
        const prefixFiltered = fileID ? prefixResults.filter((n) => n.fileID === fileID) : prefixResults
        if (input.kind) return prefixFiltered.filter((n) => n.kind === input.kind)
        return prefixFiltered
      })

    // ------------------------------------------------------------------
    // findSubsystem
    // ------------------------------------------------------------------
    const findSubsystem = (input: {
      query: string
      maxDepth?: number
    }): Effect.Effect<{ entry: CodegraphNode; related: CodegraphNode[] }, never, never> =>
      Effect.gen(function* () {
        const candidates = yield* repo.searchNodes({ name: input.query, limit: 20 })
        const sorted = candidates.slice().sort((a, b) => kindRank(a.kind) - kindRank(b.kind))

        let entry: CodegraphNode | undefined
        if (sorted.length > 0) {
          entry = sorted[0]
        }

        if (!entry) {
          const all = yield* repo.listAllNodes()
          const matching = all.filter((n) => n.name.toLowerCase().includes(input.query.toLowerCase()))
          if (matching.length > 0) {
            entry = matching.slice().sort((a, b) => kindRank(a.kind) - kindRank(b.kind))[0]
          }
        }

        if (!entry) {
          const dummyEntry: CodegraphNode = {
            id: "",
            fileID: "",
            kind: "function",
            name: `no-match:${input.query}`,
            startLine: 0,
            endLine: 0,
          }
          return { entry: dummyEntry, related: [] }
        }

        const related = yield* walkSubsystem(entry.id, input.maxDepth ?? 3)
        return { entry, related }
      })

    const walkSubsystem = (nodeID: string, maxDepth: number): Effect.Effect<CodegraphNode[], never, never> =>
      Effect.gen(function* () {
        const visited = new Set<string>([nodeID])
        const result: CodegraphNode[] = []
        const queue: Array<{ id: string; depth: number }> = [{ id: nodeID, depth: 0 }]

        while (queue.length > 0) {
          const current = queue.shift()!
          if (current.depth >= maxDepth) continue

          const outgoing = yield* repo.edgesFrom(current.id)
          const incoming = yield* repo.edgesTo(current.id)

          const nextIDs: string[] = []
          for (const edge of [...outgoing, ...incoming]) {
            const nextID = edge.fromNodeID === current.id ? edge.toNodeID : edge.fromNodeID
            if (!visited.has(nextID)) {
              visited.add(nextID)
              nextIDs.push(nextID)
            }
          }

          if (nextIDs.length > 0) {
            const nodes = yield* repo.nodesByIDs(nextIDs)
            result.push(...nodes)
            for (const id of nextIDs) {
              queue.push({ id, depth: current.depth + 1 })
            }
          }
        }

        return result
      })

    // ------------------------------------------------------------------
    // findEntrypoints
    // ------------------------------------------------------------------
    const findEntrypoints = (input: {
      feature: string
    }): Effect.Effect<CodegraphNode[], never, never> =>
      Effect.gen(function* () {
        const allFiles = yield* repo.listAllFiles()
        const featureLower = input.feature.toLowerCase()

        const matchingFiles = allFiles.filter((f) => f.path.toLowerCase().includes(featureLower))
        if (matchingFiles.length === 0) return []

        const fileIDs = new Set(matchingFiles.map((f) => f.id))
        const allNodes = yield* repo.listAllNodes()

        const entrypoints = allNodes.filter(
          (n) => fileIDs.has(n.fileID) && (n.kind === "function" || n.kind === "class" || n.kind === "method" || n.kind === "type"),
        )

        return entrypoints
      })

    // ------------------------------------------------------------------
    // findTests
    // ------------------------------------------------------------------
    const findTests = (input: {
      symbol: string
    }): Effect.Effect<CodegraphNode[], never, never> =>
      Effect.gen(function* () {
        const allFiles = yield* repo.listAllFiles()
        const allNodes = yield* repo.listAllNodes()

        const testFilePatterns = [".test.ts", ".spec.ts", "test_", "_test.go", "_test.py", ".test.tsx", ".spec.tsx"]
        const testFiles = allFiles.filter((f) => {
          const lower = f.path.toLowerCase()
          return testFilePatterns.some((p) => lower.includes(p.toLowerCase()))
        })
        if (testFiles.length === 0) return []

        const testFileIDs = new Set(testFiles.map((f) => f.id))
        const testNodes = allNodes.filter((n) => testFileIDs.has(n.fileID))
        if (testNodes.length === 0) return []

        const symbolMatches = yield* repo.searchNodes({ name: input.symbol })
        if (symbolMatches.length === 0) return []

        const exactMatch = symbolMatches.find((n) => n.name === input.symbol)
        const symbolID = (exactMatch ?? symbolMatches[0]).id

        const relevantTests: CodegraphNode[] = []
        for (const node of testNodes) {
          const edges = yield* repo.edgesFrom(node.id)
          const references = edges.filter(
            (e) => e.toNodeID === symbolID && (e.kind === "calls" || e.kind === "references"),
          )
          if (references.length > 0) relevantTests.push(node)
        }

        return relevantTests
      })

    // ------------------------------------------------------------------
    // findRelated
    // ------------------------------------------------------------------
    const findRelated = (input: {
      nodeID: string
      depth?: number
    }): Effect.Effect<CodegraphNode[], never, never> =>
      Effect.gen(function* () {
        const maxDepth = input.depth ?? 2
        const visited = new Set<string>([input.nodeID])
        const result: CodegraphNode[] = []
        const queue: Array<{ id: string; depth: number }> = [{ id: input.nodeID, depth: 0 }]

        while (queue.length > 0) {
          const current = queue.shift()!
          if (current.depth >= maxDepth) continue

          const outgoing = yield* repo.edgesFrom(current.id)
          const incoming = yield* repo.edgesTo(current.id)

          const nextIDs: string[] = []
          for (const edge of [...outgoing, ...incoming]) {
            const nextID = edge.fromNodeID === current.id ? edge.toNodeID : edge.fromNodeID
            if (!visited.has(nextID)) {
              visited.add(nextID)
              nextIDs.push(nextID)
            }
          }

          if (nextIDs.length > 0) {
            const nodes = yield* repo.nodesByIDs(nextIDs)
            result.push(...nodes)
            for (const id of nextIDs) {
              queue.push({ id, depth: current.depth + 1 })
            }
          }
        }

        return result
      })

    // ------------------------------------------------------------------
    // estimateImpact
    // ------------------------------------------------------------------
    const estimateImpact = (input: {
      paths: string[]
      maxDepth?: number
    }): Effect.Effect<{
      direct: CodegraphNode[]
      transitive: CodegraphNode[]
      blastRadius: number
    }, never, never> =>
      Effect.gen(function* () {
        const maxDepth = input.maxDepth ?? 2

        const allFiles = yield* repo.listAllFiles()
        const allNodes = yield* repo.listAllNodes()
        const pathToFileID = new Map(allFiles.map((f) => [f.path, f.id]))
        const targetFileIDs = new Set(input.paths.map((p) => pathToFileID.get(p)).filter(Boolean) as string[])

        const direct = allNodes.filter((n) => targetFileIDs.has(n.fileID))
        if (direct.length === 0) return { direct: [], transitive: [], blastRadius: 0 }

        const visited = new Set<string>(direct.map((n) => n.id))
        const transitive: CodegraphNode[] = []
        const queue: Array<{ id: string; depth: number }> = direct.map((n) => ({ id: n.id, depth: 0 }))

        while (queue.length > 0) {
          const current = queue.shift()!
          if (current.depth > maxDepth) continue

          const incoming = yield* repo.edgesTo(current.id)
          const nextIDs: string[] = []
          for (const edge of incoming) {
            if (!visited.has(edge.fromNodeID)) {
              visited.add(edge.fromNodeID)
              nextIDs.push(edge.fromNodeID)
            }
          }

          if (nextIDs.length > 0) {
            const nodes = yield* repo.nodesByIDs(nextIDs)
            transitive.push(...nodes)
            for (const id of nextIDs) {
              queue.push({ id, depth: current.depth + 1 })
            }
          }
        }

        const totalNodes = yield* repo.countNodes()
        const blastRadius = totalNodes > 0 ? transitive.length / totalNodes : 0

        return { direct, transitive, blastRadius }
      })

    // ------------------------------------------------------------------
    // traceExecution
    // ------------------------------------------------------------------
    const traceExecution = (input: {
      from: string
      maxDepth?: number
    }): Effect.Effect<CodegraphNode[], never, never> =>
      Effect.gen(function* () {
        const maxDepth = input.maxDepth ?? 4
        const visited = new Set<string>([input.from])
        const result: CodegraphNode[] = []
        const queue: Array<{ id: string; depth: number }> = [{ id: input.from, depth: 0 }]

        while (queue.length > 0) {
          const current = queue.shift()!
          if (current.depth >= maxDepth) continue

          const outgoing = yield* repo.edgesFrom(current.id)
          const nextIDs: string[] = []
          for (const edge of outgoing) {
            if ((edge.kind === "calls" || edge.kind === "imports") && !visited.has(edge.toNodeID)) {
              visited.add(edge.toNodeID)
              nextIDs.push(edge.toNodeID)
            }
          }

          if (nextIDs.length > 0) {
            const nodes = yield* repo.nodesByIDs(nextIDs)
            result.push(...nodes)
            for (const id of nextIDs) {
              queue.push({ id, depth: current.depth + 1 })
            }
          }
        }

        return result
      })

    return Service.of({
      findSymbol,
      findSubsystem,
      findEntrypoints,
      findTests,
      findRelated,
      estimateImpact,
      traceExecution,
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(CodegraphRepo.defaultLayer))
