/**
 * Regression test for zero-arg diagnostic tool input schemas.
 *
 * `Schema.Struct({})` (the previous Input declaration for memory_stats and
 * mesh_status) projects to:
 *
 *   { "anyOf": [ { "type": "object" }, { "type": "array" } ] }
 *
 * a root with no `type: "object"`. Strict tool-schema validators (OpenAI
 * Responses / GPT-5 family, and any provider that enforces `type ===
 * "object"` at the schema root) reject requests that ship such a schema:
 *
 *   Invalid schema for function 'memory_stats': schema must be a JSON Schema
 *   of 'type: "object"', got 'type: "None"'.
 *
 * The tools now declare `Schema.Record(Schema.String, Schema.Unknown)` (same
 * fix as system_status, see system-status.ts:11-16), and the core
 * `Tool.make` projection normalizes the empty-struct union anyway so any
 * future zero-arg tool cannot regress. These tests pin both layers.
 */

import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { MemoryStatsTool } from "../../src/tool/memory-stats"
import { MeshStatusTool } from "../../src/tool/mesh-status"
import { Tool } from "../../src/tool/tool"

describe("zero-arg diagnostic tool input schemas", () => {
  test("memory_stats projects to { type: 'object' } at the root", () => {
    const doc = Schema.toJsonSchemaDocument(MemoryStatsTool.Input)
    const schema = doc.schema as Record<string, unknown>

    expect(schema).not.toHaveProperty("anyOf")
    expect(schema).not.toHaveProperty("oneOf")
    expect(schema.type).toBe("object")
  })

  test("mesh_status projects to { type: 'object' } at the root", () => {
    const doc = Schema.toJsonSchemaDocument(MeshStatusTool.Input)
    const schema = doc.schema as Record<string, unknown>

    expect(schema).not.toHaveProperty("anyOf")
    expect(schema).not.toHaveProperty("oneOf")
    expect(schema.type).toBe("object")
  })

  test("Tool.make normalizes an empty-struct input in the definition it ships to providers", () => {
    const probe = Tool.make({
      description: "probe zero-arg tool",
      input: Schema.Struct({}),
      output: Schema.Struct({ ok: Schema.Boolean }),
      execute: () => Effect.succeed({ ok: true }),
    })
    const definition = Tool.definition("probe", probe)

    expect(definition.inputSchema).not.toHaveProperty("anyOf")
    expect(definition.inputSchema).not.toHaveProperty("oneOf")
    expect(definition.inputSchema).toMatchObject({ type: "object" })
  })
})
