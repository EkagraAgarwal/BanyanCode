import type { NodeKindMapping } from "./types"

/**
 * C (tree-sitter-c, verified S-exprs):
 *   (function_definition type: (primitive_type) declarator: (function_declarator declarator: (identifier) ...) body: (compound_statement))
 *   (struct_specifier name: (type_identifier) body: (field_declaration_list ...))
 *   (union_specifier name: (type_identifier) ...)
 *   (enum_specifier name: (type_identifier) body: (enumerator_list ...))
 *   (type_definition type: (struct_specifier ...) declarator: (type_identifier))   — typedef alias
 *   (preproc_def name: (identifier) value: (preproc_arg))                           — #define X
 *   (preproc_function_def name: (identifier) parameters: (preproc_params ...))      — #define F(x)
 *   (declaration type: (primitive_type) declarator: (init_declarator declarator: (identifier) ...)) — top-level global
 * Name: function_definition/declaration use the declarator chain (nameField
 * "declarator" -> function_declarator/init_declarator -> "declarator" -> identifier).
 * nameKinds on `declaration` excludes function_declarator so prototypes
 * (`int helper(int);`) never become variables; onlyWhenParent keeps locals
 * inside function bodies out.
 */
export const C_MAPPING: NodeKindMapping = new Map([
  ["function_definition", { kind: "function", nameField: "declarator", nameSubField: "declarator" }],
  ["struct_specifier", { kind: "class", nameField: "name" }],
  ["union_specifier", { kind: "class", nameField: "name" }],
  ["enum_specifier", { kind: "type", nameField: "name" }],
  ["type_definition", { kind: "type", nameField: "declarator" }],
  ["preproc_function_def", { kind: "function", nameField: "name" }],
  ["preproc_def", { kind: "variable", nameField: "name" }],
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
