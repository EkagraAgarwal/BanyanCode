/**
 * Phase 3 Tool Runtime — settle integration tests.
 *
 * Tests the full pipeline through Tool.settle with a real tool contract
 * that has acceptsAliases and defaultValues configured.
 *
 * Telemetry events must carry the repairs and warnings lists populated
 * by the transformation pipeline.
 */

import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { Tool } from "@opencode-ai/core/tool/tool"
import { ToolCall } from "@opencode-ai/llm"
import { randomUUID } from "node:crypto"
import { ToolTelemetry, type ToolRuntimeEvent, type ToolLintWarning } from "../../src/banyancode/tool-telemetry"

const sessionID = "ses_phase3_settle"
const messageID = "msg_phase3_settle"
const toolCallID = "call_phase3_settle"

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

// ---------------------------------------------------------------------------
// Alias resolution via Tool.settle
// ---------------------------------------------------------------------------

describe("Tool.settle alias resolution", () => {
  test("accepts { function: 'parse' } and execute receives { functionName: 'parse' }", async () => {
    const captured: { current: ToolRuntimeEvent[] } = { current: [] }
    let receivedInput: Record<string, unknown> = {}

    const tool = Tool.make({
      description: "phase3 alias test",
      contract: {
        acceptsAliases: { functionName: ["function"] },
      },
      input: Schema.Struct({ functionName: Schema.String }),
      output: Schema.Struct({ ok: Schema.Literal(true) }),
      execute: (input) => {
        receivedInput = input as typeof receivedInput
        return Effect.succeed({ ok: true as const })
      },
    })

    const result = await withCapture(
      captured,
      Effect.gen(function* () {
        const ctx = makeContext()
        const call = makeCall("alias_tool", { function: "parse" })
        return yield* Tool.settle(tool, call, ctx)
      }),
    )

    expect((result as OkOutput).structured.ok).toBe(true)
    expect(receivedInput.functionName).toBe("parse")
    expect(receivedInput.function).toBeUndefined()
  })

  test("canonical { functionName: 'parse' } passes through unchanged", async () => {
    let receivedInput: Record<string, unknown> = {}

    const tool = Tool.make({
      description: "phase3 canonical test",
      contract: {
        acceptsAliases: { functionName: ["function"] },
      },
      input: Schema.Struct({ functionName: Schema.String }),
      output: Schema.Struct({ ok: Schema.Literal(true) }),
      execute: (input) => {
        receivedInput = input as typeof receivedInput
        return Effect.succeed({ ok: true as const })
      },
    })

    const result = await withCapture(
      { current: [] },
      Effect.gen(function* () {
        const ctx = makeContext()
        const call = makeCall("canonical_tool", { functionName: "parse" })
        return yield* Tool.settle(tool, call, ctx)
      }),
    )

    expect((result as OkOutput).structured.ok).toBe(true)
    expect(receivedInput.functionName).toBe("parse")
  })

  test("telemetry events contain alias resolution repair record", async () => {
    const captured: { current: ToolRuntimeEvent[] } = { current: [] }

    const tool = Tool.make({
      description: "phase3 alias telemetry",
      contract: {
        acceptsAliases: { functionName: ["function"] },
      },
      input: Schema.Struct({ functionName: Schema.String }),
      output: Schema.Struct({ ok: Schema.Literal(true) }),
      execute: () => Effect.succeed({ ok: true as const }),
    })

    await withCapture(
      captured,
      Effect.gen(function* () {
        const ctx = makeContext()
        const call = makeCall("alias_telemetry", { function: "parse" })
        yield* Tool.settle(tool, call, ctx)
      }),
    )

    const validated = captured.current.find((e) => e.kind === "validated")
    expect(validated).toBeDefined()
    expect(validated!.warnings.some((w) => w.kind === "alias")).toBe(true)

    const warning = validated!.warnings.find((w: ToolLintWarning) => w.kind === "alias")
    expect(warning).toBeDefined()
    expect(warning!.confidence).toBe(0.99)
    expect(warning!.autoFixAvailable).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Default values via Tool.settle
// ---------------------------------------------------------------------------

describe("Tool.settle default values", () => {
  test("{} with defaultValues limit=50 → execute receives { limit: 50 }", async () => {
    let receivedInput: Record<string, unknown> = {}

    const tool = Tool.make({
      description: "phase3 defaults test",
      contract: {
        defaultValues: { limit: 50 },
      },
      input: Schema.Struct({ limit: Schema.Number }),
      output: Schema.Struct({ ok: Schema.Literal(true) }),
      execute: (input) => {
        receivedInput = input as typeof receivedInput
        return Effect.succeed({ ok: true as const })
      },
    })

    const result = await withCapture(
      { current: [] },
      Effect.gen(function* () {
        const ctx = makeContext()
        const call = makeCall("defaults_tool", {})
        return yield* Tool.settle(tool, call, ctx)
      }),
    )

    expect((result as OkOutput).structured.ok).toBe(true)
    expect(receivedInput.limit).toBe(50)
  })

  test("explicit limit=100 is NOT overwritten by default", async () => {
    let receivedInput: Record<string, unknown> = {}

    const tool = Tool.make({
      description: "phase3 explicit wins",
      contract: {
        defaultValues: { limit: 50 },
      },
      input: Schema.Struct({ limit: Schema.Number }),
      output: Schema.Struct({ ok: Schema.Literal(true) }),
      execute: (input) => {
        receivedInput = input as typeof receivedInput
        return Effect.succeed({ ok: true as const })
      },
    })

    const result = await withCapture(
      { current: [] },
      Effect.gen(function* () {
        const ctx = makeContext()
        const call = makeCall("explicit_tool", { limit: 100 })
        return yield* Tool.settle(tool, call, ctx)
      }),
    )

    expect((result as OkOutput).structured.ok).toBe(true)
    expect(receivedInput.limit).toBe(100)
    expect(receivedInput.limit).not.toBe(50)
  })

  test("defaults NEVER apply to query (search-term field)", async () => {
    let receivedInput: Record<string, unknown> = {}

    const tool = Tool.make({
      description: "phase3 query protection",
      contract: {
        defaultValues: { query: "default", limit: 50 },
      },
      input: Schema.Struct({
        query: Schema.String,
        limit: Schema.Number.pipe(Schema.optional),
      }),
      output: Schema.Struct({ ok: Schema.Literal(true) }),
      execute: (input) => {
        receivedInput = input as typeof receivedInput
        return Effect.succeed({ ok: true as const })
      },
    })

    const result = await withCapture(
      { current: [] },
      Effect.gen(function* () {
        const ctx = makeContext()
        const call = makeCall("query_tool", { query: "Effect.gen" })
        return yield* Tool.settle(tool, call, ctx)
      }),
    )

    expect((result as OkOutput).structured.ok).toBe(true)
    expect(receivedInput.query).toBe("Effect.gen")
    expect(receivedInput.query).not.toBe("default")
    expect(receivedInput.limit).toBe(50)
  })

  test("telemetry events contain default-fill warning", async () => {
    const captured: { current: ToolRuntimeEvent[] } = { current: [] }

    const tool = Tool.make({
      description: "phase3 defaults telemetry",
      contract: {
        defaultValues: { limit: 50 },
      },
      input: Schema.Struct({ limit: Schema.Number }),
      output: Schema.Struct({ ok: Schema.Literal(true) }),
      execute: () => Effect.succeed({ ok: true as const }),
    })

    await withCapture(
      captured,
      Effect.gen(function* () {
        const ctx = makeContext()
        const call = makeCall("defaults_telemetry", {})
        yield* Tool.settle(tool, call, ctx)
      }),
    )

    const validated = captured.current.find((e) => e.kind === "validated")
    expect(validated).toBeDefined()
    const defaultFill = validated!.warnings.find((w: ToolLintWarning) => w.kind === "default-fill")
    expect(defaultFill).toBeDefined()
    expect(defaultFill!.field).toBe("limit")
  })
})

// ---------------------------------------------------------------------------
// Full pipeline — repairs + warnings in telemetry
// ---------------------------------------------------------------------------

describe("Tool.settle repairs + warnings telemetry", () => {
  test("settle emits telemetry with repairs and warnings lists populated", async () => {
    const captured: { current: ToolRuntimeEvent[] } = { current: [] }

    const tool = Tool.make({
      description: "phase3 full pipeline",
      contract: {
        acceptsAliases: { functionName: ["function"] },
        defaultValues: { limit: 50 },
      },
      input: Schema.Struct({
        functionName: Schema.String,
        limit: Schema.Number,
      }),
      output: Schema.Struct({ ok: Schema.Literal(true) }),
      execute: () => Effect.succeed({ ok: true as const }),
    })

    await withCapture(
      captured,
      Effect.gen(function* () {
        const ctx = makeContext()
        const call = makeCall("full_pipeline", { function: "parse" })
        yield* Tool.settle(tool, call, ctx)
      }),
    )

    const validated = captured.current.find((e) => e.kind === "validated")
    expect(validated).toBeDefined()
    expect(validated!.warnings.length).toBeGreaterThan(0)
  })

  test("successful settle has no failed events", async () => {
    const captured: { current: ToolRuntimeEvent[] } = { current: [] }

    const tool = Tool.make({
      description: "phase3 success",
      contract: {
        acceptsAliases: { functionName: ["function"] },
        defaultValues: { limit: 50 },
      },
      input: Schema.Struct({
        functionName: Schema.String,
        limit: Schema.Number,
      }),
      output: Schema.Struct({ ok: Schema.Literal(true) }),
      execute: () => Effect.succeed({ ok: true as const }),
    })

    await withCapture(
      captured,
      Effect.gen(function* () {
        const ctx = makeContext()
        const call = makeCall("success_tool", { function: "parse" })
        yield* Tool.settle(tool, call, ctx)
      }),
    )

    const failed = captured.current.find((e) => e.kind === "failed")
    expect(failed).toBeUndefined()
    const executed = captured.current.find((e) => e.kind === "executed")
    expect(executed).toBeDefined()
    expect(executed!.success).toBe(true)
  })
})
