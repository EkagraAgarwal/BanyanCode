import { describe, expect, it } from "bun:test"
import { parseTypeScript } from "@opencode-ai/core/banyancode/langs/typescript"

describe("typescript parser", () => {
  it("emits imports edges", () => {
    const code = `
      import { Foo } from "./foo"
      import Bar from "./bar"
      export class Service {}
    `
    const result = parseTypeScript(code, "test-file-id")
    const imports = result.edges.filter((e) => e.kind === "imports")
    expect(imports.length).toBeGreaterThanOrEqual(2)
    expect(imports.some((e) => e.toNodeID === "module:./foo")).toBe(true)
    expect(imports.some((e) => e.toNodeID === "module:./bar")).toBe(true)
  })
})
