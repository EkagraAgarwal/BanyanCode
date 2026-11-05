import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Definition as IntelDefinition } from "../../src/intel/rpc.js"
import { Definition as VerifyDefinition } from "../../src/verify/rpc.js"
import { INTEL_TOOL_NAMES } from "../../src/intel/index.js"
import { NAME_COMPILE, NAME_LINT, NAME_TEST, NAME_TYPECHECK } from "../../src/verify/tools.js"

/**
 * Parity rows (v2-parity.md section 5 and 1a/1c): the RPC method set and the
 * tool IDs are stable public names. These assertions fail loudly if someone
 * renames a method or drops a tool during a refactor.
 */
describe("workstream 3c public surface", () => {
  test("intel RPC mirrors every v1 intel route", () => {
    expect(IntelDefinition.id).toBe("banyancode.intel")
    expect(Object.keys(IntelDefinition.methods).sort()).toEqual(
      [
        "blastRadius",
        "codeFind",
        "explain",
        "impact",
        "ownership",
        "preflight",
        "query",
        "relationships",
        "safeRename",
        "slice",
        "symbols",
        "tests",
        "trace",
      ].sort(),
    )
    expect(Object.keys(IntelDefinition.events)).toEqual([])
  })

  test("codeFind accepts a call without includeKeywordFallback and defaults it on", () => {
    const decoded = Schema.decodeUnknownSync(IntelDefinition.methods.codeFind.input)({
      intent: "definition",
      target: "add",
    })
    expect(decoded.includeKeywordFallback).toBeUndefined()
    expect(
      Schema.decodeUnknownSync(IntelDefinition.methods.codeFind.input)({
        intent: "definition",
        target: "add",
        includeKeywordFallback: false,
      }).includeKeywordFallback,
    ).toBe(false)
  })

  test("verify RPC mirrors every v1 verify route", () => {
    expect(VerifyDefinition.id).toBe("banyancode.verify")
    expect(Object.keys(VerifyDefinition.methods).sort()).toEqual(["lint", "test", "typecheck"])
    expect(Object.keys(VerifyDefinition.events)).toEqual([])
  })

  test("tool IDs are the consolidated surface", () => {
    expect(INTEL_TOOL_NAMES).toEqual({
      codeFind: "code_find",
      repo: "repo",
      changeCheck: "change_check",
      safeRename: "safe_rename",
    })
    expect(NAME_TEST).toBe("banyan_test")
    expect(NAME_TYPECHECK).toBe("banyan_typecheck")
    expect(NAME_LINT).toBe("banyan_lint")
    expect(NAME_COMPILE).toBe("banyan_compile")
  })
})
