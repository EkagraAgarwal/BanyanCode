import { describe, expect, test } from "bun:test"
import {
  MARKDOWN_STREAM_WINDOW_CHARS,
  TOOL_OUTPUT_TAIL_CHARS,
  TOOL_OUTPUT_TAIL_LINES,
  markdownStreamWindow,
  tailToolOutput,
} from "../../src/util/collapse-tool-output"

describe("tailToolOutput", () => {
  test("small outputs pass through untouched", () => {
    const out = "line1\nline2"
    expect(tailToolOutput(out)).toEqual({ output: out, omittedChars: 0, omittedLines: 0, overflow: false })
  })

  test("caps line count to the tail and reports omitted head lines", () => {
    const lines = Array.from({ length: TOOL_OUTPUT_TAIL_LINES + 50 }, (_, i) => `line${i}`)
    const result = tailToolOutput(lines.join("\n"))
    expect(result.overflow).toBe(true)
    expect(result.omittedLines).toBe(50)
    expect(result.output.split("\n")).toHaveLength(TOOL_OUTPUT_TAIL_LINES)
    expect(result.output.endsWith(`line${lines.length - 1}`)).toBe(true)
  })

  test("caps char count to the tail for a single huge line", () => {
    const out = "x".repeat(TOOL_OUTPUT_TAIL_CHARS + 1000)
    const result = tailToolOutput(out)
    expect(result.overflow).toBe(true)
    expect(Array.from(result.output).length).toBeLessThanOrEqual(TOOL_OUTPUT_TAIL_CHARS)
    expect(result.omittedChars).toBeGreaterThan(0)
  })
})

describe("markdownStreamWindow", () => {
  test("finished parts always render in full", () => {
    const text = "y".repeat(MARKDOWN_STREAM_WINDOW_CHARS + 5000)
    expect(markdownStreamWindow(text, true)).toBe(text)
  })

  test("small streaming bodies are untouched", () => {
    const text = "# hi\n\nbody"
    expect(markdownStreamWindow(text, false)).toBe(text)
  })

  test("huge streaming bodies are bounded to the tail window", () => {
    const text = "z".repeat(MARKDOWN_STREAM_WINDOW_CHARS + 5000)
    const windowed = markdownStreamWindow(text, false)
    expect(Array.from(windowed).length).toBeLessThanOrEqual(MARKDOWN_STREAM_WINDOW_CHARS + 2)
    expect(windowed.endsWith("z")).toBe(true)
  })
})
