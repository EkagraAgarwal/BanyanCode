import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { ensureWebTreeSitterReady } from "../../src/banyancode/langs/tree-sitter"
import { parseLanguageWithTreeSitter } from "../../src/banyancode/langs/query-executor"
import { parseGeneric } from "../../src/banyancode/langs/registry"

process.env.BANYANCODE_ENABLE = "1"

const RUST = `fn helper() -> i32 {
    1
}

fn compute() -> i32 {
    helper()
}
`

describe("adapter-lang regex skip (Phase 3)", () => {
  test("parseLanguageWithTreeSitter does not call regex when walk succeeds", async () => {
    await Effect.runPromise(ensureWebTreeSitterReady())
    let regexCalls = 0
    const parsed = await Effect.runPromise(
      parseLanguageWithTreeSitter(".rs", RUST, "file-1", () => {
        regexCalls++
        return parseGeneric(RUST, "file-1")
      }),
    )

    if (parsed.backend === "tree-sitter" && parsed.nodes.length > 0) {
      expect(regexCalls).toBe(0)
      expect(parsed.edges).toEqual([])
      expect(parsed.nodes.some((n) => n.name === "helper")).toBe(true)
      expect(parsed.nodes.some((n) => n.name === "compute")).toBe(true)
      return
    }

    // Wasm unavailable in this env: regex fallback is the only path.
    expect(regexCalls).toBeGreaterThanOrEqual(1)
  })
})
