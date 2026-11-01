import type { NodeKindMapping } from "./types"

/**
 * C# (tree-sitter-c-sharp, verified S-exprs):
 *   (class_declaration (modifier) name: (identifier) body: (declaration_list ...))
 *   (struct_declaration name: (identifier) body: (declaration_list ...))
 *   (interface_declaration name: (identifier) body: (declaration_list ...))
 *   (enum_declaration name: (identifier) body: (enum_member_declaration_list ...))
 *   (method_declaration (modifier) returns: (predefined_type) name: (identifier) parameters: (parameter_list) body: (block))
 *   (property_declaration type: (predefined_type) name: (identifier) accessors: (accessor_list))
 *   (record_declaration name: (identifier) ...)
 *   (delegate_declaration name: (identifier) ...)
 * Methods: method_declaration is its own node type — always a method.
 */
export const CSHARP_MAPPING: NodeKindMapping = new Map([
  ["class_declaration", { kind: "class", nameField: "name" }],
  ["record_declaration", { kind: "class", nameField: "name" }],
  ["struct_declaration", { kind: "class", nameField: "name" }],
  ["interface_declaration", { kind: "type", nameField: "name" }],
  ["enum_declaration", { kind: "type", nameField: "name" }],
  ["delegate_declaration", { kind: "type", nameField: "name" }],
  ["method_declaration", { kind: "method", nameField: "name", methodOnly: true }],
  ["property_declaration", { kind: "variable", nameField: "name" }],
])
