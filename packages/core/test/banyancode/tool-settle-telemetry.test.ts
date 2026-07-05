/**
 * Phase 1.5 Tool Runtime — settle integration tests.
 *
 * Verifies that Tool.settle records raw / normalized / validated /
 * executed snapshots via `Effect.serviceOption(ToolTelemetry)` and
 * falls back to a no-op when Telemetry is not in scope. Phase 1.5 is
 * observational only — the recorded `normalized` input is identical to
 * `raw` and `repairs` / `warnings` are always empty.
 */

import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { Tool } from "@opencode-ai/core/tool/tool"
import { ToolCall } from "@opencode-ai/llm"
import { randomUUID } from "node:crypto"
import { ToolTelemetry, type ToolRuntimeEvent } from "../../src/banyancode/tool-telemetry"

const sessionID = "ses_phase1_5_settle"
const messageID = "msg_phase1_5_settle"
const toolCallID = "call_phase1_5_settle"

const makeContext = (): Tool.Context => ({
  sessionID: sessionID as Tool.Context["sessionID"],
  agent: "build" as Tool.Context["agent"],
  assistantMessageID: messageID as Tool.Context["assistantMessageID"],
  toolCallID,
})

const makeCall = (name: string, input: unknown): ToolCall => ({
  type: "tool-call",
  id: randomUUID(),
  name,
  input,
})

const buildCaptureService = (eventsRef: { current: ToolRuntimeEvent[] }) =>
  ToolTelemetry.Service.of({
    recordEvent: (event) => Effect.sync(() => { eventsRef.current.push(event) }),
    aggregate: () => Effect.die("not used in settle tests" as never),
    flush: () => Effect.die("not used in settle tests" as never),
  })

const withCapture = <A, E>(
  capture: { current: ToolRuntimeEvent[] },
  effect: Effect.Effect<A, E, ToolTelemetry.Service>,
): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provideService(ToolTelemetry.Service, buildCaptureService(capture))))

type OkOutput = { readonly structured: { readonly ok: true } }

describe("Tool.settle telemetry", () => {
  test("emits raw, normalized, validated, and executed snapshots on success", async () => {
    const captured: { current: ToolRuntimeEvent[] } = { current: [] }
    const result = await withCapture(
      captured,
      Effect.gen(function* () {
        const tool = Tool.make({
          description: "phase1.5 success",
          input: Schema.Struct({ foo: Schema.String.pipe(Schema.optional) }),
          output: Schema.Struct({ ok: Schema.Literal(true) }),
          execute: () => Effect.succeed({ ok: true as const }),
        })
        const ctx = makeContext()
        const call = makeCall("settle_success", { foo: "bar" })
        return yield* Tool.settle(tool, call, ctx)
      }),
    )
    expect((result as OkOutput).structured.ok).toBe(true)

    const kinds = captured.current.map((e) => e.kind)
    expect(kinds).toEqual(["raw", "normalized", "validated", "executed"])

    const raw = captured.current.find((e) => e.kind === "raw")!
    const normalized = captured.current.find((e) => e.kind === "normalized")!
    const validated = captured.current.find((e) => e.kind === "validated")!
    const executed = captured.current.find((e) => e.kind === "executed")!

    expect(raw.toolID).toBe("settle_success")
    expect(raw.sessionID).toBe(sessionID)
    expect(raw.agent).toBe("build")
    expect(raw.rawInput).toEqual({ foo: "bar" })

    expect(normalized.normalizedInput).toEqual({ foo: "bar" })
    expect(normalized.rawInput).toEqual(raw.rawInput)

    expect(validated.validatedInput).toEqual({ foo: "bar" })
    expect(validated.repairs).toEqual([])
    expect(validated.warnings).toEqual([])

    expect(executed.success).toBe(true)
    expect(executed.latencyMs).toBeGreaterThanOrEqual(0)
    expect(executed.finishedAt).toBeDefined()
  })

  test("normalized input is identical to raw in Phase 1.5 (no real normalizer)", async () => {
    const captured: { current: ToolRuntimeEvent[] } = { current: [] }
    await withCapture(
      captured,
      Effect.gen(function* () {
        const tool = Tool.make({
          description: "phase1.5 normalize-identity",
          input: Schema.Struct({ foo: Schema.String.pipe(Schema.optional) }),
          output: Schema.Struct({ ok: Schema.Literal(true) }),
          execute: () => Effect.succeed({ ok: true as const }),
        })
        const ctx = makeContext()
        const call = makeCall("settle_norm_identity", { foo: "bar", ignored: 7 })
        yield* Tool.settle(tool, call, ctx)
      }),
    )
    const raw = captured.current.find((e) => e.kind === "raw")!
    const normalized = captured.current.find((e) => e.kind === "normalized")!
    expect(normalized.normalizedInput).toEqual(raw.rawInput)
    expect(normalized.normalizedInput).toEqual({ foo: "bar", ignored: 7 })
  })

  test("emits failed snapshot on schema decode error", async () => {
    const captured: { current: ToolRuntimeEvent[] } = { current: [] }
    const exit = await withCapture(
      captured,
      Effect.gen(function* () {
        const tool = Tool.make({
          description: "phase1.5 failure",
          input: Schema.Struct({ foo: Schema.String }),
          output: Schema.Struct({ ok: Schema.Literal(true) }),
          execute: () => Effect.succeed({ ok: true as const }),
        })
        const ctx = makeContext()
        const call = makeCall("settle_failure", { foo: 123 })
        return yield* Tool.settle(tool, call, ctx).pipe(Effect.exit)
      }),
    )
    if (exit._tag !== "Failure") throw new Error("expected settle failure")

    const failed = captured.current.find((e) => e.kind === "failed")
    expect(failed).toBeDefined()
    expect(failed!.success).toBe(false)
    expect(failed!.errorMessage).toContain("Invalid tool input")
    expect(failed!.latencyMs).toBeGreaterThanOrEqual(0)
    expect(failed!.rawInput).toEqual({ foo: 123 })

    const kinds = captured.current.map((e) => e.kind)
    expect(kinds).toContain("raw")
    expect(kinds).toContain("normalized")
    expect(kinds).not.toContain("validated")
  })

  test("emits executed snapshot when tool returns a value", async () => {
    const captured: { current: ToolRuntimeEvent[] } = { current: [] }
    await withCapture(
      captured,
      Effect.gen(function* () {
        const tool = Tool.make({
          description: "phase1.5 success-only",
          input: Schema.Struct({ foo: Schema.String }),
          output: Schema.Struct({ ok: Schema.Literal(true), count: Schema.Number }),
          execute: () => Effect.succeed({ ok: true as const, count: 42 }),
        })
        const ctx = makeContext()
        const call = makeCall("settle_exec", { foo: "bar" })
        yield* Tool.settle(tool, call, ctx)
      }),
    )
    const executed = captured.current.find((e) => e.kind === "executed")
    expect(executed).toBeDefined()
    expect(executed!.success).toBe(true)
    expect(executed!.latencyMs).toBeGreaterThanOrEqual(0)
    expect(executed!.validatedInput).toEqual({ foo: "bar" })
  })

  test("settle succeeds without Telemetry in scope", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const tool = Tool.make({
          description: "phase1.5 no-telemetry",
          input: Schema.Struct({ foo: Schema.String.pipe(Schema.optional) }),
          output: Schema.Struct({ ok: Schema.Literal(true) }),
          execute: () => Effect.succeed({ ok: true as const }),
        })
        const ctx = makeContext()
        const call = makeCall("settle_no_telemetry", { foo: "bar" })
        return yield* Tool.settle(tool, call, ctx)
      }),
    )
    expect((result as OkOutput).structured.ok).toBe(true)
  })

  test("records rawInput exactly as LLM sent it (no transformation)", async () => {
    const captured: { current: ToolRuntimeEvent[] } = { current: [] }
    const callInput = { foo: "bar", nested: { a: 1 }, list: [1, 2, 3] }
    await withCapture(
      captured,
      Effect.gen(function* () {
        const tool = Tool.make({
          description: "phase1.5 raw-preserve",
          input: Schema.Struct({
            foo: Schema.String,
            nested: Schema.Struct({ a: Schema.Number }).pipe(Schema.optional),
            list: Schema.Array(Schema.Number).pipe(Schema.optional),
          }),
          output: Schema.Struct({ ok: Schema.Literal(true) }),
          execute: () => Effect.succeed({ ok: true as const }),
        })
        const ctx = makeContext()
        const call = makeCall("settle_raw_preserve", callInput)
        yield* Tool.settle(tool, call, ctx)
      }),
    )
    const raw = captured.current.find((e) => e.kind === "raw")!
    expect(raw.rawInput).toEqual(callInput)
  })
})
