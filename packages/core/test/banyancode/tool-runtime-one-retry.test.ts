/**
 * Phase 3 Tool Runtime — one repair pass verification.
 *
 * Verifies that when a schema decode fails, exactly ONE repair pass is applied.
 * The second decode either succeeds or returns error — no third retry.
 *
 * Repair policy: "one-pass" (the default in ToolContract).
 *
 * NOTE: The repair pass handles TYPE errors (string→number, etc.) but does NOT
 * enforce range constraints. A value like -5 passes a plain Schema.Number field.
 */

import { describe, expect, test } from "bun:test"
import { Effect, Exit, Schema } from "effect"
import { Tool } from "@opencode-ai/core/tool/tool"
import { ToolCall } from "@opencode-ai/llm"
import { randomUUID } from "node:crypto"
import { ToolTelemetry, type ToolRuntimeEvent } from "../../src/banyancode/tool-telemetry"

const sessionID = "ses_one_retry"
const messageID = "msg_one_retry"
const toolCallID = "call_one_retry"

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
    aggregate: () => Effect.die("not used" as never),
    flush: () => Effect.die("not used" as never),
  })

const withCapture = <A, E>(
  capture: { current: ToolRuntimeEvent[] },
  effect: Effect.Effect<A, E, ToolTelemetry.Service>,
): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provideService(ToolTelemetry.Service, buildCaptureService(capture))))

// ---------------------------------------------------------------------------
// Exactly one repair pass
// ---------------------------------------------------------------------------

describe("repair pass — exactly one retry", () => {
  test("type mismatch: count='hello' → repair cannot fix → second decode fails", async () => {
    const captured: { current: ToolRuntimeEvent[] } = { current: [] }

    const tool = Tool.make({
      description: "type mismatch",
      contract: {
        repairPolicy: "one-pass",
      },
      input: Schema.Struct({
        count: Schema.Number,
      }),
      output: Schema.Struct({ ok: Schema.Literal(true) }),
      execute: () => Effect.succeed({ ok: true as const }),
    })

    const exit = await withCapture(
      captured,
      Effect.gen(function* () {
        const ctx = makeContext()
        const call = makeCall("type_mismatch", { count: "hello" })
        return yield* Tool.settle(tool, call, ctx).pipe(Effect.exit)
      }),
    )

    expect(exit._tag).toBe("Failure")
    const failed = captured.current.find((e) => e.kind === "failed")
    expect(failed).toBeDefined()
    expect(failed!.errorMessage).toContain("Invalid tool input")
  })

  test("type mismatch: count='42' → repair coerces to 42 → second decode succeeds", async () => {
    let receivedInput: Record<string, unknown> = {}

    const tool = Tool.make({
      description: "coerce string to number",
      contract: {
        repairPolicy: "one-pass",
      },
      input: Schema.Struct({
        count: Schema.Number,
      }),
      output: Schema.Struct({ ok: Schema.Literal(true) }),
      execute: (input) => {
        receivedInput = input as typeof receivedInput
        return Effect.succeed({ ok: true as const })
      },
    })

    const exit = await Effect.runPromise(
      Effect.exit(Tool.settle(tool, makeCall("coerce_num", { count: "42" }), makeContext())),
    )

    expect(exit._tag).toBe("Success")
    if (!Exit.isSuccess(exit)) throw new Error("expected settle success")
    const output = exit.value as { structured: { ok: boolean } }
    expect(output.structured.ok).toBe(true)
    expect(receivedInput.count).toBe(42)
    expect(typeof receivedInput.count).toBe("number")
  })

  test("telemetry repairs include coerce-number after string→number repair", async () => {
    const captured: { current: ToolRuntimeEvent[] } = { current: [] }

    const tool = Tool.make({
      description: "coerce repairs",
      contract: {
        repairPolicy: "one-pass",
      },
      input: Schema.Struct({
        count: Schema.Number,
      }),
      output: Schema.Struct({ ok: Schema.Literal(true) }),
      execute: () => Effect.succeed({ ok: true as const }),
    })

    await withCapture(
      captured,
      Effect.gen(function* () {
        const ctx = makeContext()
        const call = makeCall("coerce_repairs", { count: "42" })
        yield* Tool.settle(tool, call, ctx)
      }),
    )

    const validated = captured.current.find((e) => e.kind === "validated")
    expect(validated).toBeDefined()
    const coerceRepairs = validated!.repairs.filter((r) => r.includes("coerce-number"))
    expect(coerceRepairs.length).toBeGreaterThan(0)
  })

  test("second decode fails → error returned (no third retry)", async () => {
    const captured: { current: ToolRuntimeEvent[] } = { current: [] }

    const tool = Tool.make({
      description: "irreparable",
      contract: {
        repairPolicy: "one-pass",
      },
      input: Schema.Struct({
        name: Schema.String,
        age: Schema.Number,
      }),
      output: Schema.Struct({ ok: Schema.Literal(true) }),
      execute: () => Effect.succeed({ ok: true as const }),
    })

    const exit = await withCapture(
      captured,
      Effect.gen(function* () {
        const ctx = makeContext()
        const call = makeCall("irreparable_tool", { name: 12345, age: "not-a-number" })
        return yield* Tool.settle(tool, call, ctx).pipe(Effect.exit)
      }),
    )

    expect(exit._tag).toBe("Failure")
    const failed = captured.current.find((e) => e.kind === "failed")
    expect(failed).toBeDefined()
    expect(failed!.errorMessage).toContain("Invalid tool input")
  })

  test("first decode succeeds → no repair pass needed", async () => {
    const captured: { current: ToolRuntimeEvent[] } = { current: [] }

    const tool = Tool.make({
      description: "no repair needed",
      contract: {
        repairPolicy: "one-pass",
      },
      input: Schema.Struct({
        count: Schema.Number,
      }),
      output: Schema.Struct({ ok: Schema.Literal(true) }),
      execute: () => Effect.succeed({ ok: true as const }),
    })

    await withCapture(
      captured,
      Effect.gen(function* () {
        const ctx = makeContext()
        const call = makeCall("valid_tool", { count: 42 })
        yield* Tool.settle(tool, call, ctx)
      }),
    )

    const validated = captured.current.find((e) => e.kind === "validated")
    expect(validated).toBeDefined()
    expect(validated!.repairs).toEqual([])
  })

  test("repairPolicy strict → no repair, immediate failure", async () => {
    const captured: { current: ToolRuntimeEvent[] } = { current: [] }

    const tool = Tool.make({
      description: "strict policy",
      contract: {
        repairPolicy: "strict",
      },
      input: Schema.Struct({
        count: Schema.Number,
      }),
      output: Schema.Struct({ ok: Schema.Literal(true) }),
      execute: () => Effect.succeed({ ok: true as const }),
    })

    const exit = await withCapture(
      captured,
      Effect.gen(function* () {
        const ctx = makeContext()
        const call = makeCall("strict_tool", { count: "hello" })
        return yield* Tool.settle(tool, call, ctx).pipe(Effect.exit)
      }),
    )

    expect(exit._tag).toBe("Failure")
    const validated = captured.current.find((e) => e.kind === "validated")
    expect(validated).toBeUndefined()
    const failed = captured.current.find((e) => e.kind === "failed")
    expect(failed).toBeDefined()
  })

  test("repairPolicy never → linter warnings only, no repair", async () => {
    const captured: { current: ToolRuntimeEvent[] } = { current: [] }

    const tool = Tool.make({
      description: "never policy",
      contract: {
        repairPolicy: "never",
      },
      input: Schema.Struct({
        count: Schema.Number,
      }),
      output: Schema.Struct({ ok: Schema.Literal(true) }),
      execute: () => Effect.succeed({ ok: true as const }),
    })

    const exit = await withCapture(
      captured,
      Effect.gen(function* () {
        const ctx = makeContext()
        const call = makeCall("never_tool", { count: "hello" })
        return yield* Tool.settle(tool, call, ctx).pipe(Effect.exit)
      }),
    )

    expect(exit._tag).toBe("Failure")
    const validated = captured.current.find((e) => e.kind === "validated")
    expect(validated).toBeUndefined()
  })
})
