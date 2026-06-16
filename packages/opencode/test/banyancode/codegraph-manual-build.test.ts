import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import * as path from "path"
import * as os from "os"
import * as fs from "fs/promises"
import { Banyan, type BanyanConfigInfo } from "@opencode-ai/core/banyancode"
import { CodegraphBuildService, type State as BuildState } from "@opencode-ai/core/banyancode/codegraph-build-service"
import { Database } from "@opencode-ai/core/database/database"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { EventV2 } from "@opencode-ai/core/event"
import { NodeFileSystem } from "@effect/platform-node"
import { pollWithTimeout } from "../lib/effect"

process.env.BANYANCODE_ENABLE = "1"

const makeMockHttpClient = () =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((_request: HttpClientRequest.HttpClientRequest) =>
      Effect.succeed(HttpClientResponse.fromWeb(_request, new Response("{}", { status: 200 }))),
    ),
  )

const makeMockBanyanConfig = () =>
  Layer.succeed(Banyan.BanyanConfigService, {
    get: () => Effect.succeed({} as BanyanConfigInfo),
    getGlobal: () => Effect.succeed({} as BanyanConfigInfo),
    update: () => Effect.succeed({} as BanyanConfigInfo),
  })

const makeMockEmbeddingProvider = () =>
  Layer.succeed(Banyan.EmbeddingProviderService, {
    embed: () => Effect.succeed([] as Float32Array[]),
    model: () => undefined,
    setModel: () => Effect.void,
    inputHash: () => "",
    config: () => ({
      baseUrl: "https://api.openai.com/v1",
      apiKey: undefined,
      dimensions: undefined,
      batchSize: 64,
    }),
  })

async function makeTmpdir(): Promise<string> {
  const dir = path.join(os.tmpdir(), "opencode-build-" + Math.random().toString(36).slice(2))
  await fs.mkdir(dir, { recursive: true })
  return dir
}

async function cleanTmpdir(dir: string): Promise<void> {
  for (let i = 0; i < 5; i++) {
    try {
      await fs.rm(dir, { recursive: true, force: true })
      return
    } catch (e: any) {
      if (e.code === "EBUSY" && i < 4) {
        await new Promise((r) => setTimeout(r, 200))
        continue
      }
      throw e
    }
  }
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
  return Banyan.codegraphBuildServiceDefaultLayer.pipe(
    Layer.provide(Database.layerFromPath(dbPath)),
    Layer.provide(FSUtil.defaultLayer),
    Layer.provide(NodeFileSystem.layer),
    Layer.provide(EventV2.defaultLayer),
    Layer.provide(makeMockHttpClient()),
    Layer.provide(makeMockBanyanConfig()),
    Layer.provide(makeMockEmbeddingProvider()),
  )
}

describe("Manual codegraph build - progress reporting", () => {
  test("build reports progress during indexing", async () => {
    const dir = await makeTmpdir()
    try {
      await makeFixtureCodebase(dir, 10)
      const dbPath = path.join(dir, "test.sqlite")
      const layer = makeTestLayer(dbPath)

      const progressUpdates: any[] = []
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const buildSvc = yield* CodegraphBuildService.Service
          yield* buildSvc.start({ root: dir, force: true })

          let state: BuildState
          while (true) {
            const s = yield* buildSvc.status()
            state = s
            if (s.status === "running") {
              progressUpdates.push({
                done: s.done,
                total: s.total,
                currentFile: s.currentFile,
              })
            }
            if (s.status === "completed" || s.status === "failed" || s.status === "cancelled") break
            yield* Effect.sleep("20 millis")
          }
          return state
        }).pipe(Effect.provide(layer)),
      )

      expect(result.status).toBe("completed")
      expect((result as any).result?.indexed).toBeGreaterThan(0)
      console.log(`\nReceived ${progressUpdates.length} progress updates`)
      console.log("First 3:", JSON.stringify(progressUpdates.slice(0, 3), null, 2))
      console.log("Last 3:", JSON.stringify(progressUpdates.slice(-3), null, 2))
      expect(progressUpdates.length).toBeGreaterThan(0)
      const finalUpdate = progressUpdates[progressUpdates.length - 1]
      expect(finalUpdate.total).toBe(10)
    } finally {
      await cleanTmpdir(dir)
    }
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

        let state: BuildState
        while (true) {
          const s = yield* buildSvc.status()
          state = s
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
          if (s.status === "completed" || s.status === "failed" || s.status === "cancelled") break
          yield* Effect.sleep("20 millis")
        }
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
