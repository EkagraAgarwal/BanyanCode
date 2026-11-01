; Phase 2b codegraph edges (tree-sitter-v1) — JavaScript subset
; JS lacks TypeScript's `type_identifier` node; class names are plain `identifier`.
; JS also lacks `extends_clause` — class heritage is just `class_heritage > expression`.
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
        [(string) (template_string)] @service.tag))))