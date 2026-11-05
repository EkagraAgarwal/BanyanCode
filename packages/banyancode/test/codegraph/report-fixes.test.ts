import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { CodeFindToolInput } from "../../src/intel/tools.js"

describe("code_find input", () => {
  test("includeKeywordFallback can be left out", () => {
    const decoded = Schema.decodeUnknownSync(CodeFindToolInput)({ intent: "definition", target: "Calculator" })
    expect(decoded.target).toBe("Calculator")
    expect(decoded.includeKeywordFallback).toBeUndefined()
  })
})
