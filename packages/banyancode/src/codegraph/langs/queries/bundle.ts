/**
 * Query sources for the TS/JS/Python tree-sitter edge extraction.
 *
 * These were `.scm` text imports in v1 (`import x from "./queries/x.scm" with
 * { type: "text" }`). v2 inlines them as plain strings so the plugin bundle
 * needs no text-loader support and the sources survive every bundler.
 * Generated from src/codegraph/langs/queries/*.scm — keep in sync.
 */

export const QUERY_SOURCES: Readonly<Record<string, string>> = {
  typescript: `; Phase 2b codegraph edges (tree-sitter-v1)
; These run in O(N) over the AST after tree-sitter parses the file.
; Each pattern emits captures that query-executor.ts converts to ParsedEdge.

; --- yield* / yield expressions: fromNodeID = enclosing function, toNodeID = service:<text> ---
; tree-sitter-typescript: yield_expression has no fields; the argument is an
; unnamed child (type \`expression\`). Matching with the \`expression\` type
; gives us every yield regardless of whether the argument is a member_access
; (yield* Foo.Service), an identifier (yield Bar), or anything else.
(yield_expression
  (expression) @yielded.arg)

; --- call_expression with identifier callee: foo() ---
(call_expression
  function: (identifier) @callee.name)

; --- call_expression with member-expression callee: obj.method() ---
(call_expression
  function: (member_expression
    object: (_) @callee.object
    property: (property_identifier) @callee.property))

; --- Context.Service<...>()("tag") registration on a class ---
; Matches: class Service extends X.Service<...>()("...") {}
; Tree-sitter-typescript: class_declaration's extends is reached via
; (class_heritage (extends_clause value: <expr> ...)). Both class_heritage
; and extends_clause are children (un-named fields), so they appear as
; un-prefixed node-type patterns. The full registration is:
;   <member_expression "X.Service">()(<string "tag">)
; which tree-sitter parses as an outer call_expression whose \`function\`
; is an inner call_expression (the empty-args \`X.Service<...>()\`).
(class_declaration
  name: (type_identifier) @class.name
  (class_heritage
    (extends_clause
      value: (call_expression
        function: (call_expression
          function: (member_expression
            object: (_) @superclass.object
            property: (property_identifier) @superclass.method))
        arguments: (arguments
          [(string) (template_string)] @service.tag)))))`,
  javascript: `; Phase 2b codegraph edges (tree-sitter-v1) — JavaScript subset
; JS lacks TypeScript's \`type_identifier\` node; class names are plain \`identifier\`.
; JS also lacks \`extends_clause\` — class heritage is just \`class_heritage > expression\`.
; Same edge semantics as typescript.scm; only the grammar differences are reflected.

(yield_expression
  (expression) @yielded.arg)

(call_expression
  function: (identifier) @callee.name)

(call_expression
  function: (member_expression
    object: (_) @callee.object
    property: (property_identifier) @callee.property))

(class_declaration
  name: (identifier) @class.name
  (class_heritage
    (call_expression
      function: (call_expression
        function: (member_expression
          object: (_) @superclass.object
          property: (property_identifier) @superclass.method))
      arguments: (arguments
        [(string) (template_string)] @service.tag))))`,
  python: `; Phase 2b codegraph edges (tree-sitter-v1) — Python
; Python's tree-sitter AST: \`yield\` (not \`yield_expression\`), \`call\` (not \`call_expression\`),
; \`attribute\` for member access, \`class_definition\` with \`superclasses\` argument_list.
; Both \`yield\` and \`class_definition\`'s children are unnamed (no field names),
; so the patterns must NOT prefix them with a field name.

; --- Yield expressions ---
; \`yield\` has no fields; the yielded expression is an unnamed child
; (type \`expression\` or \`expression_list\`). Matching either gives us every
; yield regardless of \`yield x\`, \`yield x, y\`, or a bare \`yield\`.
(yield
  [(expression) (expression_list)] @yielded.value)

; --- Function calls (identifier callee) ---
(call
  function: (identifier) @callee.name)

; --- Method calls (attribute access callee) ---
(call
  function: (attribute
    object: (_) @callee.object
    attribute: (identifier) @callee.property))

; --- Class with X.Service registration ---
; \`class_definition\`'s \`superclasses\` is a child (not a field), so the
; pattern uses un-prefixed node-type.
(class_definition
  name: (identifier) @class.name
  superclasses: (argument_list
    (call
      function: (attribute
        object: (_) @superclass.object
        attribute: (identifier) @superclass.method)
      arguments: (argument_list
        [(string) (concatenated_string)] @service.tag))))`,
}
