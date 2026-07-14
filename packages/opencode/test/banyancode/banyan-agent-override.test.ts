import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import { Banyan } from "@opencode-ai/core/banyancode"
import { Database } from "@opencode-ai/core/database/database"
import { Global } from "@opencode-ai/core/global"
import { BanyanAgentOverrideUpdateInput } from "../../src/server/routes/instance/httpapi/groups/global"

const CONFIG_PATH = path.join(Global.Path.banyan.config, "banyancode.json")

describe("BanyanAgentOverrideUpdateInput schema validation", () => {
  const decodePromise = (input: unknown) =>
    Effect.runPromise(
      Schema.decodeUnknownExit(BanyanAgentOverrideUpdateInput)(input).pipe(
        Effect.map((value) => ({ ok: true as const, value })),
        Effect.catch((error) => Effect.succeed({ ok: false as const, error })),
      ),
    )

  test("accepts valid agent name", async () => {
    const result = await decodePromise({ name: "coder" })
    expect(result.ok).toBe(true)
  })

  test("accepts name with dots, underscores, hyphens", async () => {
    const result = await decodePromise({ name: "my_agent.v2-beta" })
    expect(result.ok).toBe(true)
  })

  test("rejects name with path traversal", async () => {
    const result = await decodePromise({ name: "../../../etc/passwd" })
    expect(result.ok).toBe(false)
  })

  test("rejects name with forward slash", async () => {
    const result = await decodePromise({ name: "foo/bar" })
    expect(result.ok).toBe(false)
  })

  test("rejects empty name", async () => {
    const result = await decodePromise({ name: "" })
    expect(result.ok).toBe(false)
  })

  test("accepts enabled toggle", async () => {
    const result = await decodePromise({ name: "coder", enabled: false })
    expect(result.ok).toBe(true)
  })

  test("accepts model override", async () => {
    const result = await decodePromise({
      name: "coder",
      model: { providerID: "minimax-coding-plan", modelID: "MiniMax-M3" },
    })
    expect(result.ok).toBe(true)
  })

  test("accepts null model (clear)", async () => {
    const result = await decodePromise({ name: "coder", model: null })
    expect(result.ok).toBe(true)
  })

  test("rejects providerID longer than 128 chars", async () => {
    const result = await decodePromise({
      name: "coder",
      model: { providerID: "x".repeat(129), modelID: "y" },
    })
    expect(result.ok).toBe(false)
  })

  test("rejects modelID longer than 128 chars", async () => {
    const result = await decodePromise({
      name: "coder",
      model: { providerID: "x", modelID: "y".repeat(129) },
    })
    expect(result.ok).toBe(false)
  })
})

describe("BanyanConfigService.updateAgentOverride", () => {
  let backupContent: string | null = null
  let backupExists = false
  let dbPath: string

  beforeEach(async () => {
    await fs.mkdir(Global.Path.banyan.config, { recursive: true })
    try {
      backupContent = await Bun.file(CONFIG_PATH).text()
      backupExists = true
    } catch {
      backupExists = false
    }
    dbPath = path.join(os.tmpdir(), "banyan-agent-override-test-" + Math.random().toString(36).slice(2) + ".sqlite")
  })

  afterEach(async () => {
    try {
      await fs.unlink(CONFIG_PATH)
    } catch {}
    if (backupExists && backupContent !== null) {
      await Bun.write(CONFIG_PATH, backupContent)
    }
    try {
      await fs.rm(dbPath, { recursive: true, force: true })
    } catch {}
  })

  function buildLayer() {
    return Layer.mergeAll(
      Database.layerFromPath(dbPath),
      Banyan.banyanConfigServiceDefaultLayer,
    )
  }

  async function writeConfig(config: Record<string, unknown>): Promise<void> {
    await fs.mkdir(path.dirname(CONFIG_PATH), { recursive: true })
    await Bun.write(CONFIG_PATH, JSON.stringify(config, null, 2))
  }

  test("happy path - enabled toggle", async () => {
    const layer = buildLayer()
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* Banyan.BanyanConfigService
        return yield* svc.updateAgentOverride("coder", { enabled: false })
      }).pipe(Effect.provide(layer)),
    )

    expect(result.banyancode_agent_overrides).toEqual([{ name: "coder", enabled: false }])

    const onDisk = JSON.parse(await Bun.file(CONFIG_PATH).text())
    expect(onDisk.banyancode_agent_overrides).toEqual([{ name: "coder", enabled: false }])
  })

  test("happy path - model override", async () => {
    const layer = buildLayer()
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* Banyan.BanyanConfigService
        return yield* svc.updateAgentOverride("coder", {
          model: { providerID: "minimax-coding-plan", modelID: "MiniMax-M3" },
        })
      }).pipe(Effect.provide(layer)),
    )

    expect(result.banyancode_agent_overrides).toEqual([
      { name: "coder", model: { providerID: "minimax-coding-plan", modelID: "MiniMax-M3" } },
    ])
  })

  test("clear model with null", async () => {
    // First set enabled + model
    await writeConfig({
      banyancode_agent_overrides: [
        { name: "coder", enabled: true, model: { providerID: "p", modelID: "m" } },
      ],
    })

    const layer = buildLayer()
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* Banyan.BanyanConfigService
        return yield* svc.updateAgentOverride("coder", { model: null })
      }).pipe(Effect.provide(layer)),
    )

    // Model should be removed, enabled should be preserved
    expect(result.banyancode_agent_overrides).toEqual([{ name: "coder", enabled: true }])
  })

  test("upsert existing entry", async () => {
    // First set enabled: false
    const layer1 = buildLayer()
    await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* Banyan.BanyanConfigService
        return yield* svc.updateAgentOverride("coder", { enabled: false })
      }).pipe(Effect.provide(layer1)),
    )

    // Then set model
    const layer2 = buildLayer()
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* Banyan.BanyanConfigService
        return yield* svc.updateAgentOverride("coder", {
          model: { providerID: "minimax", modelID: "M3" },
        })
      }).pipe(Effect.provide(layer2)),
    )

    // Should have single entry with both fields
    expect(result.banyancode_agent_overrides).toEqual([
      { name: "coder", enabled: false, model: { providerID: "minimax", modelID: "M3" } },
    ])
  })

  test("preserves other top-level keys", async () => {
    // Pre-populate with yolo_mode and subagents
    await writeConfig({
      banyancode_yolo_mode: true,
      banyancode_subagents: [{ name: "custom-agent", mode: "subagent" as const, filePath: "/path/to/agent.md" }],
    })

    const layer = buildLayer()
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* Banyan.BanyanConfigService
        return yield* svc.updateAgentOverride("coder", { enabled: false })
      }).pipe(Effect.provide(layer)),
    )

    expect(result.banyancode_yolo_mode).toBe(true)
    expect(result.banyancode_subagents).toEqual([{ name: "custom-agent", mode: "subagent", filePath: "/path/to/agent.md" }])
    expect(result.banyancode_agent_overrides).toEqual([{ name: "coder", enabled: false }])
  })

  // Note: schema validation for invalid names happens at the HTTP handler layer,
  // not at the BanyanConfigService level. The service accepts any non-empty string.
  test("service accepts any non-empty name string", async () => {
    const layer = buildLayer()
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* Banyan.BanyanConfigService
        return yield* svc.updateAgentOverride("../etc/passwd", { enabled: false })
      }).pipe(Effect.provide(layer)),
    )
    // The service writes whatever name is given; HTTP layer would reject this
    expect(result.banyancode_agent_overrides).toEqual([{ name: "../etc/passwd", enabled: false }])
  })
})