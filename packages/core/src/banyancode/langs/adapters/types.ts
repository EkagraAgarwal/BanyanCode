/**
 * Declarative node-kind mappings for the tree-sitter AST walkers.
 *
 * One adapter file per language family (rust.ts, go.ts, …) exports a
 * NodeKindMapping: tree-sitter node type -> how it becomes a codegraph node.
 * Field names in the entries are VERIFIED against the bundled grammars
 * (see the per-language files for the S-expr evidence) — never guessed.
 *
 * The generic walker in query-executor.ts (walkNodeTree +
 * parseLanguageWithTreeSitter) consumes these mappings; it merges the walked
 * nodes onto the regex fallback result and stamps backend:"tree-sitter",
 * exactly like the TS/PY .scm-query path.
 */

/**
 * Node kinds the tree-sitter AST walkers may produce. A strict subset of
 * ParsedNode["kind"] — walkers never emit test/route/config/etc.
 */
export type WalkerNodeKind = "function" | "class" | "method" | "type" | "variable"

/** One mapping entry: how a tree-sitter node type becomes a codegraph node. */
export interface NodeKindMappingEntry {
  readonly kind: WalkerNodeKind
  /** Field on the node that holds the name-bearing child (e.g. java "name"). */
  readonly nameField?: string
  /**
   * Field on the NAME node for c/cpp declarator nesting:
   * function_definition -> declarator (function_declarator) -> declarator
   * (identifier | qualified_identifier).
   */
  readonly nameSubField?: string
  /** Always classify as a method regardless of position (go/java/csharp/php method_declaration). */
  readonly methodOnly?: boolean
  /** Classify as a method when an ancestor (bounded walk) has one of these types. */
  readonly methodAncestors?: readonly string[]
  /** Classify as a method when the resolved name node's type is in this set (cpp out-of-line `Widget::draw`). */
  readonly methodNameTypes?: readonly string[]
  /** Pick the kind by the type of a named child (go type_spec: struct_type -> class, interface_type -> type). */
  readonly kindByChildType?: ReadonlyArray<{ readonly childType: string; readonly kind: WalkerNodeKind }>
  /** Kind used when kindByChildType is present but no child matched (zig variable_declaration -> variable). */
  readonly defaultKind?: WalkerNodeKind
  /** Emit only when node.parent.type is in this set (c top-level declarations). */
  readonly onlyWhenParent?: readonly string[]
  /**
   * Emit only when the name-field node's type (BEFORE nameSubField descent)
   * is in this set (c declaration: identifier/init_declarator, which
   * excludes function_declarator so prototypes never become variables).
   */
  readonly nameKinds?: readonly string[]
  /** Descend firstNamedChild this many times to reach the name text (yaml flow_node -> plain_scalar -> string_scalar). */
  readonly nameDepth?: number
}

export type NodeKindMapping = ReadonlyMap<string, NodeKindMappingEntry>
