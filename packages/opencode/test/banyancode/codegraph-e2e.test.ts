import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import { Banyan } from "@opencode-ai/core/banyancode"
import { Database } from "@opencode-ai/core/database/database"
import { Global } from "@opencode-ai/core/global"

process.env.BANYANCODE_ENABLE = "1"

const CONFIG_PATH = path.join(Global.Path.banyan.config, "banyancode.json")

let backupContent: string | null = null
let backupExists = false

beforeAll(async () => {
  await fs.mkdir(Global.Path.banyan.config, { recursive: true })
  try {
    backupContent = await Bun.file(CONFIG_PATH).text()
    backupExists = true
  } catch {
    backupExists = false
  }
})

afterEach(async () => {
  try {
    await fs.unlink(CONFIG_PATH)
  } catch {}
  if (backupExists && backupContent !== null) {
    await Bun.write(CONFIG_PATH, backupContent)
  }
})

afterAll(async () => {
  if (backupExists && backupContent !== null) {
    await Bun.write(CONFIG_PATH, backupContent)
  } else {
    try {
      await fs.unlink(CONFIG_PATH)
    } catch {}
  }
})

async function writeConfig(config: Record<string, unknown>): Promise<void> {
  await fs.mkdir(path.dirname(CONFIG_PATH), { recursive: true })
  await Bun.write(CONFIG_PATH, JSON.stringify(config, null, 2))
}

function buildLayer(dbPath: string) {
  return Layer.mergeAll(
    Database.layerFromPath(dbPath),
    Banyan.banyanConfigServiceDefaultLayer,
  )
}

function makeTmpDbPath(): string {
  return path.join(os.tmpdir(), "banyan-config-test-" + Math.random().toString(36).slice(2) + ".sqlite")
}

describe("BanyanConfigService - reads banyancode.json from disk", () => {
  test("get() returns empty when banyancode.json does not exist", async () => {
    const dbPath = makeTmpDbPath()
    const layer = buildLayer(dbPath)
    const config = await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* Banyan.BanyanConfigService
        return yield* svc.get()
      }).pipe(Effect.provide(layer)),
    )
    expect(config).toEqual({})
  })

  test("get() reads banyancode_yolo_mode from disk", async () => {
    await writeConfig({ banyancode_yolo_mode: true })
    const dbPath = makeTmpDbPath()
    const layer = buildLayer(dbPath)
    const config = await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* Banyan.BanyanConfigService
        return yield* svc.get()
      }).pipe(Effect.provide(layer)),
    )
    expect(config.banyancode_yolo_mode).toBe(true)
  })

  test("get() reads multiple keys at once", async () => {
    await writeConfig({
      banyancode_yolo_mode: false,
      banyancode_disable_websearch: true,
    })
    const dbPath = makeTmpDbPath()
    const layer = buildLayer(dbPath)
    const config = await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* Banyan.BanyanConfigService
        return yield* svc.get()
      }).pipe(Effect.provide(layer)),
    )
    expect(config.banyancode_yolo_mode).toBe(false)
    expect(config.banyancode_disable_websearch).toBe(true)
  })

  test("get() returns empty when file is malformed JSON", async () => {
    await fs.mkdir(path.dirname(CONFIG_PATH), { recursive: true })
    await Bun.write(CONFIG_PATH, "{ this is not valid JSON")
    const dbPath = makeTmpDbPath()
    const layer = buildLayer(dbPath)
    const config = await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* Banyan.BanyanConfigService
        return yield* svc.get()
      }).pipe(Effect.provide(layer)),
    )
    expect(config).toEqual({})
  })
})

describe("BanyanConfigService - writes to disk", () => {
  test("update() merges with existing config on disk", async () => {
    await writeConfig({ banyancode_yolo_mode: false })
    const dbPath = makeTmpDbPath()
    const layer = buildLayer(dbPath)
    const updated = await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* Banyan.BanyanConfigService
        return yield* svc.update({ banyancode_disable_websearch: true })
      }).pipe(Effect.provide(layer)),
    )
    expect(updated.banyancode_yolo_mode).toBe(false)
    expect(updated.banyancode_disable_websearch).toBe(true)

    const onDisk = JSON.parse(await Bun.file(CONFIG_PATH).text())
    expect(onDisk.banyancode_yolo_mode).toBe(false)
    expect(onDisk.banyancode_disable_websearch).toBe(true)
  })

  test("update() creates file when none exists", async () => {
    const dbPath = makeTmpDbPath()
    const layer = buildLayer(dbPath)
    const updated = await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* Banyan.BanyanConfigService
        return yield* svc.update({
          banyancode_yolo_mode: true,
          banyancode_disable_websearch: true,
        })
      }).pipe(Effect.provide(layer)),
    )
    expect(updated.banyancode_yolo_mode).toBe(true)
    expect(updated.banyancode_disable_websearch).toBe(true)

    const onDisk = JSON.parse(await Bun.file(CONFIG_PATH).text())
    expect(onDisk.banyancode_yolo_mode).toBe(true)
    expect(onDisk.banyancode_disable_websearch).toBe(true)
  })

  test("update() returns the new merged config", async () => {
    const dbPath = makeTmpDbPath()
    const layer = buildLayer(dbPath)
    const updated = await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* Banyan.BanyanConfigService
        return yield* svc.update({
          banyancode_yolo_mode: true,
        })
      }).pipe(Effect.provide(layer)),
    )
    expect(updated.banyancode_yolo_mode).toBe(true)
  })
})
