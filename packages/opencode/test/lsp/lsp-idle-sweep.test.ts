import { describe, expect } from "bun:test"
import path from "path"
import os from "os"
import fs from "fs/promises"
import { Effect, Layer, Ref } from "effect"
import { LSP } from "@/lsp/lsp"
import * as LSPServer from "@/lsp/server"
import { EventV2Bridge } from "@/event-v2-bridge"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2 } from "@opencode-ai/core/event"
import { Database } from "@opencode-ai/core/database/database"
import { Banyan } from "@opencode-ai/core/banyancode"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { InstanceBootstrap } from "@/project/bootstrap-service"
import { InstanceStore } from "@/project/instance-store"
import { Project } from "@/project/project"
import { tmpdirScoped } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"

// In-memory BanyanConfigService so this test never touches the shared global
// banyancode.json on disk.
const memoryBanyanLayer = Layer.effect(
  Banyan.BanyanConfigService,
  Effect.gen(function* () {
    const ref = yield* Ref.make<Banyan.BanyanConfigInfo>({})
    const get = () => Ref.get(ref)
    const update = (patch: Partial<Banyan.BanyanConfigInfo>) =>
      Ref.updateAndGet(ref, (current) => ({ ...current, ...patch }))
    return Banyan.BanyanConfigService.of({
      get,
      getGlobal: get,
      update,
      updateAgentOverride: () => Ref.get(ref),
      getAgentOverrides: () => Ref.get(ref).pipe(Effect.map((config) => config.agent)),
      updateAgentPrompt: () => Ref.get(ref),
    })
  }),
)

// Fake project + noop bootstrap: the sweep mechanics need no real project
// database (which also keeps this test off the globally-locked DB file).
const noopBootstrap = Layer.succeed(
  InstanceBootstrap.Service,
  InstanceBootstrap.Service.of({ run: Effect.void }),
)
const fakeProject = Layer.mock(Project.Service, {
  fromDirectory: (directory: string) =>
    Effect.succeed({
      project: {
        id: "test-project",
        worktree: directory,
        time: { created: Date.now(), updated: Date.now() },
        sandboxes: [],
      } as unknown as Project.Info,
      sandbox: directory,
    }),
})
const storeLayer = InstanceStore.layerWithOptions({}).pipe(
  Layer.provide(Layer.mergeAll(fakeProject, noopBootstrap)),
)

// Per-run event DB so this test never touches the shared global database
// file (a live banyancode.exe can hold its lock and fence the run with
// SQLITE_LOCKED). Mirrors LSP.defaultLayer but swaps the event stack.
const TEST_DB_PATH = path.join(
  os.tmpdir(),
  `opencode-lsp-sweep-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
)
const sweepEventLayer = EventV2.layer.pipe(Layer.provide(Database.layerFromPath(TEST_DB_PATH)))
const sweepBridgeLayer = EventV2Bridge.layer.pipe(Layer.provide(sweepEventLayer))
const sweepLspLayer = LSP.layer.pipe(
  Layer.provide(RuntimeFlags.defaultLayer),
  Layer.provide(sweepBridgeLayer),
  Layer.provide(Banyan.banyanConfigServiceDefaultLayer),
)

const it = testEffect(
  Layer.mergeAll(sweepLspLayer, CrossSpawnSpawner.defaultLayer, memoryBanyanLayer, storeLayer),
)

const fakeServerPath = path.join(__dirname, "../fixture/lsp/fake-lsp-server.js")

const onlyFake = (command: string[]) =>
  Object.fromEntries([
    ...Object.values(LSPServer)
      .filter(
        (candidate): candidate is LSPServer.Info =>
          !!candidate && typeof candidate === "object" && "id" in candidate && "spawn" in candidate,
      )
      .map((server) => [server.id, { disabled: true }] as const),
    ["fake", { command, extensions: [".ts"] }],
  ])

const waitForExit = (pid: number) =>
  Effect.promise(async () => {
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      try {
        process.kill(pid, 0)
      } catch {
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    throw new Error(`process ${pid} still alive after sweep shutdown`)
  })

describe("LSP periodic idle sweep", () => {
  it.live(
    "shuts down idle servers without a file touch",
    () =>
      Effect.gen(function* () {
        // Small sweep interval via env, read when this instance's LSP state
        // is first built below. Scoped so nothing else observes it.
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            const prev = process.env.BANYANCODE_LSP_SWEEP_MS
            process.env.BANYANCODE_LSP_SWEEP_MS = "25"
            return prev
          }),
          (prev) =>
            Effect.sync(() => {
              if (prev === undefined) delete process.env.BANYANCODE_LSP_SWEEP_MS
              else process.env.BANYANCODE_LSP_SWEEP_MS = prev
            }),
        )
        const dir = yield* tmpdirScoped()
        const file = path.join(dir, "sweep.ts")
        yield* Effect.promise(() => fs.writeFile(file, "export const x = 1\n"))
        const store = yield* InstanceStore.Service
        yield* store.provide(
          { directory: dir },
          Effect.gen(function* () {
            const lsp = yield* LSP.Service
            const banyanConfig = yield* Banyan.BanyanConfigService
            // Phase 1: generous idle timeout so spawn + open can never race
            // the sweep before the first assertion, even on a loaded host.
            yield* banyanConfig.update({
              banyancode_lsp: onlyFake([process.execPath, fakeServerPath]),
              banyancode_lsp_idle_timeout_ms: 2000,
            })
            yield* lsp.reload()
            yield* lsp.touchFile(file)
            const connected = (yield* lsp.status()).filter((s) => s.id === "fake" && s.status === "connected")
            expect(connected.length).toBe(1)
            const pid = connected[0]?.pid
            expect(typeof pid).toBe("number")
            // Phase 2: shrink the timeout. reload() preserves the live client
            // but does not refresh lastActivity, so the sweep must retire the
            // idle client alone, with no further file touches.
            yield* banyanConfig.update({ banyancode_lsp_idle_timeout_ms: 50 })
            yield* lsp.reload()
            yield* pollWithTimeout(
              Effect.gen(function* () {
                const current = yield* lsp.status()
                return current.some((s) => s.id === "fake" && s.status === "connected")
                  ? undefined
                  : (true as const)
              }),
              "sweep never shut down the idle server",
            )
            yield* waitForExit(pid as number)
          }),
        )
      }),
    30000,
  )
})
