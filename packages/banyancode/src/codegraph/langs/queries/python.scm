; Phase 2b codegraph edges (tree-sitter-v1) — Python
; Python's tree-sitter AST: `yield` (not `yield_expression`), `call` (not `call_expression`),
; `attribute` for member access, `class_definition` with `superclasses` argument_list.
; Both `yield` and `class_definition`'s children are unnamed (no field names),
; so the patterns must NOT prefix them with a field name.

; --- Yield expressions ---
; `yield` has no fields; the yielded expression is an unnamed child
; (type `expression` or `expression_list`). Matching either gives us every
; yield regardless of `yield x`, `yield x, y`, or a bare `yield`.
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
; `class_definition`'s `superclasses` is a child (not a field), so the
; pattern uses un-prefixed node-type.
(class_definition
  name: (identifier) @class.name
  superclasses: (argument_list
    (call
      function: (attribute
        object: (_) @superclass.object
        attribute: (identifier) @superclass.method)
      arguments: (argument_list
        [(string) (concatenated_string)] @service.tag))))