import { describe, expect, it } from "bun:test"
import { parseTypeScript } from "@opencode-ai/core/banyancode/langs/typescript"

describe("Effect.fn trace name extraction", () => {
  it("extracts Effect.fn trace name for arrow function with Effect.fn", () => {
    const code = `export const ask = Effect.fn("Permission.ask")(function* (input) {
        yield* Effect.succeed(input)
      })`
    const result = parseTypeScript(code, "test-file-id")
    const fnNode = result.nodes.find((n) => n.name === "ask")
    expect(fnNode?.signature).toBe("Permission.ask")
  })

  it("no signature override when no Effect.fn present (arrow const without =>)", () => {
    const code = `export const foo = (input) => {
        return input
      }`
    const result = parseTypeScript(code, "test-file-id")
    const fnNode = result.nodes.find((n) => n.name === "foo")
    expect(fnNode?.signature).toContain("=>")
  })

  it("takes first Effect.fn when multiple are present", () => {
    const code = `export const outer = Effect.fn("Outer.outer")(function* (input) {
        const inner = Effect.fn("Inner.inner")(function* () {
          yield* Effect.succeed(input)
        })
        yield* inner
      })`
    const result = parseTypeScript(code, "test-file-id")
    const fnNode = result.nodes.find((n) => n.name === "outer")
    expect(fnNode?.signature).toBe("Outer.outer")
  })
})
