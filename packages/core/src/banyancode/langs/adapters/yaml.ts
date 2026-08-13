import type { NodeKindMapping } from "./types"

/**
 * YAML (tree-sitter-yaml, verified S-exprs):
 *   (stream (document (block_node (block_mapping (block_mapping_pair key: (flow_node (plain_scalar (string_scalar))) value: ...)))))
 * No functions/classes — every mapping pair becomes a variable named after
 * its key. The key node is a flow_node; nameDepth=2 descends
 * flow_node -> plain_scalar -> string_scalar for the raw key text (quoted
 * keys land on double_quote_scalar at depth 1 and are quote-stripped).
 */
export const YAML_MAPPING: NodeKindMapping = new Map([
  ["block_mapping_pair", { kind: "variable", nameField: "key", nameDepth: 2 }],
])
