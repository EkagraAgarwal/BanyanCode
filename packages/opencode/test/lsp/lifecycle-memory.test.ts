import { describe, expect, test } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { Effect, Layer, Ref, Schema } from "effect"
import { LSP } from "@/lsp/lsp"
import * as LSPServer from "@/lsp/server"
import { resolveLspIdleTimeoutMs } from "@/lsp/lsp"
import { BanyanConfig } from "@opencode-ai/core/v1/config/banyan-config"
import { ConfigLSPV1 } from "@opencode-ai/core/v1/config/lsp"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

import { Banyan } from "@opencode-ai/core/banyancode"

// In-memory BanyanConfigService so these tests never touch the shared global
// banyancode.json on disk (other LSP test files assume ambient global state).
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

const it = testEffect(Layer.mergeAll(LSP.defaultLayer, CrossSpawnSpawner.defaultLayer, memoryBanyanLayer))

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
    throw new Error(`process ${pid} still alive after reload shutdown`)
  })

describe("LSP memory controls", () => {
  test("resolveLspIdleTimeoutMs() defaults, disables, and floors", () => {
    expect(resolveLspIdleTimeoutMs(undefined)).toBe(LSP.DEFAULT_LSP_IDLE_TIMEOUT_MS)
    expect(resolveLspIdleTimeoutMs("fast")).toBe(LSP.DEFAULT_LSP_IDLE_TIMEOUT_MS)
    expect(resolveLspIdleTimeoutMs(-10)).toBe(LSP.DEFAULT_LSP_IDLE_TIMEOUT_MS)
    expect(resolveLspIdleTimeoutMs(0)).toBe(0)
    expect(resolveLspIdleTimeoutMs(1500.9)).toBe(1500)
  })

  test("resolveTypescriptMaxMemoryMb() falls back to a conservative default", () => {
    expect(LSPServer.resolveTypescriptMaxMemoryMb(undefined)).toBe(LSPServer.DEFAULT_TSSERVER_MAX_MEMORY_MB)
    expect(LSPServer.resolveTypescriptMaxMemoryMb("4gb")).toBe(LSPServer.DEFAULT_TSSERVER_MAX_MEMORY_MB)
    expect(LSPServer.resolveTypescriptMaxMemoryMb(-512)).toBe(LSPServer.DEFAULT_TSSERVER_MAX_MEMORY_MB)
    expect(LSPServer.resolveTypescriptMaxMemoryMb(4096)).toBe(4096)
  })

  test("banyan config accepts lsp memory and idle options", () => {
    const config = Schema.decodeSync(BanyanConfig.Info)({
      banyancode_lsp: { typescript: { maxMemoryMb: 4096, extensions: [".ts"] } },
      banyancode_lsp_idle_timeout_ms: 60000,
    })
    expect(config.banyancode_lsp_idle_timeout_ms).toBe(60000)
    const entry = Schema.decodeSync(ConfigLSPV1.Entry)({
      command: ["my-lsp", "--stdio"],
      extensions: [".my"],
      maxMemoryMb: 1024,
      idleTimeoutMs: 5000,
    })
    expect(entry).toMatchObject({ maxMemoryMb: 1024, idleTimeoutMs: 5000 })
  })

  test("Typescript.spawn() stays optional without binaries", async () => {
    const result = await LSPServer.Typescript.spawn(process.cwd(), { directory: process.cwd() } as never, {} as never)
    if (result) {
      const tsserver = result.initialization?.["tsserver"] as Record<string, unknown> | undefined
      expect(typeof tsserver?.["maxTsServerMemory"]).toBe("number")
    } else {
      expect(result).toBeUndefined()
    }
  })

  it.instance(
    "idle shutdown stops the client and the next touch restarts it",
    () =>
      LSP.Service.use((lsp) =>
        Effect.gen(function* () {
          const dir = (yield* TestInstance).directory
          const file = path.join(dir, "idle.ts")
          yield* Effect.promise(() => fs.writeFile(file, "export const x = 1\n"))
          const banyanConfig = yield* Banyan.BanyanConfigService
          yield* banyanConfig.update({
            banyancode_lsp: onlyFake([process.execPath, fakeServerPath]),
            banyancode_lsp_idle_timeout_ms: 50,
          })
          yield* lsp.reload()
          yield* lsp.touchFile(file)
          const connected = (yield* lsp.status()).filter((s) => s.id === "fake" && s.status === "connected")
          expect(connected.length).toBe(1)
          expect(connected[0]?.clientCount).toBe(1)
          const firstPid = connected[0]?.pid
          expect(typeof firstPid).toBe("number")
          yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 150)))
          yield* lsp.touchFile(file)
          const restarted = (yield* lsp.status()).filter((s) => s.id === "fake" && s.status === "connected")
          expect(restarted.length).toBe(1)
          expect(typeof restarted[0]?.pid).toBe("number")
          expect(restarted[0]?.pid).not.toBe(firstPid)
        }),
      ),
    30000,
  )

  it.instance(
    "reload() removes disabled servers and shuts clients down",
    () =>
      LSP.Service.use((lsp) =>
        Effect.gen(function* () {
          const dir = (yield* TestInstance).directory
          const file = path.join(dir, "reload.ts")
          yield* Effect.promise(() => fs.writeFile(file, "export const y = 2\n"))
          const banyanConfig = yield* Banyan.BanyanConfigService
          yield* banyanConfig.update({
            banyancode_lsp: onlyFake([process.execPath, fakeServerPath]),
            banyancode_lsp_idle_timeout_ms: 0,
          })
          yield* lsp.reload()
          yield* lsp.touchFile(file)
          const connected = (yield* lsp.status()).filter((s) => s.id === "fake" && s.status === "connected")
          expect(connected.length).toBe(1)
          const pid = connected[0]?.pid
          expect(typeof pid).toBe("number")
          yield* banyanConfig.update({ banyancode_lsp: { fake: { disabled: true } } })
          yield* lsp.reload()
          const after = yield* lsp.status()
          expect(after.filter((s) => s.id === "fake" && s.status === "connected").length).toBe(0)
          expect(after.filter((s) => s.id === "fake" && s.disabled).length).toBe(1)
          yield* waitForExit(pid as number)
          yield* lsp.reload()
          const settled = yield* lsp.status()
          expect(settled.filter((s) => s.id === "fake" && s.status === "connected").length).toBe(0)
        }),
      ),
    30000,
  )
})
