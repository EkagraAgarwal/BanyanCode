import type { NodeKindMapping } from "./types"

/**
 * C++ (tree-sitter-cpp, verified S-exprs):
 *   (class_specifier name: (type_identifier) body: (field_declaration_list ...))
 *   (struct_specifier name: (type_identifier) body: (field_declaration_list ...))
 *   (function_definition type: (primitive_type) declarator: (function_declarator declarator: (identifier) ...) body: ...)
 *   (function_definition ... declarator: (function_declarator declarator: (qualified_identifier scope: (namespace_identifier) name: (identifier)) ...)) — out-of-line Widget::draw
 *   (type_definition ... declarator: (type_identifier))
 *   (declaration type: (primitive_type) declarator: (init_declarator declarator: (identifier) ...))
 * Methods: function_definition is a method when an ancestor is a
 * class_specifier/struct_specifier (inline definitions) or when the resolved
 * declarator name is a qualified_identifier (`Widget::draw` out-of-line).
 */
export const CPP_MAPPING: NodeKindMapping = new Map([
  [
    "function_definition",
    {
      kind: "function",
      nameField: "declarator",
      nameSubField: "declarator",
      methodAncestors: ["class_specifier", "struct_specifier"],
      methodNameTypes: ["qualified_identifier"],
    },
  ],
  ["class_specifier", { kind: "class", nameField: "name" }],
  ["struct_specifier", { kind: "class", nameField: "name" }],
  ["union_specifier", { kind: "class", nameField: "name" }],
  ["enum_specifier", { kind: "type", nameField: "name" }],
  ["type_definition", { kind: "type", nameField: "declarator" }],
  [
    "declaration",
    {
      kind: "variable",
      nameField: "declarator",
      nameSubField: "declarator",
      nameKinds: ["identifier", "init_declarator"],
      onlyWhenParent: ["translation_unit"],
    },
  ],
])
