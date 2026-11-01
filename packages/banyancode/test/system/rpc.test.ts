import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { BanyanConfig } from "../../src/config/index.js"
import { parseJsonc } from "../../src/config/jsonc.js"
import { Definition, handlers } from "../../src/system/rpc.js"
import type { SystemMonitor } from "../../src/system/monitor.js"

const withTemp = async (fn: (directory: string) => Promise<void>) => {
  const directory = await mkdtemp(join(tmpdir(), "banyancode-system-rpc-"))
  try {
    await fn(directory)
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

const monitor: SystemMonitor = {
  status: async () => ({
    cpuPercent: 1,
    memoryUsedBytes: 2,
    memoryTotalBytes: 4,
    platform: "linux",
  }),
}

const run = <A>(effect: Effect.Effect<A, unknown>) => Effect.runPromise(effect as Effect.Effect<A>)

describe("banyancode.system RPC", () => {
  test("definition matches the v1 route mapping", () => {
    expect(Definition.id).toBe("banyancode.system")
    expect(Object.keys(Definition.methods).sort()).toEqual(
      [
        "config.agentOverride",
        "config.agentPrompt",
        "config.agentSave",
        "lsp.status",
        "status",
        "yolo.get",
        "yolo.set",
      ].sort(),
    )
    expect(Object.keys(Definition.events)).toEqual(["updated"])
  })

  test("status, lsp.status and yolo get/set use the real config service", async () => {
    await withTemp(async (directory) => {
      const globalDir = join(directory, "global")
      await import("node:fs/promises").then((fs) => fs.mkdir(globalDir, { recursive: true }))
      const file = join(globalDir, "banyancode.json")
      await writeFile(file, '{\n  // kept\n  "banyancode_lsp": true,\n  "banyancode_lsp_idle_timeout_ms": 1000\n}\n')
      const config = BanyanConfig.make({ directory, projectRoot: directory, globalDir })
      let reloads = 0
      const rpc = handlers({
        config,
        monitor,
        target: { globalDir, directory, projectRoot: directory },
        reloadAgents: () => Effect.sync(() => void (reloads += 1)),
      })

      expect(await run(rpc.status({}, undefined as never))).toMatchObject({ cpuPercent: 1, platform: "linux" })
      const lsp = await run(rpc["lsp.status"]({}, undefined as never))
      expect(lsp).toMatchObject({ enabled: true, idleTimeoutMs: 1000, servers: [] })
      expect(await run(rpc["yolo.get"]({}, undefined as never))).toEqual({ enabled: false, env: false, config: false })

      const set = await run(rpc["yolo.set"]({ enabled: true }, undefined as never))
      expect(set).toEqual({ enabled: true, env: false, config: true })
      expect(reloads).toBe(1)
      expect(await readFile(file, "utf8")).toContain("// kept")
      expect(parseJsonc(await readFile(file, "utf8"))).toMatchObject({ banyancode_yolo_mode: true })
    })
  })

  test("agent override, prompt and save write through the config layer", async () => {
    await withTemp(async (directory) => {
      const globalDir = join(directory, "global")
      await import("node:fs/promises").then((fs) => fs.mkdir(globalDir, { recursive: true }))
      const file = join(globalDir, "banyancode.json")
      await writeFile(file, '{ "agent": { "coder": { "thinking": "high" } } }\n')
      const config = BanyanConfig.make({ directory, projectRoot: directory, globalDir })
      const rpc = handlers({
        config,
        monitor,
        target: { globalDir, directory, projectRoot: directory },
        reloadAgents: () => Effect.void,
      })

      const overridden = await run(
        rpc["config.agentOverride"](
          { name: "coder", enabled: true, model: { providerID: "openai", modelID: "gpt-5" }, thinking: "max" },
          undefined as never,
        ),
      )
      expect(overridden.agent?.coder).toMatchObject({
        enabled: true,
        model: "openai/gpt-5",
        thinking: "max",
      })

      const prompted = await run(
        rpc["config.agentPrompt"]({ name: "coder", prompt: "Focused coder." }, undefined as never),
      )
      expect(prompted.agent?.coder?.prompt).toBe("Focused coder.")

      const saved = await run(
        rpc["config.agentSave"](
          { name: "reviewer-pro", description: "Reviews", prompt: "Review the diff." },
          undefined as never,
        ),
      )
      expect(saved.ok).toBe(true)
      expect(saved.filePath).toBe(join(globalDir, "agent", "reviewer-pro.md"))
      expect(await readFile(saved.filePath, "utf8")).toContain("Review the diff.")
    })
  })
})
