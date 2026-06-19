import { describe, expect, test } from "bun:test"
import { Effect, Layer, Option } from "effect"
import { CodegraphStaleness, StaleCheck } from "../../src/banyancode/codegraph-staleness"
import { CodegraphRepo } from "../../src/banyancode/codegraph-repo"
import { FSUtil } from "../../src/fs-util"
import { Banyan } from "@opencode-ai/core/banyancode"

// Set BANYANCODE_ENABLE for all tests
process.env.BANYANCODE_ENABLE = "1"

const mockFiles: Banyan.CodegraphFile[] = []
const mockMeta: { value: Banyan.CodegraphMeta | undefined } = { value: undefined }
const mockMtimes: Map<string, number> = new Map()

const mockRepo = Layer.succeed(
  CodegraphRepo.Service,
  CodegraphRepo.Service.of({
    listAllFiles: () => Effect.succeed(mockFiles),
    getMeta: () => Effect.succeed(mockMeta.value),
    // stub all other methods
    putFile: () => Effect.void,
    getFile: () => Effect.succeed(undefined),
    getFileByPath: () => Effect.succeed(undefined),
    putNode: () => Effect.void,
    getNode: () => Effect.succeed(undefined),
    nodeByID: () => Effect.succeed(undefined),
    listNodesByFile: () => Effect.succeed([]),
    listAllNodes: () => Effect.succeed([]),
    queryNodes: () => Effect.succeed([]),
    putEdge: () => Effect.void,
    getEdge: () => Effect.succeed(undefined),
    listEdgesByNode: () => Effect.succeed([]),
    edgesFrom: () => Effect.succeed([]),
    edgesTo: () => Effect.succeed([]),
    putEmbedding: () => Effect.void,
    getEmbedding: () => Effect.succeed(undefined),
    deleteFile: () => Effect.void,
    clearAll: () => Effect.void,
    setMeta: () => Effect.void,
    bumpVersion: () => Effect.succeed({ graphVersion: 1, coverage: 1 }),
  }),
)

// Create FS mock by yielding the real FSUtil and overriding only stat
// The mock returns different mtimes based on our mockMtimes map
const mockFs = Layer.effect(
  FSUtil.Service,
  FSUtil.Service.pipe(
    Effect.map((fs) =>
      FSUtil.Service.of({
        ...fs,
        stat: (path: string) => {
          const mockMtime = mockMtimes.get(path)
          if (mockMtime !== undefined) {
            // Return a mock FileInfo - cast to any since we only use mtime
            const mockInfo = {
              type: "File" as const,
              mtime: Option.some(new Date(mockMtime)),
              // Include just enough to satisfy the interface - the staleness service only uses mtime
              atime: Option.none(),
              birthtime: Option.none(),
              dev: 0,
              ino: 0,
              mode: 0,
              nlink: 0,
              size: BigInt(0),
              uid: 0,
              gid: 0,
              blksize: 0,
              blocks: 0,
              isFile: () => true,
              isDirectory: () => false,
              isSymbolicLink: () => false,
              permissions: { readable: true, writable: true, executable: false },
            }
            return Effect.succeed(mockInfo as any)
          }
          // No mock entry - call real stat which will throw for missing files
          return fs.stat(path)
        },
      }),
    ),
  ),
).pipe(Layer.provide(FSUtil.defaultLayer))

// Build the service layer by providing mocks to the staleness layer
const stalenessLayer = CodegraphStaleness.layer.pipe(
  Layer.provide(mockRepo),
  Layer.provide(mockFs),
)

describe("CodegraphStaleness", () => {
  test("isStale returns no-indexed-files when repo is empty", async () => {
    mockFiles.length = 0
    mockMeta.value = undefined
    mockMtimes.clear()

    await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* CodegraphStaleness.Service
        const result = yield* service.isStale({ root: "/test" })
        expect(result.isStale).toBe(true)
        expect(result.reason).toBe("no indexed files")
        expect(result.filesTotal).toBe(0)
      }).pipe(Effect.provide(stalenessLayer)),
    )
  })

  test("isStale returns false when no files changed and graph is fresh", async () => {
    const now = Date.now()
    mockFiles.length = 0
    mockFiles.push({ id: "1", path: "/test/a.ts", contentHash: "abc", language: "typescript", indexedAt: now - 1000 })
    mockMeta.value = {
      id: "singleton",
      graphBuiltAt: now - 1000,
      graphVersion: 1,
      graphCoverage: 1,
      totalFiles: 1,
      totalNodes: 0,
      totalEdges: 0,
      schemaVersion: 1,
    }
    // File's mtime is BEFORE indexedAt (indexedAt = now - 1000, mtime = now - 2000)
    mockMtimes.set("/test/a.ts", now - 2000)

    await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* CodegraphStaleness.Service
        const result = yield* service.isStale({ root: "/test", thresholdMs: 24 * 60 * 60 * 1000 })
        expect(result.isStale).toBe(false)
        expect(result.filesChanged).toBe(0)
        expect(result.filesMissing).toBe(0)
        expect(result.reason).toBeUndefined()
      }).pipe(Effect.provide(stalenessLayer)),
    )
  })

  test("isStale flags filesChanged when filesystem mtime > indexedAt", async () => {
    const now = Date.now()
    mockFiles.length = 0
    mockFiles.push({ id: "1", path: "/test/a.ts", contentHash: "abc", language: "typescript", indexedAt: now - 5000 })
    mockMeta.value = {
      id: "singleton",
      graphBuiltAt: now - 5000,
      graphVersion: 1,
      graphCoverage: 1,
      totalFiles: 1,
      totalNodes: 0,
      totalEdges: 0,
      schemaVersion: 1,
    }
    // File has been modified AFTER it was indexed (mtime = now, indexedAt = now - 5000)
    mockMtimes.set("/test/a.ts", now)

    await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* CodegraphStaleness.Service
        const result = yield* service.isStale({ root: "/test" })
        expect(result.isStale).toBe(true)
        expect(result.filesChanged).toBe(1)
        expect(result.reason).toBe("1 file changed")
      }).pipe(Effect.provide(stalenessLayer)),
    )
  })

  test("isStale flags filesMissing when file no longer exists", async () => {
    const now = Date.now()
    mockFiles.length = 0
    mockFiles.push({ id: "1", path: "/test/deleted.ts", contentHash: "abc", language: "typescript", indexedAt: now - 1000 })
    mockMeta.value = {
      id: "singleton",
      graphBuiltAt: now - 1000,
      graphVersion: 1,
      graphCoverage: 1,
      totalFiles: 1,
      totalNodes: 0,
      totalEdges: 0,
      schemaVersion: 1,
    }
    // NOT setting mockMtimes for this file - it will call real fs.stat which will throw

    await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* CodegraphStaleness.Service
        const result = yield* service.isStale({ root: "/test" })
        expect(result.isStale).toBe(true)
        expect(result.filesMissing).toBe(1)
        expect(result.reason).toBe("1 file missing")
      }).pipe(Effect.provide(stalenessLayer)),
    )
  })

  test("isStale flags stale-graph when graphBuiltAt > threshold", async () => {
    const now = Date.now()
    mockFiles.length = 0
    mockFiles.push({ id: "1", path: "/test/a.ts", contentHash: "abc", language: "typescript", indexedAt: now - 1000 })
    mockMeta.value = {
      id: "singleton",
      graphBuiltAt: now - 1000,
      graphVersion: 1,
      graphCoverage: 1,
      totalFiles: 1,
      totalNodes: 0,
      totalEdges: 0,
      schemaVersion: 1,
    }
    mockMtimes.set("/test/a.ts", now - 1000)

    // Very short threshold (1ms) to trigger staleness
    await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* CodegraphStaleness.Service
        const result = yield* service.isStale({ root: "/test", thresholdMs: 1 })
        expect(result.isStale).toBe(true)
        expect(result.graphVersion).toBe(1)
      }).pipe(Effect.provide(stalenessLayer)),
    )
  })

  test("isStale respects custom thresholdMs", async () => {
    const now = Date.now()
    mockFiles.length = 0
    mockFiles.push({ id: "1", path: "/test/a.ts", contentHash: "abc", language: "typescript", indexedAt: now - 1000 })
    mockMeta.value = {
      id: "singleton",
      graphBuiltAt: now - 1000,
      graphVersion: 1,
      graphCoverage: 1,
      totalFiles: 1,
      totalNodes: 0,
      totalEdges: 0,
      schemaVersion: 1,
    }
    mockMtimes.set("/test/a.ts", now - 1000)

    // With 1 hour threshold, graph should not be stale
    await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* CodegraphStaleness.Service
        const result = yield* service.isStale({ root: "/test", thresholdMs: 60 * 60 * 1000 })
        expect(result.isStale).toBe(false)
      }).pipe(Effect.provide(stalenessLayer)),
    )
  })

  test("status returns last isStale result", async () => {
    mockFiles.length = 0
    mockMeta.value = undefined
    mockMtimes.clear()

    await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* CodegraphStaleness.Service
        const initialStatus = yield* service.status()
        expect(initialStatus).toBeUndefined()

        yield* service.isStale({ root: "/test" })
        const afterCheck = yield* service.status()
        expect(afterCheck).toBeDefined()
        expect(afterCheck!.isStale).toBe(true)
        expect(afterCheck!.reason).toBe("no indexed files")
      }).pipe(Effect.provide(stalenessLayer)),
    )
  })
})
