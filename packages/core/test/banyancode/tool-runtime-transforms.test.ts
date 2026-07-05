/**
 * Phase 3 Tool Runtime — pure-function unit tests for transformation pipeline.
 *
 * Tests each transformation in isolation where possible, and through Tool.settle
 * where the functions are wired into the settle pipeline.
 *
 * Expected Phase 3 functions (tool-runtime.ts):
 *   normalize(input) → [transformed, repairs]
 *   resolveAliases(input, aliases) → [transformed, warnings]
 *   applyDefaults(input, defaults) → [transformed, warnings]
 *   lint(input, schema, aliases?, defaults?) → LintRecord[]
 *   repair(schema, input, context) → { ok, value, repairs }
 *
 * The normalizer records each transformation as a RepairRecord.
 * Alias resolution is one-way only (alias → canonical, never canonical → alias).
 * Defaults NEVER apply to search-term fields (query, search, etc.).
 * Linter never blocks; it emits LintRecords for missing-required, alias resolution,
 * and default-fill.
 * Repair performs exactly one decode attempt after transformations.
 */

import { describe, expect, test } from "bun:test"
import { Effect, Exit, Schema } from "effect"
import { Tool } from "@opencode-ai/core/tool/tool"
import { ToolCall } from "@opencode-ai/llm"
import { randomUUID } from "node:crypto"
import { ToolTelemetry, type ToolRuntimeEvent, type ToolLintWarning } from "../../src/banyancode/tool-telemetry"

const sessionID = "ses_transforms"
const messageID = "msg_transforms"
const toolCallID = "call_transforms"

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
// normalize (null → undefined, trim, lowercase enum, coerce, strip/collapse arrays)
// Tested through Tool.settle since normalize is internal to the settle pipeline
// ---------------------------------------------------------------------------

describe("normalize — null→undefined", () => {
  test("null field is removed before decode (optional string)", async () => {
    let receivedInput: Record<string, unknown> = {}

    const tool = Tool.make({
      description: "normalize null test",
      input: Schema.Struct({ foo: Schema.String.pipe(Schema.optional) }),
      output: Schema.Struct({ ok: Schema.Literal(true) }),
      execute: (input) => {
        receivedInput = input as typeof receivedInput
        return Effect.succeed({ ok: true as const })
      },
    })

    await Effect.runPromise(
      Tool.settle(tool, makeCall("null_tool", { foo: null }), makeContext()),
    )

    expect(receivedInput.foo).toBeUndefined()
  })

  test("null in nested object is removed", async () => {
    let receivedInput: Record<string, unknown> = {}

    const tool = Tool.make({
      description: "normalize nested null",
      input: Schema.Struct({
        nested: Schema.Struct({ a: Schema.String.pipe(Schema.optional) }).pipe(Schema.optional),
      }),
      output: Schema.Struct({ ok: Schema.Literal(true) }),
      execute: (input) => {
        receivedInput = input as typeof receivedInput
        return Effect.succeed({ ok: true as const })
      },
    })

    await Effect.runPromise(
      Tool.settle(tool, makeCall("nested_null", { nested: { a: null } }), makeContext()),
    )

    expect((receivedInput.nested as Record<string, unknown>)?.a).toBeUndefined()
  })
})

describe("normalize — trim strings", () => {
  test("whitespace is trimmed from string fields", async () => {
    let receivedInput: Record<string, unknown> = {}

    const tool = Tool.make({
      description: "trim test",
      input: Schema.Struct({ name: Schema.String, query: Schema.String.pipe(Schema.optional) }),
      output: Schema.Struct({ ok: Schema.Literal(true) }),
      execute: (input) => {
        receivedInput = input as typeof receivedInput
        return Effect.succeed({ ok: true as const })
      },
    })

    await Effect.runPromise(
      Tool.settle(tool, makeCall("trim_tool", { name: "  foo  ", query: "bar " }), makeContext()),
    )

    expect(receivedInput.name).toBe("foo")
    expect(receivedInput.query).toBe("bar")
  })
})

describe("normalize — lowercase enum-like fields", () => {
  test("mode field with literal union is lowercased", async () => {
    let receivedInput: Record<string, unknown> = {}

    const tool = Tool.make({
      description: "lowercase enum",
      input: Schema.Struct({
        mode: Schema.Union([Schema.Literal("fast"), Schema.Literal("slow")]).pipe(Schema.optional),
      }),
      output: Schema.Struct({ ok: Schema.Literal(true) }),
      execute: (input) => {
        receivedInput = input as typeof receivedInput
        return Effect.succeed({ ok: true as const })
      },
    })

    await Effect.runPromise(
      Tool.settle(tool, makeCall("enum_tool", { mode: "FAST" }), makeContext()),
    )

    expect(receivedInput.mode).toBe("fast")
  })
})

describe("normalize — coerce strings to numbers for limit/count/depth/maxDepth/minScore/numResults/offset", () => {
  const numericFields = ["limit", "count", "depth", "maxDepth", "minScore", "numResults", "offset"]

  for (const field of numericFields) {
    test(`${field}: string "42" → number 42`, async () => {
      let receivedInput: Record<string, unknown> = {}

      const tool = Tool.make({
        description: `coerce ${field}`,
        input: Schema.Struct({ [field]: Schema.Number }),
        output: Schema.Struct({ ok: Schema.Literal(true) }),
        execute: (input) => {
          receivedInput = input as typeof receivedInput
          return Effect.succeed({ ok: true as const })
        },
      })

      await Effect.runPromise(
        Tool.settle(tool, makeCall(`${field}_tool`, { [field]: "42" }), makeContext()),
      )

      expect(receivedInput[field]).toBe(42)
      expect(typeof receivedInput[field]).toBe("number")
    })
  }
})

describe("normalize — strip empty arrays, collapse single-element arrays", () => {
  test("empty array is stripped", async () => {
    let receivedInput: Record<string, unknown> = {}

    const tool = Tool.make({
      description: "strip empty",
      input: Schema.Struct({ tags: Schema.Array(Schema.String).pipe(Schema.optional) }),
      output: Schema.Struct({ ok: Schema.Literal(true) }),
      execute: (input) => {
        receivedInput = input as typeof receivedInput
        return Effect.succeed({ ok: true as const })
      },
    })

    await Effect.runPromise(
      Tool.settle(tool, makeCall("empty_tool", { tags: [] }), makeContext()),
    )

    expect(receivedInput.tags).toBeUndefined()
  })

  test("single-element array is collapsed to scalar (when schema expects scalar)", async () => {
    let receivedInput: Record<string, unknown> = {}

    const tool = Tool.make({
      description: "collapse single",
      input: Schema.Struct({ tags: Schema.String.pipe(Schema.optional) }),
      output: Schema.Struct({ ok: Schema.Literal(true) }),
      execute: (input) => {
        receivedInput = input as typeof receivedInput
        return Effect.succeed({ ok: true as const })
      },
    })

    await Effect.runPromise(
      Tool.settle(tool, makeCall("single_tool", { tags: ["only"] }), makeContext()),
    )

    expect(receivedInput.tags).toBe("only")
  })
})

// ---------------------------------------------------------------------------
// resolveAliases — one-way only: alias → canonical
// Tested through Tool.settle
// ---------------------------------------------------------------------------

describe("resolveAliases — alias→canonical (one-way)", () => {
  test("{ function: 'parse' } → { functionName: 'parse' }", async () => {
    let receivedInput: Record<string, unknown> = {}

    const tool = Tool.make({
      description: "alias test",
      contract: { acceptsAliases: { functionName: ["function"] } },
      input: Schema.Struct({ functionName: Schema.String }),
      output: Schema.Struct({ ok: Schema.Literal(true) }),
      execute: (input) => {
        receivedInput = input as typeof receivedInput
        return Effect.succeed({ ok: true as const })
      },
    })

    await Effect.runPromise(
      Tool.settle(tool, makeCall("alias_tool", { function: "parse" }), makeContext()),
    )

    expect(receivedInput.functionName).toBe("parse")
    expect(receivedInput.function).toBeUndefined()
  })

  test("{ functionName: 'parse' } → canonical kept, alias NOT copied", async () => {
    let receivedInput: Record<string, unknown> = {}

    const tool = Tool.make({
      description: "canonical preserved",
      contract: { acceptsAliases: { functionName: ["function"] } },
      input: Schema.Struct({ functionName: Schema.String }),
      output: Schema.Struct({ ok: Schema.Literal(true) }),
      execute: (input) => {
        receivedInput = input as typeof receivedInput
        return Effect.succeed({ ok: true as const })
      },
    })

    await Effect.runPromise(
      Tool.settle(tool, makeCall("canon_tool", { functionName: "parse" }), makeContext()),
    )

    expect(receivedInput.functionName).toBe("parse")
    expect(Object.keys(receivedInput)).toEqual(["functionName"])
  })

  test("{ functionName: 'parse', function: 'parse' } → alias removed, canonical kept", async () => {
    let receivedInput: Record<string, unknown> = {}

    const tool = Tool.make({
      description: "both removed",
      contract: { acceptsAliases: { functionName: ["function"] } },
      input: Schema.Struct({ functionName: Schema.String }),
      output: Schema.Struct({ ok: Schema.Literal(true) }),
      execute: (input) => {
        receivedInput = input as typeof receivedInput
        return Effect.succeed({ ok: true as const })
      },
    })

    await Effect.runPromise(
      Tool.settle(tool, makeCall("both_tool", { functionName: "parse", function: "parse" }), makeContext()),
    )

    expect(receivedInput.functionName).toBe("parse")
    expect(receivedInput.function).toBeUndefined()
  })

  test("no two-step chain: { alias1: 'x' } with alias1→alias2→canonical doesn't fill canonical", async () => {
    let receivedInput: Record<string, unknown> = {}

    const tool = Tool.make({
      description: "no two-step",
      contract: { acceptsAliases: { alias2: ["alias1"], functionName: ["alias2"] } },
      input: Schema.Struct({
        functionName: Schema.String.pipe(Schema.optional),
      }),
      output: Schema.Struct({ ok: Schema.Literal(true) }),
      execute: (input) => {
        receivedInput = input as typeof receivedInput
        return Effect.succeed({ ok: true as const })
      },
    })

    await Effect.runPromise(
      Tool.settle(tool, makeCall("chain_tool", { alias1: "x" }), makeContext()),
    )

    expect(receivedInput.functionName).toBeUndefined()
  })

  test("alias resolution emits LintRecord { kind: 'alias', confidence: 0.99 }", async () => {
    const captured: { current: ToolRuntimeEvent[] } = { current: [] }

    const tool = Tool.make({
      description: "alias telemetry",
      contract: { acceptsAliases: { functionName: ["function"] } },
      input: Schema.Struct({ functionName: Schema.String }),
      output: Schema.Struct({ ok: Schema.Literal(true) }),
      execute: () => Effect.succeed({ ok: true as const }),
    })

    await withCapture(
      captured,
      Effect.gen(function* () {
        const ctx = makeContext()
        const call = makeCall("alias_warn", { function: "parse" })
        yield* Tool.settle(tool, call, ctx)
      }),
    )

    const validated = captured.current.find((e) => e.kind === "validated")
    expect(validated).toBeDefined()
    const aliasWarn = validated!.warnings.find((w: ToolLintWarning) => w.kind === "alias")
    expect(aliasWarn).toBeDefined()
    expect(aliasWarn!.confidence).toBe(0.99)
    expect(aliasWarn!.autoFixAvailable).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// applyDefaults — defaults never apply to search-term fields
// ---------------------------------------------------------------------------

describe("applyDefaults — search-term fields are protected", () => {
  test("query='Effect.gen' is NOT overwritten by default query='default'", async () => {
    let receivedInput: Record<string, unknown> = {}

    const tool = Tool.make({
      description: "query protection",
      contract: { defaultValues: { query: "default", limit: 50 } },
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

    await Effect.runPromise(
      Tool.settle(tool, makeCall("query_protect", { query: "Effect.gen" }), makeContext()),
    )

    expect(receivedInput.query).toBe("Effect.gen")
    expect(receivedInput.query).not.toBe("default")
    expect(receivedInput.limit).toBe(50) // limit gets default since not provided
  })

  test("default fill emits LintRecord { kind: 'default-fill' }", async () => {
    const captured: { current: ToolRuntimeEvent[] } = { current: [] }

    const tool = Tool.make({
      description: "default fill warn",
      contract: { defaultValues: { limit: 50 } },
      input: Schema.Struct({ limit: Schema.Number }),
      output: Schema.Struct({ ok: Schema.Literal(true) }),
      execute: () => Effect.succeed({ ok: true as const }),
    })

    await withCapture(
      captured,
      Effect.gen(function* () {
        const ctx = makeContext()
        const call = makeCall("default_warn", {})
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
// lint — never blocks, emits LintRecords
// ---------------------------------------------------------------------------

describe("lint — observational, never blocks execution", () => {
  test("missing required field → LintRecord { kind: 'missing-required', confidence: 0.21 } emitted in failed event", async () => {
    const captured: { current: ToolRuntimeEvent[] } = { current: [] }

    const tool = Tool.make({
      description: "missing required",
      input: Schema.Struct({ name: Schema.String, age: Schema.Number }),
      output: Schema.Struct({ ok: Schema.Literal(true) }),
      execute: () => Effect.succeed({ ok: true as const }),
    })

    await withCapture(
      captured,
      Effect.gen(function* () {
        const ctx = makeContext()
        const call = makeCall("missing_tool", { name: "Alice" })
        yield* Tool.settle(tool, call, ctx).pipe(Effect.ignore)
      }),
    )

    const failed = captured.current.find((e) => e.kind === "failed")
    expect(failed).toBeDefined()
    expect(failed!.success).toBe(false)
    expect(failed!.errorMessage).toContain("Invalid tool input")

    const missing = failed!.warnings.find((w: ToolLintWarning) => w.kind === "missing-required")
    expect(missing).toBeDefined()
    expect(missing!.field).toBe("age")
    expect(missing!.confidence).toBe(0.21)
    expect(missing!.autoFixAvailable).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// repair — exactly one pass
// ---------------------------------------------------------------------------

describe("repair — exactly one retry on decode failure", () => {
  test("type mismatch: count='hello' → repair cannot fix → second decode fails", async () => {
    let receivedInput: Record<string, unknown> = {}

    const tool = Tool.make({
      description: "type mismatch",
      contract: { repairPolicy: "one-pass" },
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
      Effect.exit(Tool.settle(tool, makeCall("type_mismatch", { count: "hello" }), makeContext())),
    )

    expect(exit._tag).toBe("Failure")
    expect(receivedInput.count).toBeUndefined()
  })

  test("type mismatch: count='42' → repair coerces to 42 → second decode succeeds", async () => {
    let receivedInput: Record<string, unknown> = {}

    const tool = Tool.make({
      description: "coerce repair",
      contract: { repairPolicy: "one-pass" },
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
      Effect.exit(Tool.settle(tool, makeCall("coerce_tool", { count: "42" }), makeContext())),
    )

    expect(exit._tag).toBe("Success")
    if (!Exit.isSuccess(exit)) throw new Error("expected settle success")
    const output = exit.value as { structured: { ok: boolean } }
    expect(output.structured.ok).toBe(true)
    expect(receivedInput.count).toBe(42)
    expect(typeof receivedInput.count).toBe("number")
  })

  test("repairs array contains coerce-number after string→number repair", async () => {
    const captured: { current: ToolRuntimeEvent[] } = { current: [] }

    const tool = Tool.make({
      description: "coerce repairs",
      contract: { repairPolicy: "one-pass" },
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
})
