import type { NodeKindMapping } from "./types"

/**
 * Go (tree-sitter-go, verified S-exprs):
 *   (function_declaration name: (identifier) parameters: (parameter_list) body: (block))
 *   (method_declaration receiver: (parameter_list) name: (field_identifier) ...)
 *   (type_declaration (type_spec name: (type_identifier) type: (struct_type ...)))
 *   (type_declaration (type_spec name: (type_identifier) type: (interface_type ...)))
 *   (const_declaration (const_spec name: (identifier) value: (expression_list ...)))
 *   (var_declaration (var_spec name: (identifier) type: (type_identifier)))
 * Methods: method_declaration is its own node type — always a method.
 */
export const GO_MAPPING: NodeKindMapping = new Map([
  ["function_declaration", { kind: "function", nameField: "name" }],
  ["method_declaration", { kind: "method", nameField: "name", methodOnly: true }],
  [
    "type_spec",
    {
      kind: "type",
      nameField: "name",
      kindByChildType: [
        { childType: "struct_type", kind: "class" },
        { childType: "interface_type", kind: "type" },
      ],
    },
  ],
  ["var_spec", { kind: "variable", nameField: "name" }],
  ["const_spec", { kind: "variable", nameField: "name" }],
])
