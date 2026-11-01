import type { NodeKindMapping } from "./types"

/**
 * TOML (tree-sitter-toml, verified S-exprs):
 *   (document (table (bare_key) (pair (bare_key) (string)) ...))
 * No functions/classes — `table` sections become type nodes (named by the
 * first named child, a bare_key) and key/value `pair`s become variables.
 * bare_key carries no field name; firstNamedChild is the name.
 */
export const TOML_MAPPING: NodeKindMapping = new Map([
  ["table", { kind: "type" }],
  ["pair", { kind: "variable" }],
])
