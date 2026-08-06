import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { CodegraphBootstrap } from "@opencode-ai/core/banyancode/codegraph-bootstrap"
import { CodegraphReadiness } from "@opencode-ai/core/banyancode/codegraph-readiness"
import { CodegraphBuildService } from "@opencode-ai/core/banyancode/codegraph-build-service"
import { CodegraphIndexer } from "@opencode-ai/core/banyancode/codegraph-indexer"
import { CodegraphRepo } from "@opencode-ai/core/banyancode/codegraph-repo"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Database } from "@opencode-ai/core/database/database"
import { tmpdir } from "../fixture/tmpdir"
import path from "node:path"
import fs from "node:fs"

process.env.BANYANCODE_ENABLE = "1"

// Real graph: bootstrap → readiness → build service → indexer → repo, all
// bound to one tmpdir DB. The indexer here is the REAL indexer (regex
// parsers, no tree-sitter) so the background build actually completes.
// The indexer's Database requirement is satisfied with its own provide
// (Layer.provide does not merge outputs), while the repo is provideMerged
// so the test gen can yield CodegraphRepo.Service; FSUtil is provided last
// so the pipeline's R closes to never.
const buildBootstrapLayer = (dbPath: string) => {
  const dbLayer = Database.layerFromPath(dbPath)
  return CodegraphBootstrap.layer.pipe(
    Layer.provide(CodegraphReadiness.layer),
    Layer.provide(CodegraphBuildService.layer),
    Layer.provide(CodegraphIndexer.layer.pipe(Layer.provide(dbLayer))),
    Layer.provideMerge(CodegraphRepo.layer.pipe(Layer.provide(dbLayer))),
    Layer.provideMerge(FSUtil.defaultLayer),
  )
}

// Disabled branch never touches readiness, but the layer R still demands
// the tag — a stub is enough and keeps the disabled test fast.
const stubReadiness = Layer.succeed(
  CodegraphReadiness.Service,
  CodegraphReadiness.Service.of({
    ensureReady: () => Effect.succeed({ reason: "ready", autoBuilt: false }),
    status: () => Effect.succeed({ reason: "missing", autoBuilt: false }),
  }),
)

const disabledLayer = CodegraphBootstrap.layer.pipe(Layer.provide(stubReadiness))

// Poll status() until it reports the expected state (real time — the
// background build runs on a detached fiber).
const waitForState = (
  svc: { status: () => Effect.Effect<CodegraphBootstrap.BootstrapState, never, never> },
  expected: CodegraphBootstrap.BootstrapState["state"],
  timeoutMs = 60_000,
) =>
  Effect.gen(function* () {
    const deadline = Date.now() + timeoutMs
    while (true) {
      const st = yield* svc.status()
      if (st.state === expected) return st
      if (Date.now() > deadline) {
        return yield* Effect.fail(new Error(`bootstrap never became ${expected}; last=${JSON.stringify(st)}`))
      }
      yield* Effect.sleep("100 millis")
    }
  })

describe("CodegraphBootstrap", () => {
  test("disabled (BANYANCODE_ENABLE=0) returns { state: 'missing' } no-op", async () => {
    const original = process.env.BANYANCODE_ENABLE
    process.env.BANYANCODE_ENABLE = "0"
    try {
      const exit = await Effect.runPromiseExit(
        Effect.scoped(
          Effect.gen(function* () {
            const svc = yield* CodegraphBootstrap.Service
            const ensured = yield* svc.ensureGraph({ root: "C:\\anywhere" })
            const st = yield* svc.status()
            return { ensured, st }
          }).pipe(Effect.provide(disabledLayer)),
        ),
      )
      expect(exit._tag).toBe("Success")
      if (exit._tag === "Success") {
        expect(exit.value.ensured).toEqual({ state: "missing" })
        expect(exit.value.st).toEqual({ state: "missing" })
      }
    } finally {
      if (original === undefined) delete process.env.BANYANCODE_ENABLE
      else process.env.BANYANCODE_ENABLE = original
    }
  })

  test("empty workspace: ensureGraph kicks a background build that completes; status ends ready", async () => {
    await using tmp = await tmpdir()
    const repoDir = path.join(tmp.path, "src")
    fs.mkdirSync(repoDir, { recursive: true })
    fs.writeFileSync(path.join(repoDir, "a.ts"), "export const a = 1\n")
    fs.writeFileSync(path.join(repoDir, "b.py"), "def b():\n    return 1\n")
    fs.writeFileSync(path.join(tmp.path, "c.ts"), "export const c = 2\n")

    const dbPath = path.join(tmp.path, "bootstrap.db")
    const layer = buildBootstrapLayer(dbPath)

    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function* () {
          const svc = yield* CodegraphBootstrap.Service
          const first = yield* svc.ensureGraph({ root: tmp.path })
          expect(first.state).toBe("building")
          // The kick is non-blocking: the caller must never wait on a build.
          const st = yield* waitForState(svc, "ready")
          expect(st.state).toBe("ready")
          expect(st.symbols).toBeGreaterThanOrEqual(1)
          // The DB ends with a meta row.
          const repo = yield* CodegraphRepo.Service
          const meta = yield* repo.getMeta()
          expect(meta).toBeDefined()
          expect(meta?.totalFiles).toBeGreaterThanOrEqual(1)
          return st
        }).pipe(Effect.provide(layer)),
      ),
    )
    expect(exit._tag).toBe("Success")
  })

  test("filesystem-root guard returns { state: 'missing' } without building", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "bootstrap.db")
    const layer = buildBootstrapLayer(dbPath)

    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function* () {
          const svc = yield* CodegraphBootstrap.Service
          const st = yield* svc.ensureGraph({ root: path.parse(tmp.path).root })
          expect(st).toEqual({ state: "missing" })
          // Give a would-be build a moment: nothing may appear.
          yield* Effect.sleep("250 millis")
          const after = yield* svc.status()
          expect(after.state).toBe("missing")
          const repo = yield* CodegraphRepo.Service
          const meta = yield* repo.getMeta()
          expect(meta).toBeUndefined()
          return st
        }).pipe(Effect.provide(layer)),
      ),
    )
    expect(exit._tag).toBe("Success")
  })

  test("BANYANCODEGRAPH_BOOTSTRAP=0 disables the build kick (status stays missing)", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "bootstrap.db")
    const layer = buildBootstrapLayer(dbPath)

    const original = process.env.BANYANCODEGRAPH_BOOTSTRAP
    process.env.BANYANCODEGRAPH_BOOTSTRAP = "0"
    try {
      const exit = await Effect.runPromiseExit(
        Effect.scoped(
          Effect.gen(function* () {
            const svc = yield* CodegraphBootstrap.Service
            const st = yield* svc.ensureGraph({ root: tmp.path })
            expect(st).toEqual({ state: "missing" })
            yield* Effect.sleep("250 millis")
            const after = yield* svc.status()
            expect(after.state).toBe("missing")
            const repo = yield* CodegraphRepo.Service
            const meta = yield* repo.getMeta()
            expect(meta).toBeUndefined()
            return st
          }).pipe(Effect.provide(layer)),
        ),
      )
      expect(exit._tag).toBe("Success")
    } finally {
      if (original === undefined) delete process.env.BANYANCODEGRAPH_BOOTSTRAP
      else process.env.BANYANCODEGRAPH_BOOTSTRAP = original
    }
  })

  test("ensureGraph never fails, even for a root that does not exist", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "bootstrap.db")
    const layer = buildBootstrapLayer(dbPath)

    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function* () {
          const svc = yield* CodegraphBootstrap.Service
          const st = yield* svc.ensureGraph({ root: path.join(tmp.path, "does-not-exist") })
          // The build fails in the background and is logged; the caller
          // receives a state, never an error.
          expect(["building", "missing"]).toContain(st.state)
          return st
        }).pipe(Effect.provide(layer)),
      ),
    )
    expect(exit._tag).toBe("Success")
  })
})
