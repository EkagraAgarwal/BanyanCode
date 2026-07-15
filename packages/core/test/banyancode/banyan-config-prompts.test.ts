import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import { Banyan } from "@opencode-ai/core/banyancode"
import { Database } from "@opencode-ai/core/database/database"
import { Global } from "@opencode-ai/core/global"

const CONFIG_PATH = path.join(Global.Path.banyan.config, "banyancode.json")

describe("BanyanConfigService.updateAgentPrompt", () => {
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
    dbPath = path.join(os.tmpdir(), "banyan-config-prompts-test-" + Math.random().toString(36).slice(2) + ".sqlite")
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

  test("upserts prompt for new agent", async () => {
    const layer = buildLayer()
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* Banyan.BanyanConfigService
        return yield* svc.updateAgentPrompt("coder", "new prompt for coder")
      }).pipe(Effect.provide(layer)),
    )

    expect(result.agent).toEqual({ coder: { prompt: "new prompt for coder" } })

    const onDisk = JSON.parse(await Bun.file(CONFIG_PATH).text())
    expect(onDisk.agent).toEqual({ coder: { prompt: "new prompt for coder" } })
  })

  test("subsequent updates overwrite existing entry", async () => {
    const layer1 = buildLayer()
    await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* Banyan.BanyanConfigService
        return yield* svc.updateAgentPrompt("coder", "first prompt")
      }).pipe(Effect.provide(layer1)),
    )

    const layer2 = buildLayer()
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* Banyan.BanyanConfigService
        return yield* svc.updateAgentPrompt("coder", "second prompt")
      }).pipe(Effect.provide(layer2)),
    )

    expect(result.agent).toEqual({ coder: { prompt: "second prompt" } })

    const onDisk = JSON.parse(await Bun.file(CONFIG_PATH).text())
    expect(onDisk.agent).toEqual({ coder: { prompt: "second prompt" } })
  })

  test("preserves other top-level keys", async () => {
    // Pre-populate with yolo_mode and agent_overrides
    await writeConfig({
      banyancode_yolo_mode: true,
      agent: { explorer: { enabled: false } },
    })

    const layer = buildLayer()
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* Banyan.BanyanConfigService
        return yield* svc.updateAgentPrompt("coder", "coder's new prompt")
      }).pipe(Effect.provide(layer)),
    )

    expect(result.banyancode_yolo_mode).toBe(true)
    expect(result.agent).toEqual({
      explorer: { enabled: false },
      coder: { prompt: "coder's new prompt" },
    })
  })
})
