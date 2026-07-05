/**
 * Phase 1.5 Tool Telemetry — service-level tests.
 *
 * Verifies the in-memory event store, the JSONL flush, and the aggregate
 * report. Phase 1.5 is purely observational: `repairs` and `warnings`
 * arrays stay empty on every snapshot.
 */

import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import path from "node:path"
import os from "node:os"
import fs from "node:fs/promises"
import {
  ToolTelemetry,
  type ToolRuntimeEvent,
} from "../../src/banyancode/tool-telemetry"

const sessionA = "ses_phase1_5_a"
const sessionB = "ses_phase1_5_b"
const toolCallID = "call_phase1_5"

const baseEvent = (
  overrides: Partial<ToolRuntimeEvent> = {},
): ToolRuntimeEvent => ({
  kind: "raw",
  toolID: "code_find",
  sessionID: sessionA,
  agent: "build",
  modelID: "unknown",
  toolCallID,
  rawInput: { query: "foo" },
  repairs: [],
  warnings: [],
  startedAt: Date.now(),
  ...overrides,
})

const fixtureRaw = (sid: string, tid: string): ToolRuntimeEvent =>
  baseEvent({ sessionID: sid, toolID: tid, kind: "raw" })

const fixtureExecuted = (
  sid: string,
  tid: string,
  latencyMs: number,
): ToolRuntimeEvent =>
  baseEvent({
    sessionID: sid,
    toolID: tid,
    kind: "executed",
    latencyMs,
    finishedAt: Date.now() + latencyMs,
    success: true,
  })

const fixtureFailed = (
  sid: string,
  tid: string,
  message: string,
): ToolRuntimeEvent =>
  baseEvent({
    sessionID: sid,
    toolID: tid,
    kind: "failed",
    latencyMs: 5,
    finishedAt: Date.now() + 5,
    success: false,
    errorMessage: message,
  })

const withTelemetry = <A>(
  effect: Effect.Effect<A, never, ToolTelemetry.Service>,
): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(ToolTelemetry.defaultLayer)))

describe("ToolTelemetry recordEvent", () => {
  test("appends events to the per-session in-memory store", async () => {
    await withTelemetry(
      Effect.gen(function* () {
        const telemetry = yield* ToolTelemetry.Service
        yield* telemetry.recordEvent(fixtureRaw(sessionA, "code_find"))
        yield* telemetry.recordEvent(fixtureRaw(sessionA, "code_find"))
        const before = yield* telemetry.aggregate({ toolID: "code_find" })
        expect(before.callCount).toBe(0)
        yield* telemetry.recordEvent(fixtureExecuted(sessionA, "code_find", 50))
        const after = yield* telemetry.aggregate({ toolID: "code_find" })
        expect(after.callCount).toBe(1)
      }),
    )
  })

  test("isolates events between sessions", async () => {
    await withTelemetry(
      Effect.gen(function* () {
        const telemetry = yield* ToolTelemetry.Service
        yield* telemetry.recordEvent(fixtureRaw(sessionA, "code_find"))
        yield* telemetry.recordEvent(fixtureRaw(sessionB, "code_find"))
        yield* telemetry.recordEvent(fixtureExecuted(sessionA, "code_find", 30))
        yield* telemetry.recordEvent(fixtureExecuted(sessionB, "code_find", 70))
        const report = yield* telemetry.aggregate({ toolID: "code_find" })
        expect(report.callCount).toBe(2)
      }),
    )
  })
})

describe("ToolTelemetry aggregate", () => {
  test("callCount equals executed + failed events", async () => {
    await withTelemetry(
      Effect.gen(function* () {
        const telemetry = yield* ToolTelemetry.Service
        for (const event of [
          fixtureExecuted(sessionA, "code_find", 50),
          fixtureExecuted(sessionA, "code_find", 60),
          fixtureFailed(sessionA, "code_find", "Invalid tool input: x"),
        ]) {
          yield* telemetry.recordEvent(event)
        }
        const report = yield* telemetry.aggregate({ toolID: "code_find" })
        expect(report.callCount).toBe(3)
        expect(report.successCount).toBe(2)
        expect(report.failureCount).toBe(1)
        expect(report.successRate).toBeCloseTo(2 / 3, 4)
      }),
    )
  })

  test("latency percentiles ignore events without measured latency", async () => {
    await withTelemetry(
      Effect.gen(function* () {
        const telemetry = yield* ToolTelemetry.Service
        for (const event of [
          fixtureRaw(sessionA, "code_find"),
          fixtureExecuted(sessionA, "code_find", 50),
          fixtureExecuted(sessionA, "code_find", 100),
        ]) {
          yield* telemetry.recordEvent(event)
        }
        const report = yield* telemetry.aggregate({ toolID: "code_find" })
        expect(report.callCount).toBe(2)
        expect(report.averageLatencyMs).toBe(75)
      }),
    )
  })

  test("validationFailureCount counts failed events whose error message matches", async () => {
    await withTelemetry(
      Effect.gen(function* () {
        const telemetry = yield* ToolTelemetry.Service
        for (const event of [
          fixtureFailed(sessionA, "code_find", "Invalid tool input: bad shape"),
          fixtureFailed(sessionA, "code_find", "Permission denied"),
          fixtureExecuted(sessionA, "code_find", 10),
        ]) {
          yield* telemetry.recordEvent(event)
        }
        const report = yield* telemetry.aggregate({ toolID: "code_find" })
        expect(report.validationFailureCount).toBe(1)
        expect(report.validationFailureRate).toBeCloseTo(1 / 3, 4)
      }),
    )
  })

  test("since filter excludes older events", async () => {
    await withTelemetry(
      Effect.gen(function* () {
        const telemetry = yield* ToolTelemetry.Service
        yield* telemetry.recordEvent(fixtureExecuted(sessionA, "code_find", 50))
        yield* Effect.sleep("5 millis")
        const cutoff = Date.now()
        yield* Effect.sleep("5 millis")
        yield* telemetry.recordEvent(fixtureExecuted(sessionA, "code_find", 80))
        const report = yield* telemetry.aggregate({
          toolID: "code_find",
          since: cutoff,
        })
        expect(report.callCount).toBe(1)
      }),
    )
  })

  test("repairs always empty in Phase 1.5", async () => {
    await withTelemetry(
      Effect.gen(function* () {
        const telemetry = yield* ToolTelemetry.Service
        yield* telemetry.recordEvent(fixtureRaw(sessionA, "code_find"))
        const next = yield* telemetry.aggregate({ toolID: "code_find" })
        expect(next.averageRepairsPerCall).toBe(0)
      }),
    )
  })
})

describe("ToolTelemetry flush", () => {
  test("writes per-session JSONL files and clears in-memory events", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tool-telemetry-flush-"))
    try {
      await withTelemetry(
        Effect.gen(function* () {
          const telemetry = yield* ToolTelemetry.Service
          for (const event of [
            fixtureRaw(sessionA, "code_find"),
            fixtureExecuted(sessionA, "code_find", 10),
            fixtureRaw(sessionB, "code_find"),
          ]) {
            yield* telemetry.recordEvent(event)
          }
          yield* telemetry.flush({ worktree: tmp })
        }),
      )
      const fileA = path.join(
        tmp,
        ".banyancode",
        "trace",
        `${sessionA}.jsonl`,
      )
      const fileB = path.join(
        tmp,
        ".banyancode",
        "trace",
        `${sessionB}.jsonl`,
      )
      const linesA = (await fs.readFile(fileA, "utf8"))
        .trim()
        .split("\n")
      const linesB = (await fs.readFile(fileB, "utf8"))
        .trim()
        .split("\n")
      expect(linesA.length).toBe(2)
      expect(linesB.length).toBe(1)

      await withTelemetry(
        Effect.gen(function* () {
          const telemetry = yield* ToolTelemetry.Service
          const report = yield* telemetry.aggregate({ toolID: "code_find" })
          expect(report.callCount).toBe(0)
        }),
      )
    } finally {
      await fs.rm(tmp, { recursive: true, force: true })
    }
  })

  test("flush is idempotent when no events are queued", async () => {
    const tmp = await fs.mkdtemp(
      path.join(os.tmpdir(), "tool-telemetry-noop-"),
    )
    try {
      await withTelemetry(
        Effect.gen(function* () {
          const telemetry = yield* ToolTelemetry.Service
          yield* telemetry.flush({ worktree: tmp })
          yield* telemetry.flush({ worktree: tmp })
        }),
      )
      const dir = path.join(tmp, ".banyancode", "trace")
      const exists = await fs.stat(dir).catch(() => null)
      expect(exists).toBeNull()
    } finally {
      await fs.rm(tmp, { recursive: true, force: true })
    }
  })
})
