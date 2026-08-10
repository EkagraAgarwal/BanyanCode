/**
 * Regression test for zero-arg V1 tool input schemas.
 *
 * `Schema.Struct({})` projects to `{ anyOf: [{type:"object"}, {type:"array"}] }`,
 * a root with no `type: "object"` that strict tool-schema validators (OpenAI
 * Responses / GPT-5 family, etc.) reject with messages like:
 *
 *   Invalid schema for function 'plan_exit': schema must be a JSON Schema of
 *   'type: "object"', got 'type: "None"'.
 *
 * plan_exit and systeminfo declare `Schema.Record(Schema.String,
 * Schema.Unknown)` (projects to a bare `{ type: "object" }`), and
 * `ToolJsonSchema.fromSchema` additionally normalizes the empty-struct union
 * (`isEmptyStructUnion`), so both layers are pinned here. These tests use the
 * same `ToolJsonSchema.fromSchema` helper that `session/tools.ts` uses to emit
 * tool schemas to the LLM.
 */

import { describe, expect, test } from "bun:test"
import { ToolJsonSchema } from "../../src/tool/json-schema"
import { Parameters as PlanExit } from "../../src/tool/plan"
import { Parameters as SystemInfo } from "../../src/tool/systeminfo"

describe("zero-arg V1 tool schemas", () => {
  test("plan_exit projects to { type: 'object' } at the root", () => {
    const schema = ToolJsonSchema.fromSchema(PlanExit)

    expect(schema).not.toHaveProperty("anyOf")
    expect(schema).not.toHaveProperty("oneOf")
    expect(schema.type).toBe("object")
  })

  test("systeminfo projects to { type: 'object' } at the root", () => {
    const schema = ToolJsonSchema.fromSchema(SystemInfo)

    expect(schema).not.toHaveProperty("anyOf")
    expect(schema).not.toHaveProperty("oneOf")
    expect(schema.type).toBe("object")
  })
})
