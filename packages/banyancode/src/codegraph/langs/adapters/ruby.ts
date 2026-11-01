import type { NodeKindMapping } from "./types"

/**
 * Ruby (tree-sitter-ruby, verified S-exprs):
 *   (class name: (constant) body: (body_statement ...))
 *   (module name: (constant) body: (body_statement ...))
 *   (method name: (identifier) parameters: (method_parameters ...) body: (body_statement ...))
 *   (singleton_method object: (self) name: (identifier) body: ...)
 * Methods: a `method` whose ancestor chain contains class/module; top-level
 * `def foo` stays a function. singleton_method (def self.x) is always a method.
 */
export const RUBY_MAPPING: NodeKindMapping = new Map([
  ["class", { kind: "class", nameField: "name" }],
  ["module", { kind: "type", nameField: "name" }],
  ["method", { kind: "function", nameField: "name", methodAncestors: ["class", "module"] }],
  ["singleton_method", { kind: "method", nameField: "name", methodOnly: true }],
])
