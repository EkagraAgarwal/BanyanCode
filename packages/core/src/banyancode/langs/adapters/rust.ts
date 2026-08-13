import type { NodeKindMapping } from "./types"

/**
 * Rust (tree-sitter-rust, verified S-exprs):
 *   (function_item name: (identifier) parameters: (parameters) body: (block))
 *   (function_signature_item name: (identifier) ...)   — trait method signatures
 *   (struct_item name: (type_identifier) ...)
 *   (enum_item name: (type_identifier) ...)
 *   (trait_item name: (type_identifier) ...)
 *   (union_item name: (type_identifier) ...)
 *   (type_item name: (type_identifier) ...)
 *   (impl_item type: (type_identifier) body: (declaration_list (function_item ...)))
 * Methods: function_item / function_signature_item whose ancestor chain
 * contains impl_item or trait_item.
 */
export const RUST_MAPPING: NodeKindMapping = new Map([
  ["function_item", { kind: "function", nameField: "name", methodAncestors: ["impl_item", "trait_item"] }],
  ["function_signature_item", { kind: "function", nameField: "name", methodAncestors: ["impl_item", "trait_item"] }],
  ["struct_item", { kind: "class", nameField: "name" }],
  ["union_item", { kind: "class", nameField: "name" }],
  ["enum_item", { kind: "type", nameField: "name" }],
  ["trait_item", { kind: "type", nameField: "name" }],
  ["type_item", { kind: "type", nameField: "name" }],
])
