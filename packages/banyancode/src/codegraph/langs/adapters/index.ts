import type { NodeKindMapping } from "./types"
import { RUST_MAPPING } from "./rust"
import { GO_MAPPING } from "./go"
import { JAVA_MAPPING } from "./java"
import { C_MAPPING } from "./c"
import { CPP_MAPPING } from "./cpp"
import { CSHARP_MAPPING } from "./csharp"
import { RUBY_MAPPING } from "./ruby"
import { PHP_MAPPING } from "./php"
import { BASH_MAPPING } from "./bash"
import { JSON_MAPPING } from "./json"
import { ZIG_MAPPING } from "./zig"
import { TOML_MAPPING } from "./toml"
import { YAML_MAPPING } from "./yaml"

// Canonical extension -> mapping. Family members share a mapping (c/h use the
// C grammar; the cpp family uses the cpp grammar; sh/bash; yml/yaml).
const MAPPING_BY_EXT = new Map<string, NodeKindMapping>([
  [".rs", RUST_MAPPING],
  [".go", GO_MAPPING],
  [".java", JAVA_MAPPING],
  [".c", C_MAPPING],
  [".h", C_MAPPING],
  [".cpp", CPP_MAPPING],
  [".cc", CPP_MAPPING],
  [".cxx", CPP_MAPPING],
  [".hpp", CPP_MAPPING],
  [".hh", CPP_MAPPING],
  [".hxx", CPP_MAPPING],
  [".cs", CSHARP_MAPPING],
  [".rb", RUBY_MAPPING],
  [".php", PHP_MAPPING],
  [".sh", BASH_MAPPING],
  [".bash", BASH_MAPPING],
  [".json", JSON_MAPPING],
  [".zig", ZIG_MAPPING],
  [".toml", TOML_MAPPING],
  [".yml", YAML_MAPPING],
  [".yaml", YAML_MAPPING],
])

/**
 * Every extension the tree-sitter AST walker can parse. TS/JS/Python are
 * deliberately absent — they route through the .scm-query path
 * (parseTypeScriptWithTreeSitter / parsePythonWithTreeSitter) and must stay
 * identical. Re-exported by langs/registry.ts; consumed by the indexer's
 * per-file dispatch.
 */
export const TREE_SITTER_WALK_EXTENSIONS: readonly string[] = [...MAPPING_BY_EXT.keys()]

export const getWalkerMapping = (ext: string): NodeKindMapping | undefined => MAPPING_BY_EXT.get(ext)

export type { NodeKindMapping, NodeKindMappingEntry, WalkerNodeKind } from "./types"
