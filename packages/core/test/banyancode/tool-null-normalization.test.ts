/**
 * Phase 1 tool null-normalization regression tests.
 *
 * Verifies that every BanyanCode tool input schema tolerates:
 * - explicit `null` for every optional field
 * - `undefined` for every optional field (baseline regression)
 * - complete field omission (baseline regression)
 *
 * The settle function must normalize `null` → `undefined` before schema decode
 * so that "Expected string | undefined, got null" is never thrown.
 *
 * After schema decode, optional fields with `undefined` values must be
 * stripped from the input object (so execute receives only real values
 * and omitted-optional fields are truly absent).
 */

import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { Tool } from "@opencode-ai/core/tool/tool"
import { ToolCall } from "@opencode-ai/llm"
import { randomUUID } from "node:crypto"

const sessionID = randomUUID()
const messageID = randomUUID()

const makeContext = (): Tool.Context => ({
  sessionID: sessionID as Tool.Context["sessionID"],
  agent: "build" as Tool.Context["agent"],
  assistantMessageID: messageID as Tool.Context["assistantMessageID"],
  toolCallID: randomUUID(),
})

const makeCall = (name: string, input: unknown): ToolCall => ({
  type: "tool-call",
  id: randomUUID(),
  name,
  input,
})

type OkOutput = { ok: true }
type NodesOutput = { nodes: unknown[] }
type GenericOutput = Record<string, unknown>

async function settleOk(tool: Tool.AnyTool, input: unknown) {
  const result = await Effect.runPromise(
    Tool.settle(tool, makeCall("test_tool", input), makeContext()),
  )
  return result as { structured: OkOutput }
}

async function settleNodes(tool: Tool.AnyTool, input: unknown) {
  const result = await Effect.runPromise(
    Tool.settle(tool, makeCall("test_tool", input), makeContext()),
  )
  return result as { structured: NodesOutput }
}

async function settleGeneric(tool: Tool.AnyTool, input: unknown) {
  const result = await Effect.runPromise(
    Tool.settle(tool, makeCall("test_tool", input), makeContext()),
  )
  return result as { structured: GenericOutput }
}

describe("tool null normalization", () => {
  describe("settle strips null from optional fields before decode", () => {
    test("null field is absent from decoded input (optional string)", async () => {
      const tool = Tool.make({
        description: "test",
        input: Schema.Struct({
          foo: Schema.String.pipe(Schema.optional),
          bar: Schema.String.pipe(Schema.optional),
        }),
        output: Schema.Struct({ ok: Schema.Literal(true) }),
        execute: (input) => {
          expect(Object.keys(input)).not.toContain("foo")
          expect(Object.keys(input)).not.toContain("bar")
          return Effect.succeed({ ok: true as const })
        },
      })

      const result = await settleOk(tool, { foo: null, bar: null })
      expect(result.structured.ok).toBe(true)
    })

    test("null field is absent from decoded input (optional number)", async () => {
      const tool = Tool.make({
        description: "test",
        input: Schema.Struct({
          limit: Schema.Number.pipe(Schema.optional),
          maxDepth: Schema.Number.pipe(Schema.optional),
        }),
        output: Schema.Struct({ ok: Schema.Literal(true) }),
        execute: (input) => {
          expect(Object.keys(input)).not.toContain("limit")
          expect(Object.keys(input)).not.toContain("maxDepth")
          return Effect.succeed({ ok: true as const })
        },
      })

      const result = await settleOk(tool, { limit: null, maxDepth: null })
      expect(result.structured.ok).toBe(true)
    })

    test("mixed null and real values — null fields stripped, real fields preserved", async () => {
      const tool = Tool.make({
        description: "test",
        input: Schema.Struct({
          nodeID: Schema.String.pipe(Schema.optional),
          function: Schema.String.pipe(Schema.optional),
          limit: Schema.Number.pipe(Schema.optional),
        }),
        output: Schema.Struct({ ok: Schema.Literal(true) }),
        execute: (input) => {
          expect(Object.keys(input)).not.toContain("nodeID")
          expect(Object.keys(input)).not.toContain("limit")
          expect(input).toEqual({ function: "parse" })
          return Effect.succeed({ ok: true as const })
        },
      })

      const result = await settleOk(tool, { nodeID: null, function: "parse", limit: null })
      expect(result.structured.ok).toBe(true)
    })

    test("undefined field is absent from decoded input (regression baseline)", async () => {
      const tool = Tool.make({
        description: "test",
        input: Schema.Struct({
          foo: Schema.String.pipe(Schema.optional),
        }),
        output: Schema.Struct({ ok: Schema.Literal(true) }),
        execute: (input) => {
          expect(Object.keys(input)).not.toContain("foo")
          return Effect.succeed({ ok: true as const })
        },
      })

      const result = await settleOk(tool, { foo: undefined })
      expect(result.structured.ok).toBe(true)
    })

    test("omitted field is absent from decoded input (regression baseline)", async () => {
      const tool = Tool.make({
        description: "test",
        input: Schema.Struct({
          foo: Schema.String.pipe(Schema.optional),
        }),
        output: Schema.Struct({ ok: Schema.Literal(true) }),
        execute: (input) => {
          expect(Object.keys(input)).not.toContain("foo")
          return Effect.succeed({ ok: true as const })
        },
      })

      const result = await settleOk(tool, {})
      expect(result.structured.ok).toBe(true)
    })
  })

  describe("existing BanyanCode tool inputs tolerate null", () => {
    test("codegraph InputQuery fields accept null", async () => {
      const { InputQuery } = await import("@opencode-ai/core/tool/codegraph")

      const tool = Tool.make({
        description: "test",
        input: InputQuery,
        output: Schema.Struct({ nodes: Schema.Array(Schema.Any), meta: Schema.Any }),
        execute: () => Effect.succeed({ nodes: [], meta: undefined }),
      })

      const result = await settleNodes(tool, { file: null, function: null, kind: null, limit: null })
      expect(result.structured.nodes).toEqual([])
    })

    test("codegraph InputImpact fields accept null", async () => {
      const { InputImpact } = await import("@opencode-ai/core/tool/codegraph")

      const tool = Tool.make({
        description: "test",
        input: InputImpact,
        output: Schema.Struct({
          dependents: Schema.Array(Schema.Any),
          transitive: Schema.Array(Schema.Any),
          meta: Schema.Any,
        }),
        execute: () => Effect.succeed({ dependents: [], transitive: [], meta: undefined }),
      })

      const result = await settleGeneric(tool, { nodeID: null, function: null, maxDepth: null, limit: null })
      expect(result.structured.dependents).toEqual([])
    })

    test("codegraph InputDependents fields accept null", async () => {
      const { InputDependents } = await import("@opencode-ai/core/tool/codegraph")

      const tool = Tool.make({
        description: "test",
        input: InputDependents,
        output: Schema.Struct({ dependents: Schema.Array(Schema.Any), meta: Schema.Any }),
        execute: () => Effect.succeed({ dependents: [], meta: undefined }),
      })

      const result = await settleGeneric(tool, { nodeID: null, function: null, limit: null })
      expect(result.structured.dependents).toEqual([])
    })

    test("codegraph InputCallers fields accept null", async () => {
      const { InputCallers } = await import("@opencode-ai/core/tool/codegraph")

      const tool = Tool.make({
        description: "test",
        input: InputCallers,
        output: Schema.Struct({ callers: Schema.Array(Schema.Any), meta: Schema.Any }),
        execute: () => Effect.succeed({ callers: [], meta: undefined }),
      })

      const result = await settleGeneric(tool, { nodeID: null, function: null, limit: null })
      expect(result.structured.callers).toEqual([])
    })

    test("repository-wave2 QueryInput accepts null", async () => {
      const { InputQuery } = await import("@opencode-ai/core/tool/repository-wave2")

      const tool = Tool.make({
        description: "test",
        input: InputQuery,
        output: Schema.Struct({ query: Schema.String }),
        execute: (input) => Effect.succeed({ query: input.query }),
      })

      const result = await settleGeneric(tool, { query: "test", limit: null, workspace: null })
      expect(result.structured.query).toBe("test")
    })

    test("repository-wave2 TraceInput accepts null", async () => {
      const { InputTrace } = await import("@opencode-ai/core/tool/repository-wave2")

      const tool = Tool.make({
        description: "test",
        input: InputTrace,
        output: Schema.Struct({
          summary: Schema.String,
          entrypoints: Schema.Array(Schema.Any),
          importantSymbols: Schema.Array(Schema.Any),
          relatedTests: Schema.Array(Schema.Any),
          relatedDocs: Schema.Array(Schema.Any),
          configs: Schema.Array(Schema.Any),
          routes: Schema.Array(Schema.Any),
          dependencies: Schema.Array(Schema.Any),
        }),
        execute: () =>
          Effect.succeed({
            summary: "test",
            entrypoints: [],
            importantSymbols: [],
            relatedTests: [],
            relatedDocs: [],
            configs: [],
            routes: [],
            dependencies: [],
          }),
      })

      const result = await settleGeneric(tool, { symbol: "foo", depth: null, workspace: null })
      expect(result.structured.summary).toBe("test")
    })

    test("codegraph-search-tool Input accepts null", async () => {
      const { Input } = await import("@opencode-ai/core/tool/codegraph-search-tool")

      const tool = Tool.make({
        description: "test",
        input: Input,
        output: Schema.Struct({ results: Schema.Array(Schema.Any) }),
        execute: () => Effect.succeed({ results: [] }),
      })

      const result = await settleGeneric(tool, { query: "foo", modes: null, limit: null })
      expect(result.structured.results).toEqual([])
    })

    test("code-find Input rejects null target and missing fallback flag", async () => {
      const { Input } = await import("@opencode-ai/core/tool/code-find")

      const tool = Tool.make({
        description: "test",
        input: Input,
        output: Schema.Struct({
          matches: Schema.Array(Schema.Any),
          files: Schema.Array(Schema.Any),
          intent: Schema.String,
        }),
        execute: () => Effect.succeed({ matches: [], files: [], intent: "definition" }),
      })

      // `target` is required — null must be rejected so the agent can't ship
      // empty intent="callers" queries that silently return zero rows.
      const nullTarget = settleGeneric(tool, {
        intent: "definition",
        target: null,
        includeKeywordFallback: true,
        limit: null,
      })
      await expect(nullTarget).rejects.toThrow(/target/)

      // `includeKeywordFallback` is required — same reasoning.
      const missingFallback = settleGeneric(tool, {
        intent: "definition",
        target: "MemoryRepo",
        includeKeywordFallback: null,
        limit: null,
      })
      await expect(missingFallback).rejects.toThrow(/includeKeywordFallback/)
    })

    test("websearch-free Input accepts null", async () => {
      const { Input } = await import("@opencode-ai/core/tool/websearch-free")

      const tool = Tool.make({
        description: "test",
        input: Input,
        output: Schema.Struct({
          provider: Schema.Literal("duckduckgo"),
          text: Schema.String,
          results: Schema.Array(Schema.Any),
        }),
        execute: () => Effect.succeed({ provider: "duckduckgo" as const, text: "", results: [] }),
      })

      const result = await settleGeneric(tool, { query: "test", numResults: null, region: null, time: null })
      expect(result.structured.provider).toBe("duckduckgo")
    })

    test("structural-queries findRecursive Input accepts null", async () => {
      const { name_find_recursive } = await import("@opencode-ai/core/tool/structural-queries-tool")

      const tool = Tool.make({
        description: "test",
        input: Schema.Struct({
          file: Schema.String.pipe(Schema.optional),
          language: Schema.String.pipe(Schema.optional),
        }),
        output: Schema.Struct({ nodes: Schema.Array(Schema.Any) }),
        execute: () => Effect.succeed({ nodes: [] }),
      })

      const result = await settleNodes(tool, { file: null, language: null })
      expect(result.structured.nodes).toEqual([])
    })

    test("edit_plan Input accepts null for all optional fields", async () => {
      const { Input } = await import("@opencode-ai/core/tool/edit-plan")

      const tool = Tool.make({
        description: "test",
        input: Input,
        output: Schema.Struct({ plan: Schema.Any }),
        execute: () =>
          Effect.succeed({
            plan: {
              steps: [],
              expectedImpact: { directDependents: 0, transitiveDependents: 0 },
              risks: [],
            },
          }),
      })

      const result = await settleGeneric(tool, {
        phase: "before",
        targetSymbol: "foo",
        changeKind: null,
        filePath: null,
        diff: null,
        root: null,
      })
      expect(result.structured.plan).toBeDefined()
    })
  })

  describe("null is normalized to undefined, not stripped after decode", () => {
    test("schema receives undefined (not null) for null input on optional string", async () => {
      let receivedInput: { foo?: string | undefined } = {}
      const tool = Tool.make({
        description: "test",
        input: Schema.Struct({
          foo: Schema.String.pipe(Schema.optional),
        }),
        output: Schema.Struct({ ok: Schema.Literal(true) }),
        execute: (input) => {
          receivedInput = input as typeof receivedInput
          return Effect.succeed({ ok: true as const })
        },
      })

      await Effect.runPromise(Tool.settle(tool, makeCall("test_tool", { foo: null }), makeContext()))

      expect(receivedInput.foo).toBeUndefined()
      expect(receivedInput.foo).not.toBeNull()
    })
  })
})
