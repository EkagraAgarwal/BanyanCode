/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { readFileSync } from "fs"
import { resolve } from "path"

/**
 * Regression suite for the LSP telemetry upgrade. The component itself is
 * exercised end-to-end by the opencode LSP layer tests; here we only need
 * to lock in the visible text strings so the upgrade cannot silently drop a
 * telemetry feature.
 */
const source = readFileSync(
  resolve(__dirname, "../../../src/feature-plugins/sidebar/lsp.tsx"),
  "utf8",
)

test("sidebar LSP surfaces three explicit states (active / inactive / off)", () => {
  expect(source).toContain(" active")
  expect(source).toContain(" inactive")
  expect(source).toContain("LSP: off")
})

test("sidebar LSP shows per-server language chips", () => {
  expect(source).toContain("item.languages")
  expect(source).toMatch(/item\.languages\.slice\(/)
})

test("sidebar LSP filters to connected entries only", () => {
  // The sidebar only renders active LSPs (status === "connected" && !disabled);
  // disabled / inert / error entries are intentionally hidden. The interface
  // still carries disabledReason so the cast doesn't lose the field.
  expect(source).toContain("disabledReason")
  expect(source).toMatch(/entry\.status === "connected"/)
  expect(source).toMatch(/!entry\.disabled/)
  expect(source).not.toContain('item.disabledReason ?? "disabled"')
})

test("header status-pills renders a colored dot and literal 'LSP' label", () => {
  const header = readFileSync(
    resolve(__dirname, "../../../src/feature-plugins/header/status-pills.tsx"),
    "utf8",
  )
  expect(header).toMatch(/<text[^>]*>●<\/text>/)
  expect(header).toMatch(/<text[^>]*>LSP<\/text>/)
  expect(header).not.toContain("lspLanguages")
  expect(header).not.toContain("lspLabel")
  expect(header).not.toContain("LSP:")
})
