import { describe, expect, test } from "bun:test"
import { parseTypeScript } from "@opencode-ai/core/banyancode/langs/typescript"

// Arrow-function node ranges drive caller attribution: an edge belongs to the
// node whose range encloses the call site, so an overrun into the next
// function (or a range cut short at an inner block) misattributes callers.
describe("parseTypeScript arrow-function ranges", () => {
  test("arrow bodies end at their own closing brace", () => {
    const source = [
      "export const outer = (input: string): string => {",
      "  if (!input) {",
      "    throw new Error('empty')",
      "  }",
      "  return input",
      "}",
      "",
      "export const flat = (input: string): string => {",
      "  return input.trim()",
      "}",
      "",
      "export const caller = (value: string): boolean => {",
      "  return flat(value) === outer(value)",
      "}",
    ].join("\n")
    const ranges = Object.fromEntries(
      parseTypeScript(source, "fid")
        .nodes.filter((node) => node.kind === "function")
        .map((node) => [node.name, [node.startLine, node.endLine]]),
    )
    expect(ranges).toEqual({ outer: [1, 6], flat: [8, 10], caller: [12, 14] })
  })
})
