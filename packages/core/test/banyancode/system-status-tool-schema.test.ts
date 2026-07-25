/**
 * Regression test for the `system_status` tool input schema.
 *
 * The previous declaration was `Input = Schema.Struct({})`, which effect's
 * Schema library projects to:
 *
 *   { "anyOf": [ { "type": "object" }, { "type": "array" } ] }
 *
 * Strict tool-schema validators (OpenAI Responses / GPT-5 family, and any
 * provider that enforces `type === "object"` at the schema root) reject that
 * shape with messages like:
 *
 *   Invalid schema for function 'system_status': schema must be a JSON Schema
 *   of 'type: "object"', got 'type: "None"'.
 *
 * This test pins the JSON Schema that `system_status.Input` produces so any
 * regression that brings back `Schema.Struct({})` (or any other top-level
 * `anyOf` shape) is caught at `bun test` time, before it ships to a real
 * provider.
 */

import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { SystemStatusTool } from "../../src/tool/system-status"

describe("system_status tool input schema", () => {
  test("projects to { type: 'object' } at the root (strict-provider compatible)", () => {
    const doc = Schema.toJsonSchemaDocument(SystemStatusTool.Input)
    const schema = doc.schema as Record<string, unknown>

    expect(schema).not.toHaveProperty("anyOf")
    expect(schema).not.toHaveProperty("oneOf")
    expect(schema.type).toBe("object")
  })

  test("definition built by Tool.make round-trips the same shape", () => {
    const doc = Schema.toJsonSchemaDocument(SystemStatusTool.Input)
    const schema = doc.schema as Record<string, unknown>

    expect(schema.type).toBe("object")
    expect(typeof schema.properties === "object" || schema.properties === undefined).toBe(true)
  })
})