// Output-helper unit tests: structural truncation, caps, error shape.
// No server involved — pure value transforms.

import { describe, expect, test } from "bun:test"
import {
  DEFAULT_OUTPUT_CHARS,
  errorResult,
  invalidArguments,
  okResult,
  resolveOutputChars,
  truncateStructured,
} from "../../src/mcp-server/output"

describe("mcp output helpers", () => {
  test("small payloads pass through unmarked", () => {
    expect(truncateStructured({ matches: [{ id: "n-1" }] })).toEqual({
      data: { matches: [{ id: "n-1" }] },
      truncated: false,
      omitted: 0,
    })
  })

  test("oversized output stays valid JSON with truncated/omitted set", () => {
    const payload = { matches: Array.from({ length: 5000 }, (_, n) => ({ id: `n-${n}`, name: "Widget", file: "src/widget.ts" })) }
    const out = truncateStructured(payload, 8000)
    expect(out.truncated).toBe(true)
    expect(out.omitted).toBeGreaterThan(0)
    const text = JSON.stringify(out.data, null, 2)
    expect(text.length).toBeLessThanOrEqual(8000)
    expect(() => JSON.parse(text)).not.toThrow()
    const roundTrip = JSON.parse(text) as { matches: unknown[] }
    expect(Array.isArray(roundTrip.matches)).toBe(true)
  })

  test("a single huge string is sliced inline, envelope stays parseable", () => {
    const out = truncateStructured({ blob: "z".repeat(20000) }, 1000)
    expect(out.truncated).toBe(true)
    const text = JSON.stringify(out.data)
    expect(text.length).toBeLessThanOrEqual(1000)
    expect(() => JSON.parse(text)).not.toThrow()
  })

  test("okResult carries structuredContent alongside the text rendering", () => {
    const result = okResult({ matches: [] })
    expect(result.isError).toBeUndefined()
    expect(result.content).toHaveLength(1)
    expect(result.content[0]?.type).toBe("text")
    expect(() => JSON.parse(result.content[0]?.text ?? "")).not.toThrow()
    expect(result.structuredContent).toEqual({ result: { matches: [] }, truncated: false, omitted: 0 })
  })

  test("error results are isError with a stable code prefix", () => {
    for (const [helper, code] of [
      [() => errorResult("PATH_ESCAPE", "path escapes project root: ../x"), "PATH_ESCAPE"],
      [() => invalidArguments('op "explain" requires "symbol".'), "INVALID_ARGUMENTS"],
      [() => errorResult("UPSTREAM_ERROR", "request failed: boom"), "UPSTREAM_ERROR"],
    ] as const) {
      const result = helper()
      expect(result.isError).toBe(true)
      expect(result.content[0]?.text.startsWith(`${code}:`)).toBe(true)
    }
  })

  test("cap resolves from explicit arg, then env, then default", () => {
    expect(DEFAULT_OUTPUT_CHARS).toBe(8000)
    expect(resolveOutputChars(1234)).toBe(1234)
    expect(resolveOutputChars()).toBe(DEFAULT_OUTPUT_CHARS)
    const prior = process.env.BANYANCODE_MCP_OUTPUT_CHARS
    try {
      process.env.BANYANCODE_MCP_OUTPUT_CHARS = "4000"
      expect(resolveOutputChars()).toBe(4000)
      process.env.BANYANCODE_MCP_OUTPUT_CHARS = "bogus"
      expect(resolveOutputChars()).toBe(DEFAULT_OUTPUT_CHARS)
    } finally {
      if (prior === undefined) delete process.env.BANYANCODE_MCP_OUTPUT_CHARS
      else process.env.BANYANCODE_MCP_OUTPUT_CHARS = prior
    }
  })
})
