import type { NodeKindMapping } from "./types"

/**
 * Bash (tree-sitter-bash, verified S-exprs):
 *   (function_definition name: (word) body: (compound_statement ...))   — both `foo() {}` and `function foo {}`
 *   (variable_assignment name: (variable_name) value: (number))          — x=1, plus inside `export PATH=...`
 * No classes/methods — functions + variables only.
 */
export const BASH_MAPPING: NodeKindMapping = new Map([
  ["function_definition", { kind: "function", nameField: "name" }],
  ["variable_assignment", { kind: "variable", nameField: "name" }],
])
