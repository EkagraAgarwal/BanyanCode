import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import path from "node:path"
import { utimesSync, writeFileSync } from "node:fs"
import { Database } from "@opencode-ai/core/database/database"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import { AgentEfficiencyTelemetry } from "@opencode-ai/core/banyancode/agent-efficiency-telemetry"
import { AgentEfficiencyTelemetryRepo } from "@opencode-ai/core/banyancode/agent-efficiency-telemetry-repo"
import { tmpdir } from "../fixture/tmpdir"

const event = (id: string, occurredAt = Date.now()) => ({
  schemaVersion: 1 as const,
  eventID: id,
  eventType: "run.finished" as const,
  occurredAt,
  runID: "run-1",
  sessionID: "session-1",
  metadata: {
    provider: "value",
    prompt: "must not be stored",
    input: "raw input must not be stored",
    input_tokens: 5,
    total_cost: 1.25,
    nested: { path: "C:\\secret" },
  },
})

const run = (
  dbPath: string,
  body: (telemetry: AgentEfficiencyTelemetry.Interface) => Effect.Effect<void, unknown, never>,
  options: AgentEfficiencyTelemetry.Options = { maxEvents: 2 },
) => {
  const telemetryLayer = AgentEfficiencyTelemetry.layer(options).pipe(Layer.provide(AgentEfficiencyTelemetryRepo.layer))
  return Effect.runPromise(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* DatabaseMigration.apply(db)
      const telemetry = yield* AgentEfficiencyTelemetry.Service
      yield* body(telemetry)
    }).pipe(Effect.provide(telemetryLayer), Effect.provide(Database.layerFromPath(dbPath)), Effect.scoped),
  )
}

describe("AgentEfficiencyTelemetry", () => {
  test("sanitizes metadata and idempotently appends", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "telemetry.sqlite")
    await run(dbPath, (telemetry) => Effect.gen(function* () {
       yield* telemetry.record(event("event-1"))
       yield* telemetry.record(event("event-1"))
       yield* (telemetry.flush?.() ?? Effect.void)
       expect(yield* telemetry.count()).toBe(1)
      const [stored] = yield* telemetry.recent()
       expect(stored?.metadata).toEqual({ provider: "value", input_tokens: 5, total_cost: 1.25, nested: {} })
    }))
  })

  test("retains only the configured newest events", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "bounded.sqlite")
    const now = Date.now()
    await run(dbPath, (telemetry) => Effect.gen(function* () {
       yield* telemetry.record({ ...event("event-1", now), eventType: "run.started" })
       yield* telemetry.record({ ...event("event-2", now + 1), eventType: "tool.started" })
       yield* telemetry.record({ ...event("event-3", now + 2), eventType: "finding.recorded" })
       yield* (telemetry.flush?.() ?? Effect.void)
       expect((yield* telemetry.recent()).map((item) => item.eventID)).toEqual(["event-2", "event-3"])
    }))
  })

  test("does not write when disabled", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "disabled.sqlite")
    await run(
      dbPath,
      (telemetry) =>
        Effect.gen(function* () {
          yield* telemetry.record(event("event-disabled"))
          yield* (telemetry.flush?.() ?? Effect.void)
          expect(yield* telemetry.count()).toBe(0)
        }),
      { enabled: false, maxEvents: 2 },
    )
  })

  test("preserves terminal events while bounding verbose events", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "terminal.sqlite")
    const now = Date.now()
    await run(dbPath, (telemetry) => Effect.gen(function* () {
      yield* telemetry.record({ ...event("verbose-1", now), eventType: "run.started" })
      yield* telemetry.record({ ...event("failed", now + 1), eventType: "run.failed", status: "failed" })
      yield* telemetry.record({ ...event("verbose-2", now + 2), eventType: "tool.started" })
      yield* (telemetry.flush?.() ?? Effect.void)
      expect((yield* telemetry.recent()).map((item) => item.eventID)).toEqual(["failed", "verbose-2"])
    }), { maxEvents: 1, retentionMs: 1_000_000_000_000 })
  })

  test("rejects embedded paths and machine identifiers but keeps numeric metrics", async () => {
    const sanitized = AgentEfficiencyTelemetry.sanitizeAgentEfficiencyEvent({
      ...event("C:\\Users\\alice\\event"),
      runID: "C:\\Users\\alice\\run",
      metadata: {
        absolute: "prefix C:\\Users\\alice\\secret.txt suffix",
        relative: "../../private/secret",
        machine: "hostname: build-box",
        input_tokens: 12,
        total_cost: 0.5,
      },
    })
    expect(sanitized.metadata).toEqual({ input_tokens: 12, total_cost: 0.5 })
    expect(AgentEfficiencyTelemetry.sanitizeAgentEfficiencyEvent(sanitized).runID).toBe(sanitized.runID)
    expect(AgentEfficiencyTelemetry.sanitizeAgentEfficiencyEvent(sanitized).eventID).toBe(sanitized.eventID)
  })

  test("replaces a corrupted local key and reuses the replacement", async () => {
    await using tmp = await tmpdir()
    const keyPath = path.join(tmp.path, "agent-telemetry.key")
    writeFileSync(keyPath, "z".repeat(64))
    const replacement = AgentEfficiencyTelemetry.loadAgentTelemetryKey(keyPath)
    expect(replacement).toMatch(/^[0-9a-f]{64}$/i)
    expect(AgentEfficiencyTelemetry.loadAgentTelemetryKey(keyPath)).toBe(replacement)
  })

  test("takes over a stale lock owned by a dead process", async () => {
    await using tmp = await tmpdir()
    const keyPath = path.join(tmp.path, "agent-telemetry.key")
    const lockPath = `${keyPath}.lock`
    writeFileSync(keyPath, "z".repeat(64))
    writeFileSync(lockPath, "999999:dead-owner")
    utimesSync(lockPath, new Date(0), new Date(0))
    const replacement = AgentEfficiencyTelemetry.loadAgentTelemetryKey(keyPath)
    expect(replacement).toMatch(/^[0-9a-f]{64}$/i)
    expect(AgentEfficiencyTelemetry.loadAgentTelemetryKey(keyPath)).toBe(replacement)
  })
})
