import type { NodeKindMapping } from "./types"

/**
 * PHP (tree-sitter-php, php_only grammar, verified S-exprs):
 *   (class_declaration name: (name) body: (declaration_list ...))
 *   (interface_declaration name: (name) body: (declaration_list ...))
 *   (trait_declaration name: (name) body: (declaration_list ...))
 *   (enum_declaration name: (name) body: (enum_declaration_list ...))
 *   (function_definition name: (name) parameters: (formal_parameters) body: (compound_statement))
 *   (method_declaration (visibility_modifier) name: (name) parameters: (formal_parameters) body: ...)
 * Methods: method_declaration is its own node type — always a method.
 * anonymous_function has no name — naturally skipped by name resolution.
 */
export const PHP_MAPPING: NodeKindMapping = new Map([
  ["class_declaration", { kind: "class", nameField: "name" }],
  ["interface_declaration", { kind: "type", nameField: "name" }],
  ["trait_declaration", { kind: "type", nameField: "name" }],
  ["enum_declaration", { kind: "type", nameField: "name" }],
  ["function_definition", { kind: "function", nameField: "name" }],
  ["method_declaration", { kind: "method", nameField: "name", methodOnly: true }],
])
