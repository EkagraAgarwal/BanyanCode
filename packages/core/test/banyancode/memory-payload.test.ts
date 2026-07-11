import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import { Banyan } from "@opencode-ai/core/banyancode"
import {
  encodeMemoryValue,
  looksLikeMemoryPayload,
  payloadBody,
  payloadFingerprint,
  unwrapMemoryValue,
  type MemoryPayloadV1,
} from "@opencode-ai/core/banyancode/memory-payload"
import { tmpdir } from "../fixture/tmpdir"
import path from "path"

const samplePayload: MemoryPayloadV1 = {
  kind: "preference",
  title: "Use Bun runtime",
  body: "Project runs on Bun, not Node.",
  source: { type: "user" },
  confidence: "high",
  importance: "high",
  status: "active",
  tags: ["runtime", "bun"],
}

describe("MemoryPayloadV1 envelope", () => {
  test("encodeMemoryValue produces a versioned envelope", () => {
    const env = encodeMemoryValue(samplePayload)
    expect(env._v).toBe(1)
    expect(env.data).toEqual(samplePayload)
  })

  test("unwrapMemoryValue returns the inner payload for an envelope", () => {
    const env = encodeMemoryValue(samplePayload)
    expect(unwrapMemoryValue(env)).toEqual(samplePayload)
  })

  test("unwrapMemoryValue accepts a bare structured payload", () => {
    expect(unwrapMemoryValue(samplePayload)).toEqual(samplePayload)
  })

  test("unwrapMemoryValue synthesizes an observation from a plain string", () => {
    const result = unwrapMemoryValue("just a note", "note-key")
    expect(result.kind).toBe("observation")
    expect(result.title).toBe("note-key")
    expect(result.body).toBe("just a note")
    expect(result.source.type).toBe("system")
    expect(result.confidence).toBe("low")
    expect(result.importance).toBe("low")
    expect(result.status).toBe("active")
  })

  test("unwrapMemoryValue synthesizes an observation from arbitrary JSON", () => {
    const result = unwrapMemoryValue({ foo: "bar", n: 42 }, "legacy-key")
    expect(result.kind).toBe("observation")
    expect(result.title).toBe("legacy-key")
    expect(result.body).toBe(JSON.stringify({ foo: "bar", n: 42 }))
  })

  test("looksLikeMemoryPayload discriminates envelope and bare payloads", () => {
    expect(looksLikeMemoryPayload(encodeMemoryValue(samplePayload))).toBe(true)
    expect(looksLikeMemoryPayload(samplePayload)).toBe(true)
    expect(looksLikeMemoryPayload("string")).toBe(false)
    expect(looksLikeMemoryPayload({ unrelated: true })).toBe(false)
  })

  test("payloadFingerprint normalizes kind+title", () => {
    const a = { ...samplePayload, title: "Use Bun Runtime" }
    const b = { ...samplePayload, title: "use bun runtime" }
    expect(payloadFingerprint(a)).toBe(payloadFingerprint(b))
  })

  test("payloadBody returns the body verbatim", () => {
    expect(payloadBody(samplePayload)).toBe(samplePayload.body)
  })
})

describe("MemoryRepo envelope round-trip + denormalized columns", () => {
  test("put wraps legacy values and fills denorm columns", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "memory-payload.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)
    const memoryLayer = Banyan.memoryRepoLayer

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const repo = yield* Banyan.MemoryRepo

        yield* repo.put({
          id: "legacy-1",
          key: "legacy-key",
          value: { free: "form" },
          tags: ["legacy"],
          scope: "global",
          createdAt: 1700000000000,
        })

        const entry = yield* repo.get("legacy-1")
        expect(entry).toBeDefined()
        expect(entry!.kind).toBe("observation")
        expect(entry!.title).toBe("legacy-key")
        expect(entry!.status).toBe("active")
        expect(entry!.body).toBe(JSON.stringify({ free: "form" }))
        // value is wrapped in an envelope, not stored as raw JSON.
        expect((entry!.value as { _v?: number })._v).toBe(1)
      }).pipe(Effect.provide(memoryLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("put on a typed payload preserves kind / title / body / status", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "memory-payload2.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)
    const memoryLayer = Banyan.memoryRepoLayer

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const repo = yield* Banyan.MemoryRepo

        yield* repo.put({
          id: "typed-1",
          key: "user:prefer-bun",
          value: samplePayload,
          tags: samplePayload.tags ? [...samplePayload.tags] : [],
          scope: "global",
        })

        const entry = yield* repo.get("typed-1")
        expect(entry).toBeDefined()
        expect(entry!.kind).toBe("preference")
        expect(entry!.title).toBe("Use Bun runtime")
        expect(entry!.body).toBe("Project runs on Bun, not Node.")
        expect(entry!.status).toBe("active")
        expect(entry!.namespace).toBe("user")
      }).pipe(Effect.provide(memoryLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("update fills denorm columns from a new typed payload", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "memory-payload3.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)
    const memoryLayer = Banyan.memoryRepoLayer

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const repo = yield* Banyan.MemoryRepo

        yield* repo.put({
          id: "u-1",
          key: "decision:database",
          value: { raw: true },
          scope: "global",
        })

        const newPayload: MemoryPayloadV1 = {
          kind: "decision",
          title: "Use Turso",
          body: "Storage backend is Turso/libSQL.",
          source: { type: "agent" },
          confidence: "high",
          importance: "high",
          status: "active",
        }

        const updated = yield* repo.update({
          id: "u-1",
          expectedVersion: 1,
          value: newPayload,
        })
        expect(updated.kind).toBe("decision")
        expect(updated.title).toBe("Use Turso")
        expect(updated.body).toBe("Storage backend is Turso/libSQL.")
        expect(updated.status).toBe("active")
      }).pipe(Effect.provide(memoryLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("update without a new value keeps denorm columns stable", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "memory-payload4.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)
    const memoryLayer = Banyan.memoryRepoLayer

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const repo = yield* Banyan.MemoryRepo

        yield* repo.put({
          id: "u-2",
          key: "decision:logging",
          value: samplePayload,
          scope: "global",
        })

        const updated = yield* repo.update({
          id: "u-2",
          expectedVersion: 1,
          tags: ["runtime", "bun", "explicit"],
        })
        expect(updated.kind).toBe(samplePayload.kind)
        expect(updated.title).toBe(samplePayload.title)
        expect(updated.tags).toEqual(["runtime", "bun", "explicit"])
      }).pipe(Effect.provide(memoryLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })
})