import { describe, expect, test } from "bun:test"

// Phase 5 (LSP tools). The four LSP operations (`lsp_definition`,
// `lsp_references`, `lsp_hover`, `lsp_diagnostics`) are registered via
// `LspTools.locationLayer` against the upstream `Tools.Service` registry.
// The wiring is verified indirectly by the manifest contract: the public
// tool IDs surface on BANYAN_PUBLIC_TOOL_IDS so the agent-facing catalog
// can advertise them. A separate regression test
// (`v2-probe-baseline.test.ts`) confirms the count + membership.

describe("phase 5 — LSP tools manifest", () => {
  test("all four LSP tools are listed in BANYAN_PUBLIC_TOOL_IDS", async () => {
    const mod = await import("@opencode-ai/core/banyancode/banyan-tools-manifest")
    const ids = mod.BANYAN_PUBLIC_TOOL_IDS as ReadonlyArray<string>
    expect(ids).toContain("lsp_definition")
    expect(ids).toContain("lsp_references")
    expect(ids).toContain("lsp_hover")
    expect(ids).toContain("lsp_diagnostics")
  })

  test("the locationLayer export resolves and is a Layer", async () => {
    const lsp = await import("@opencode-ai/core/tool/lsp-tools")
    expect(typeof lsp.LspTools.locationLayer).toBe("object")
    expect(lsp.LspTools.locationLayer).not.toBeNull()
  })
})