import type { NodeKindMapping } from "./types"

/**
 * Zig (tree-sitter-zig, verified S-exprs):
 *   (function_declaration name: (identifier) (parameters ...) type: (builtin_type) body: (block))
 *   (variable_declaration (identifier) (struct_declaration (container_field ...)))   — `pub const Point = struct {...}` → class
 *   (variable_declaration (identifier) (builtin_function ...))                        — `const std = @import(...)` → variable
 * variable_declaration has NO field names: the first named child is the
 * identifier (`pub`/`const` keywords are anonymous, verified by probe).
 * A variable_declaration whose named children include a struct_declaration
 * is a class; anything else is a variable.
 */
export const ZIG_MAPPING: NodeKindMapping = new Map([
  ["function_declaration", { kind: "function", nameField: "name" }],
  ["variable_declaration", { kind: "variable", kindByChildType: [{ childType: "struct_declaration", kind: "class" }] }],
])
