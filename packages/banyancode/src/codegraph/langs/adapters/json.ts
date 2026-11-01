import type { NodeKindMapping } from "./types"

/**
 * JSON (tree-sitter-json, verified S-exprs):
 *   (document (object (pair key: (string (string_content)) value: ...)))
 * No functions/classes/types — every key/value `pair` becomes a variable
 * named after its key (quotes stripped). Top-level and nested keys alike.
 */
export const JSON_MAPPING: NodeKindMapping = new Map([
  ["pair", { kind: "variable", nameField: "key" }],
])
