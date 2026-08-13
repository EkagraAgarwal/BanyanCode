import type { NodeKindMapping } from "./types"

/**
 * Java (tree-sitter-java, verified S-exprs):
 *   (class_declaration (modifiers) name: (identifier) body: (class_body ...))
 *   (interface_declaration name: (identifier) body: (interface_body ...))
 *   (enum_declaration name: (identifier) body: (enum_body ...))
 *   (record_declaration name: (identifier) ...)
 *   (method_declaration (modifiers) type: (void_type) name: (identifier) ...)
 * Methods: method_declaration is its own node type — always a method.
 */
export const JAVA_MAPPING: NodeKindMapping = new Map([
  ["class_declaration", { kind: "class", nameField: "name" }],
  ["record_declaration", { kind: "class", nameField: "name" }],
  ["interface_declaration", { kind: "type", nameField: "name" }],
  ["enum_declaration", { kind: "type", nameField: "name" }],
  ["annotation_type_declaration", { kind: "type", nameField: "name" }],
  ["method_declaration", { kind: "method", nameField: "name", methodOnly: true }],
])
