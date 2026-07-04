; Class implementing interface
(class_declaration
  name: (type_identifier) @class.name
  (class_heritage
    (extends_clause
      (type_identifier) @extends.name)) @heritage)

; Class with implements clause
(class_declaration
  name: (type_identifier) @class.name
  (class_heritage
    (implements_clause
      (type_identifier) @implements.name)) @heritage)

; Method definition in class
(class_declaration
  name: (type_identifier) @class.name
  (class_body
    (method_definition
      name: (property_identifier) @method.name
      body: (statement_block) @method.body))) @class.declaration

; Standalone function declaration
(function_declaration
  name: (identifier) @fn.name
  body: (statement_block) @fn.body) @fn.declaration

; Async function declaration
(function_declaration
  (async)
  name: (identifier) @fn.name
  body: (statement_block) @fn.body) @fn.async

; Arrow function (expression_body or statement_block)
(arrow_function
  (async)?
  body: (statement_block) @fn.body) @fn.arrow

; Express/Fastify route patterns
; app.get(...) or router.post(...) etc
(call_expression
  function: (member_expression
    object: (identifier) @router
    property: (property_identifier) @method)
  arguments: (arguments
    (string) @path
    .?)) @route.call

; Express route with regex
(call_expression
  function: (member_expression
    object: (identifier) @router
    property: (property_identifier) @method)
  arguments: (arguments
    (regex_pattern) @path
    .?)) @route.call.regex

; Fastify-style route: app.post('/path', handler)
(call_expression
  function: (member_expression
    object: (identifier) @app
    property: (property_identifier) @method)
  arguments: (arguments
    (string) @path
    .
    (identifier) @handler)) @fastify.route

; Call expression inside function body (for recursive detection)
; We capture function names and their call sites
(call_expression
  function: (identifier) @called_fn) @call.site
