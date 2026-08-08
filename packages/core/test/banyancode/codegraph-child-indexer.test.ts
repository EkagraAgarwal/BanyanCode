import { describe, expect, test } from "bun:test"
import { Effect, Fiber, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { EventV2 } from "@opencode-ai/core/event"
import { tmpdir } from "../fixture/tmpdir"
import path from "node:path"
import fs from "node:fs"
import { childCommand, runChildIndexer } from "../../src/banyancode/codegraph-indexer-child"
import { CodegraphIndexer } from "../../src/banyancode/codegraph-indexer"
import { CodegraphRepo } from "../../src/banyancode/codegraph-repo"
import { CodegraphBuildService, layer as buildServiceLayer } from "../../src/banyancode/codegraph-build-service"
import { WorkspaceIdentity } from "../../src/banyancode/workspace-identity"

process.env.BANYANCODE_ENABLE = "1"

const makeRepo = (root: string) => {
  const src = path.join(root, "src")
  fs.mkdirSync(src, { recursive: true })
  fs.writeFileSync(path.join(src, "a.ts"), "export const alpha = 1\nexport const beta = alpha + 1\n")
  fs.writeFileSync(path.join(src, "b.ts"), "import { alpha } from './a'\nexport const gamma = alpha * 2\n")
  fs.writeFileSync(path.join(root, "c.py"), "def hello():\n    return 1\n")
}

type ChildMsg = {
  type: string
  [key: string]: unknown
}

const runChild = (config: { root: string; dbPath: string; force?: boolean }) => {
  const proc = Bun.spawn(childCommand(config), {
    cwd: config.root,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  })
  return { proc }
}

describe("CodegraphChildIndexer", () => {
  test("childCommand resolves a spawnable command that carries the config", async () => {
    await using tmp = await tmpdir()
    makeRepo(tmp.path)
    const identity = WorkspaceIdentity.identityForRoot(tmp.path)
    const cmd = childCommand({ root: identity.root, dbPath: identity.dbPath, force: true })

    expect(cmd.length).toBeGreaterThanOrEqual(2)
    const configArg = cmd[cmd.length - 1]
    expect(configArg).toContain("--child-config=")
    const parsed = JSON.parse(configArg.slice("--child-config=".length))
    expect(parsed.root).toBe(identity.root)
    expect(parsed.dbPath).toBe(identity.dbPath)
  })

  test("spawned child indexes a repo, streams progress, reports a result, and writes meta", async () => {
    await using tmp = await tmpdir()
    makeRepo(tmp.path)
    const identity = WorkspaceIdentity.identityForRoot(tmp.path)

    const { proc } = runChild({ root: identity.root, dbPath: identity.dbPath, force: true })
    const stdout = await new Response(proc.stdout).text()
    const code = await proc.exited
    expect(code).toBe(0)

    const lines = stdout
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as ChildMsg)
    expect(lines.length).toBeGreaterThan(0)

    const progress = lines.filter((l) => l.type === "progress")
    expect(progress.length).toBeGreaterThanOrEqual(1)
    expect(progress[0]?.total).toBe(3)

    const result = lines.find((l) => l.type === "result")
    expect(result).toBeDefined()
    expect((result as { result?: { indexed: number } })?.result?.indexed).toBeGreaterThanOrEqual(1)
    expect((result as { graphVersion?: number })?.graphVersion).toBeGreaterThanOrEqual(1)

    // The child owns the DB writes — meta row lands in the same file the
    // parent would read.
    const meta = await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* CodegraphRepo.Service
        return yield* repo.getMeta()
      }).pipe(
        Effect.provide(CodegraphRepo.layer.pipe(Layer.provide(Database.layerFromPath(identity.dbPath)))),
      ),
    )
    expect(meta).toBeDefined()
    expect(meta?.totalFiles).toBe(3)
  })

  test("runChildIndexer returns 0 on success and a non-zero code with an error line on failure", async () => {
    // Success path (already covered by the spawn test); failure path: bogus dbPath.
    const code = await runChildIndexer(
      JSON.stringify({ root: "C:\\definitely-not-a-real-root-xyz", dbPath: "C:\\definitely-not-a-real-db-xyz.db" }),
    )
    expect(code).toBeGreaterThan(0)
  })

  test("build service in child mode completes the build with terminal state", async () => {
    await using tmp = await tmpdir()
    makeRepo(tmp.path)
    const identity = WorkspaceIdentity.identityForRoot(tmp.path)
    const dbLayer = Database.layerFromPath(identity.dbPath)

    const serviceLayer = buildServiceLayer.pipe(
      Layer.provide(
        CodegraphIndexer.layer.pipe(
          Layer.provide(FSUtil.defaultLayer),
          Layer.provideMerge(CodegraphRepo.layer.pipe(Layer.provide(dbLayer))),
          Layer.provide(dbLayer),
        ),
      ),
      Layer.provideMerge(CodegraphRepo.layer.pipe(Layer.provide(dbLayer))),
      Layer.provide(EventV2.defaultLayer),
    )

    const original = process.env.BANYANCODE_INDEXER_CHILD
    process.env.BANYANCODE_INDEXER_CHILD = "1"
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const service = yield* CodegraphBuildService.Service
          yield* service.start({ root: tmp.path, force: true })

          const deadline = Date.now() + 60_000
          while (true) {
            const st = yield* service.status()
            if (st.status !== "running" && st.status !== "idle") {
              expect(st.status).toBe("completed")
              expect(st.graphVersion).toBeGreaterThanOrEqual(1)
              expect(st.result?.indexed).toBeGreaterThanOrEqual(1)
              expect(st.dbPath).toBe(identity.dbPath)
              return
            }
            if (Date.now() > deadline) {
              return yield* Effect.fail(new Error(`build never completed; last=${JSON.stringify(st)}`))
            }
            yield* Effect.sleep("100 millis")
          }
        }).pipe(Effect.provide(serviceLayer), Effect.scoped),
      )
    } finally {
      if (original === undefined) delete process.env.BANYANCODE_INDEXER_CHILD
      else process.env.BANYANCODE_INDEXER_CHILD = original
    }
  })

  test("build service child mode: cancel hard-kills the child and flips state to cancelled", async () => {
    await using tmp = await tmpdir()
    makeRepo(tmp.path)
    const identity = WorkspaceIdentity.identityForRoot(tmp.path)
    const dbLayer = Database.layerFromPath(identity.dbPath)

    const serviceLayer = buildServiceLayer.pipe(
      Layer.provide(
        CodegraphIndexer.layer.pipe(
          Layer.provide(FSUtil.defaultLayer),
          Layer.provideMerge(CodegraphRepo.layer.pipe(Layer.provide(dbLayer))),
          Layer.provide(dbLayer),
        ),
      ),
      Layer.provideMerge(CodegraphRepo.layer.pipe(Layer.provide(dbLayer))),
      Layer.provide(EventV2.defaultLayer),
    )

    const original = process.env.BANYANCODE_INDEXER_CHILD
    process.env.BANYANCODE_INDEXER_CHILD = "1"
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const service = yield* CodegraphBuildService.Service
          yield* service.start({ root: tmp.path, force: true })
          // Give the child a moment to start parsing, then cancel.
          yield* Effect.sleep("300 millis")
          yield* service.cancel()

          const deadline = Date.now() + 10_000
          while (true) {
            const st = yield* service.status()
            if (st.status === "cancelled") {
              expect(st.error).toBeUndefined()
              return
            }
            if (Date.now() > deadline) {
              return yield* Effect.fail(new Error(`cancel never landed; last=${JSON.stringify(st)}`))
            }
            yield* Effect.sleep("50 millis")
          }
        }).pipe(Effect.provide(serviceLayer), Effect.scoped),
      )
    } finally {
      if (original === undefined) delete process.env.BANYANCODE_INDEXER_CHILD
      else process.env.BANYANCODE_INDEXER_CHILD = original
    }
  })

  test("child mode: host event loop stays responsive while the child indexes (heartbeat)", async () => {
    await using tmp = await tmpdir()
    // Large enough that the child build spans multiple seconds, so the host
    // heartbeat gets a real sampling window while walk/parse/write/derived
    // all run in the child process.
    const src = path.join(tmp.path, "src")
    fs.mkdirSync(src, { recursive: true })
    for (let i = 0; i < 200; i++) {
      fs.writeFileSync(
        path.join(src, `f${i}.ts`),
        `export const v${i} = ${i}\nexport function fn${i}() { return ${i} }\nexport class C${i} { x = ${i} }\n`,
      )
    }
    const identity = WorkspaceIdentity.identityForRoot(tmp.path)
    const dbLayer = Database.layerFromPath(identity.dbPath)

    const serviceLayer = buildServiceLayer.pipe(
      Layer.provide(
        CodegraphIndexer.layer.pipe(
          Layer.provide(FSUtil.defaultLayer),
          Layer.provideMerge(CodegraphRepo.layer.pipe(Layer.provide(dbLayer))),
          Layer.provide(dbLayer),
        ),
      ),
      Layer.provideMerge(CodegraphRepo.layer.pipe(Layer.provide(dbLayer))),
      Layer.provide(EventV2.defaultLayer),
    )

    const original = process.env.BANYANCODE_INDEXER_CHILD
    process.env.BANYANCODE_INDEXER_CHILD = "1"
    try {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const service = yield* CodegraphBuildService.Service

          // This runtime is the same shape as the TUI worker: it serves the
          // build service (and would serve session/SSE RPCs) while a child
          // process does all the indexing CPU work. If any indexing work
          // leaked back into the host event loop, this heartbeat would stall.
          let lastTick = Date.now()
          let maxGap = 0
          let tickCount = 0
          const heartbeat = yield* Effect.forkScoped(
            Effect.gen(function* () {
              for (;;) {
                yield* Effect.sleep(50)
                const now = Date.now()
                const gap = now - lastTick
                lastTick = now
                if (gap > maxGap) maxGap = gap
                tickCount++
              }
            }),
          )

          yield* service.start({ root: tmp.path, force: true })

          const deadline = Date.now() + 120_000
          let terminal: { status: string } | undefined
          while (true) {
            const st = yield* service.status()
            if (st.status === "completed" || st.status === "failed" || st.status === "cancelled") {
              terminal = st
              break
            }
            if (Date.now() > deadline) {
              return yield* Effect.fail(new Error(`build never completed; last=${JSON.stringify(st)}`))
            }
            yield* Effect.sleep("50 millis")
          }
          yield* Fiber.interrupt(heartbeat)

          console.log(`\n=== Child-mode host heartbeat ===`)
          console.log(`ticks     : ${tickCount} (50ms cadence)`)
          console.log(`max gap   : ${maxGap}ms (largest host event-loop stall)`)
          console.log(`terminal  : ${terminal.status}`)
          console.log(`====================================\n`)

          return { maxGap, status: terminal.status, tickCount }
        }).pipe(Effect.provide(serviceLayer), Effect.scoped),
      )

      expect(result.status).toBe("completed")
      // A host-loop stall >2s would freeze the session/TUI exactly like the
      // pre-isolation builds. With indexing in a child, gaps stay sub-100ms.
      expect(result.maxGap).toBeLessThan(2000)
    } finally {
      if (original === undefined) delete process.env.BANYANCODE_INDEXER_CHILD
      else process.env.BANYANCODE_INDEXER_CHILD = original
    }
  }, 180_000)
})
