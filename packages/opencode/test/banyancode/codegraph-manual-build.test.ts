import { describe, expect, test } from "bun:test"
import { Effect, Fiber, Layer, Queue } from "effect"
import * as path from "path"
import * as os from "os"
import * as fs from "fs/promises"
import { Banyan } from "@opencode-ai/core/banyancode"
import { CodegraphBuildService } from "@opencode-ai/core/banyancode/codegraph-build-service"
import { Database } from "@opencode-ai/core/database/database"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { EventV2 } from "@opencode-ai/core/event"
import { NodeFileSystem } from "@effect/platform-node"
import { pollWithTimeout } from "../lib/effect"
import { tmpdir } from "../fixture/tmpdir"

process.env.BANYANCODE_ENABLE = "1"

async function makeTmpdir(): Promise<string> {
  await using tmp = await tmpdir()
  await fs.mkdir(tmp.path, { recursive: true })
  return tmp.path
}

async function makeFixtureCodebase(dir: string, fileCount: number): Promise<void> {
  await fs.mkdir(path.join(dir, "src"), { recursive: true })
  for (let i = 0; i < fileCount; i++) {
    await Bun.write(
      path.join(dir, `src/file${i}.ts`),
      `export function func${i}() { return ${i} }
export class Class${i} { value = ${i} }
export const constant${i} = ${i}`,
    )
  }
}

function makeTestLayer(dbPath: string) {
  const dbLayer = Database.layerFromPath(dbPath)
  const repoLayer = Banyan.codegraphRepoDefaultLayer.pipe(Layer.provide(dbLayer))
  const buildLayer = Banyan.codegraphBuildServiceDefaultLayer.pipe(Layer.provide(dbLayer))
  return Layer.merge(repoLayer, buildLayer).pipe(
    Layer.provide(FSUtil.defaultLayer),
    Layer.provide(NodeFileSystem.layer),
    Layer.provide(EventV2.defaultLayer),
  )
}

describe("Manual codegraph build - progress reporting", () => {
  test("build reports progress during indexing", async () => {
    await using tmp = await tmpdir()
    const dir = tmp.path
    await makeFixtureCodebase(dir, 10)
    const dbPath = path.join(dir, "test.sqlite")
    const layer = makeTestLayer(dbPath)

    const progressUpdates: any[] = []
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const buildSvc = yield* CodegraphBuildService.Service
        yield* buildSvc.start({ root: dir, force: true })

        const state = yield* pollWithTimeout(
          Effect.gen(function* () {
            const s = yield* buildSvc.status()
            if (s.status === "running") {
              progressUpdates.push({
                done: s.done,
                total: s.total,
                currentFile: s.currentFile,
              })
            }
            if (s.status === "completed" || s.status === "failed" || s.status === "cancelled") return s
            return undefined
          }),
          "build never completed",
          "30 seconds",
        )
        return state
      }).pipe(Effect.provide(layer), Effect.scoped),
    )

    expect(result.status).toBe("completed")
    expect((result as any).result?.indexed).toBeGreaterThan(0)
    console.log(`\nReceived ${progressUpdates.length} progress updates`)
    console.log("First 3:", JSON.stringify(progressUpdates.slice(0, 3), null, 2))
    console.log("Last 3:", JSON.stringify(progressUpdates.slice(-3), null, 2))
    expect(progressUpdates.length).toBeGreaterThan(0)
    const finalUpdate = progressUpdates[progressUpdates.length - 1]
    expect(finalUpdate.total).toBe(10)
  }, 60000)

  test("clearAll removes all files, nodes, and edges", async () => {
    await using tmp = await tmpdir()
    const dir = tmp.path
    await makeFixtureCodebase(dir, 3)
    const dbPath = path.join(dir, "test.sqlite")
    const layer = makeTestLayer(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const buildSvc = yield* CodegraphBuildService.Service
        yield* buildSvc.start({ root: dir, force: true })

        // Wait for build to complete
        yield* pollWithTimeout(
          Effect.gen(function* () {
            const s = yield* buildSvc.status()
            if (s.status === "completed" || s.status === "failed" || s.status === "cancelled") return s
            return undefined
          }),
          "build never completed",
          "30 seconds",
        )

        const repo = yield* Banyan.CodegraphRepo
        const filesBefore = yield* repo.listAllFiles()
        const nodesBefore = yield* repo.listAllNodes()
        expect(filesBefore.length).toBe(3)
        expect(nodesBefore.length).toBeGreaterThan(0)

        // Clear all!
        yield* repo.clearAll()

        const filesAfter = yield* repo.listAllFiles()
        const nodesAfter = yield* repo.listAllNodes()
        expect(filesAfter).toEqual([])
        expect(nodesAfter).toEqual([])
      }).pipe(Effect.provide(layer), Effect.scoped),
    )
  }, 60000)

  test("events queue receives every progress event (no double-consumer race)", async () => {
    await using tmp = await tmpdir()
    const dir = tmp.path
    await makeFixtureCodebase(dir, 10)
    const dbPath = path.join(dir, "test.sqlite")
    const layer = makeTestLayer(dbPath)

    const received: { done: number; total: number; status: string }[] = []
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const buildSvc = yield* CodegraphBuildService.Service
        const queue = buildSvc.events()

        const drain = yield* Effect.forkScoped(
          Effect.forever(
            Effect.gen(function* () {
              const event = yield* Queue.take(queue)
              received.push({
                done: (event.properties as any).done,
                total: (event.properties as any).total,
                status: (event.properties as any).status,
              })
              if ((event.properties as any).status === "completed") return
            }),
          ),
        )

        yield* buildSvc.start({ root: dir, force: true })

        const state = yield* pollWithTimeout(
          Effect.gen(function* () {
            const s = yield* buildSvc.status()
            if (s.status === "completed" || s.status === "failed" || s.status === "cancelled") return s
            return undefined
          }),
          "build never completed",
          "30 seconds",
        )

        yield* Effect.sleep("50 millis")
        yield* Fiber.interrupt(drain)
        return state
      }).pipe(Effect.provide(layer), Effect.scoped),
    )

    expect(result.status).toBe("completed")
    const runningEvents = received.filter((e) => e.status === "running")
    const completedEvent = received.find((e) => e.status === "completed")
    expect(received.length).toBeGreaterThan(2)
    expect(runningEvents.length).toBeGreaterThan(0)
    const lastRunning = runningEvents[runningEvents.length - 1]
    expect(lastRunning.total).toBe(10)
    expect(lastRunning.done).toBe(10)
    expect(completedEvent).toBeDefined()
  }, 60000)
})

describe("Manual codegraph build of this workspace", () => {
  test("build the actual BanyanCode workspace and observe progress", async () => {
    const workspaceRoot = "D:\\OpenCode"
    const dbPath = path.join(os.tmpdir(), "opencode-ws-build-" + Math.random().toString(36).slice(2) + ".sqlite")

    const layer = makeTestLayer(dbPath)

    const progressUpdates: any[] = []
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const buildSvc = yield* CodegraphBuildService.Service
        yield* buildSvc.start({ root: workspaceRoot, force: true })

        const state = yield* pollWithTimeout(
          Effect.gen(function* () {
            const s = yield* buildSvc.status()
            if (s.status === "running") {
              progressUpdates.push({
                done: s.done,
                total: s.total,
                currentFile: s.currentFile,
              })
              if (progressUpdates.length % 100 === 0) {
                console.log(
                  `Progress: ${s.done}/${s.total} - ${s.currentFile ?? ""}`,
                )
              }
            }
            if (s.status === "completed" || s.status === "failed" || s.status === "cancelled") return s
            return undefined
          }),
          "build never completed",
          "5 minutes",
        )
        return state
      }).pipe(Effect.provide(layer), Effect.scoped),
    )

    expect(result.status).toBe("completed")
    expect((result as any).result?.indexed).toBeGreaterThan(0)
    console.log(`\nReceived ${progressUpdates.length} progress updates`)
    console.log(
      `Final: indexed=${(result as any).result.indexed} skipped=${(result as any).result.skipped} duration_ms=${(result as any).result.duration_ms}`,
    )
    console.log(`Last 5 progress updates:`)
    for (const u of progressUpdates.slice(-5)) {
      console.log(`  ${u.done}/${u.total} - ${u.currentFile}`)
    }

    try {
      await fs.unlink(dbPath)
    } catch {}
  }, 300000)
})
