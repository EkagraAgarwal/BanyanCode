/**
 * Phase 2 tool-contract regression tests.
 *
 * Tests that Tool.make accepts an optional `contract` field and that the
 * resulting tool's Def carries the contract with the correct values and defaults.
 *
 * Contract fields and their defaults:
 *   visibility:   "public" | "advanced" | "internal"  (default: "public")
 *   acceptsNull:  boolean                                 (default: true)
 *   repairPolicy: "one-pass" | "strict" | "never"        (default: "one-pass")
 *
 * NOTE: These tests specify Phase 2 behavior. They will fail at runtime until
 * Tool.make is extended with the `contract` field.
 */

import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { Tool } from "@opencode-ai/core/tool/tool"

type Contract = {
  visibility: "public" | "advanced" | "internal"
  acceptsNull: boolean
  repairPolicy: "one-pass" | "strict" | "never"
}

function getContract(tool: unknown): Contract | undefined {
  return (tool as any).contract as Contract | undefined
}

describe("Tool.make contract field", () => {
  test("no contract → defaults visibility to public", () => {
    const tool = Tool.make({
      description: "A test tool",
      input: Schema.Struct({}),
      output: Schema.Struct({}),
      execute: () => Effect.succeed({}),
    })

    const contract = getContract(tool)
    expect(contract).toBeDefined()
    expect(contract!.visibility).toBe("public")
  })

  test("contract.visibility.internal is stored on the tool", () => {
    const tool = Tool.make({
      description: "An internal tool",
      input: Schema.Struct({}),
      output: Schema.Struct({}),
      execute: () => Effect.succeed({}),
      // @ts-ignore - contract field added in Phase 2
      contract: { visibility: "internal" },
    })

    const contract = getContract(tool)
    expect(contract).toBeDefined()
    expect(contract!.visibility).toBe("internal")
  })

  test("contract.visibility.advanced is stored on the tool", () => {
    const tool = Tool.make({
      description: "An advanced tool",
      input: Schema.Struct({}),
      output: Schema.Struct({}),
      execute: () => Effect.succeed({}),
      // @ts-ignore - contract field added in Phase 2
      contract: { visibility: "advanced" },
    })

    const contract = getContract(tool)
    expect(contract).toBeDefined()
    expect(contract!.visibility).toBe("advanced")
  })

  test("contract.visibility defaults to public even when other fields are set", () => {
    const tool = Tool.make({
      description: "A tool with partial contract",
      input: Schema.Struct({}),
      output: Schema.Struct({}),
      execute: () => Effect.succeed({}),
      // @ts-ignore - contract field added in Phase 2
      contract: { acceptsNull: false },
    })

    const contract = getContract(tool)
    expect(contract).toBeDefined()
    expect(contract!.visibility).toBe("public")
    expect(contract!.acceptsNull).toBe(false)
  })

  test("contract.repairPolicy.strict is stored on the tool", () => {
    const tool = Tool.make({
      description: "A strict repair tool",
      input: Schema.Struct({}),
      output: Schema.Struct({}),
      execute: () => Effect.succeed({}),
      // @ts-ignore - contract field added in Phase 2
      contract: { repairPolicy: "strict" },
    })

    const contract = getContract(tool)
    expect(contract).toBeDefined()
    expect(contract!.repairPolicy).toBe("strict")
  })

  test("contract.repairPolicy.never is stored on the tool", () => {
    const tool = Tool.make({
      description: "A never repair tool",
      input: Schema.Struct({}),
      output: Schema.Struct({}),
      execute: () => Effect.succeed({}),
      // @ts-ignore - contract field added in Phase 2
      contract: { repairPolicy: "never" },
    })

    const contract = getContract(tool)
    expect(contract).toBeDefined()
    expect(contract!.repairPolicy).toBe("never")
  })

  test("contract.acceptsNull.false is stored on the tool", () => {
    const tool = Tool.make({
      description: "A no-null tool",
      input: Schema.Struct({}),
      output: Schema.Struct({}),
      execute: () => Effect.succeed({}),
      // @ts-ignore - contract field added in Phase 2
      contract: { acceptsNull: false },
    })

    const contract = getContract(tool)
    expect(contract).toBeDefined()
    expect(contract!.acceptsNull).toBe(false)
  })

  test("contract.acceptsNull.true is stored on the tool", () => {
    const tool = Tool.make({
      description: "A null-ok tool",
      input: Schema.Struct({}),
      output: Schema.Struct({}),
      execute: () => Effect.succeed({}),
      // @ts-ignore - contract field added in Phase 2
      contract: { acceptsNull: true },
    })

    const contract = getContract(tool)
    expect(contract).toBeDefined()
    expect(contract!.acceptsNull).toBe(true)
  })

  test("full contract round-trip", () => {
    const tool = Tool.make({
      description: "A fully-specified contract tool",
      input: Schema.Struct({}),
      output: Schema.Struct({}),
      execute: () => Effect.succeed({}),
      // @ts-ignore - contract field added in Phase 2
      contract: {
        visibility: "advanced",
        acceptsNull: false,
        repairPolicy: "strict",
      },
    })

    const contract = getContract(tool)
    expect(contract).toBeDefined()
    expect(contract!.visibility).toBe("advanced")
    expect(contract!.acceptsNull).toBe(false)
    expect(contract!.repairPolicy).toBe("strict")
  })

  test("defaults compose correctly when only some fields are specified", () => {
    const tool = Tool.make({
      description: "A partially-specified contract tool",
      input: Schema.Struct({}),
      output: Schema.Struct({}),
      execute: () => Effect.succeed({}),
      // @ts-ignore - contract field added in Phase 2
      contract: { visibility: "internal" },
    })

    const contract = getContract(tool)
    expect(contract).toBeDefined()
    expect(contract!.visibility).toBe("internal")
    expect(contract!.acceptsNull).toBe(true)
    expect(contract!.repairPolicy).toBe("one-pass")
  })
})
