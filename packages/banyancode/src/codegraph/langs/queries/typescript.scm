; Phase 2b codegraph edges (tree-sitter-v1)
; These run in O(N) over the AST after tree-sitter parses the file.
; Each pattern emits captures that query-executor.ts converts to ParsedEdge.

; --- yield* / yield expressions: fromNodeID = enclosing function, toNodeID = service:<text> ---
; tree-sitter-typescript: yield_expression has no fields; the argument is an
; unnamed child (type `expression`). Matching with the `expression` type
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
; which tree-sitter parses as an outer call_expression whose `function`
; is an inner call_expression (the empty-args `X.Service<...>()`).
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
          [(string) (template_string)] @service.tag)))))