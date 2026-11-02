import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Input as CodeFindInput } from "../../src/codegraph/tools/code-find.js"

describe("code_find input", () => {
  test("includeKeywordFallback can be left out", () => {
    const decoded = Schema.decodeUnknownSync(CodeFindInput)({ intent: "definition", target: "Calculator" })
    expect(decoded.target).toBe("Calculator")
    expect(decoded.includeKeywordFallback).toBeUndefined()
  })
})
