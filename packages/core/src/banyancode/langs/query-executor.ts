import { Effect } from "effect"
import * as fs from "node:fs/promises"
import path from "node:path"
import type { ParseResult, ParsedEdge, ParsedNode } from "./types"
import { parseTypeScript } from "./typescript"
import { parsePython } from "./python"
import {
  TreeSitterUnavailableError,
  withTreeSitter,
} from "./tree-sitter"
import type { Language, Node, Parser, Query, QueryCapture, QueryMatch, Tree } from "web-tree-sitter"
import { getWalkerMapping } from "./adapters"
import type { NodeKindMapping, NodeKindMappingEntry } from "./adapters"

// Static, literal imports so Bun's bundler can inline the `.scm` grammar
// sources at bundle time. Variable-specifier dynamic imports
// (`import(variable, { with: { type: "text" } })`) are not statically
// analyzable, so the resulting compiled binary would have no query assets
// and Tree-sitter would silently fall back to regex-only parsing.
// @ts-ignore the npm packages don't declare text-import declarations.
import typescriptScm from "./queries/typescript.scm" with { type: "text" }
// @ts-ignore same rationale as the typescript scm import.
import javascriptScm from "./queries/javascript.scm" with { type: "text" }
// @ts-ignore same rationale as the typescript scm import.
import pythonScm from "./queries/python.scm" with { type: "text" }

export const BUNDLED_QUERY_SOURCES = Object.freeze({
  typescript: typescriptScm,
  javascript: javascriptScm,
  python: pythonScm,
} as const)

// `fs` + `path` are kept for the legacy on-disk validation path that tests
// rely on (see `loadQuerySourceOrEmpty`). Compiled binaries should use
// `ensureQuerySourcesLoaded` which prefers the inlined bundle and only
// touches disk when the inlined bundle is unavailable.
const QUERIES_DIR = path.resolve(import.meta.dir, "queries")

const QUERY_FILE_BY_EXT: ReadonlyMap<string, string> = new Map([
  [".ts", "typescript.scm"],
  [".tsx", "typescript.scm"],
  [".mts", "typescript.scm"],
  [".cts", "typescript.scm"],
  [".js", "javascript.scm"],
  [".jsx", "javascript.scm"],
  [".mjs", "javascript.scm"],
  [".cjs", "javascript.scm"],
  [".py", "python.scm"],
  [".pyw", "python.scm"],
])

const readQuerySource = async (ext: string): Promise<string | null> => {
  const file = QUERY_FILE_BY_EXT.get(ext)
  if (!file) return null
  return fs.readFile(path.join(QUERIES_DIR, file), "utf8")
}

// Plan Phase 5: cache query grammar sources at module load time so the
// indexer never reads `.scm` files from disk during a parse pass.
let QUERY_SOURCE_CACHE: ReadonlyMap<string, string> | null = null

const buildBundledQueryMap = (): ReadonlyMap<string, string> => {
  const map = new Map<string, string>()
  for (const ext of [".ts", ".tsx", ".mts", ".cts"]) map.set(ext, BUNDLED_QUERY_SOURCES.typescript)
  for (const ext of [".js", ".jsx", ".mjs", ".cjs"]) map.set(ext, BUNDLED_QUERY_SOURCES.javascript)
  for (const ext of [".py", ".pyw"]) map.set(ext, BUNDLED_QUERY_SOURCES.python)
  return map
}

const bundledQuerySourcesAvailable = (): boolean => {
  const sources = BUNDLED_QUERY_SOURCES
  return (
    typeof sources.typescript === "string" &&
    sources.typescript.length > 0 &&
    typeof sources.javascript === "string" &&
    sources.javascript.length > 0 &&
    typeof sources.python === "string" &&
    sources.python.length > 0
  )
}

const loadQuerySourcesFromDisk = async (): Promise<ReadonlyMap<string, string>> => {
  const map = new Map<string, string>()
  for (const ext of QUERY_FILE_BY_EXT.keys()) {
    try {
      const source = await readQuerySource(ext)
      if (source !== null) map.set(ext, source)
    } catch {
      // Swallow individual read failures — the caller falls back to regex.
    }
  }
  return map
}

export const ensureQuerySourcesLoaded = async (): Promise<ReadonlyMap<string, string>> => {
  if (QUERY_SOURCE_CACHE) return QUERY_SOURCE_CACHE
  if (bundledQuerySourcesAvailable()) {
    QUERY_SOURCE_CACHE = buildBundledQueryMap()
    return QUERY_SOURCE_CACHE
  }
  QUERY_SOURCE_CACHE = await loadQuerySourcesFromDisk()
  return QUERY_SOURCE_CACHE
}

// Synchronous lookup against the cache. Returns "" when the grammar is not
// available; callers fall back to the regex parser in that case.
const querySourceCached = (ext: string): string => {
  const cache = QUERY_SOURCE_CACHE
  if (!cache) return ""
  return cache.get(ext) ?? ""
}

// Kept for tests + the legacy `validateQueryFile` API that needs the raw
// source for the synchronous validation path.
const loadQuerySourceOrEmpty = (ext: string): Effect.Effect<string, never, never> =>
  Effect.gen(function* () {
    const value = yield* Effect.tryPromise({
      try: () => readQuerySource(ext),
      catch: () => null as string | null,
    }).pipe(Effect.orElseSucceed(() => null as string | null))
    return value ?? ""
  })

const quoteStringLiteral = (raw: string): string => {
  if (raw.length >= 2) {
    const first = raw[0]
    const last = raw[raw.length - 1]
    if ((first === "\"" && last === "\"") || (first === "'" && last === "'") || (first === "`" && last === "`")) {
      return raw.slice(1, -1)
    }
  }
  return raw
}

const findEnclosingCallable = (start: Node): Node | null => {
  let current: Node | null = start.parent
  while (current) {
    const t = current.type
    if (
      t === "function_declaration" ||
      t === "function" ||
      t === "method_definition" ||
      t === "arrow_function" ||
      t === "generator_function_declaration" ||
      t === "function_definition"
    ) {
      return current
    }
    current = current.parent
  }
  return null
}

const lineNumber = (node: Node): number => node.startPosition.row + 1

// Phase 0 tree-sitter: web-tree-sitter exposes missing nodes as `isMissing`
// (a boolean property in the current binding; a method in older ones) whose
// `type` is the EXPECTED grammar symbol (e.g. "}"), and recovery regions as
// nodes with type "ERROR". Walk the whole tree iteratively (no recursion —
// deep ASTs must not overflow the stack) and report the first one.
const isMissingNode = (node: Node): boolean => {
  const flag = (node as unknown as { isMissing?: boolean | (() => boolean) }).isMissing
  return typeof flag === "function" ? flag() : flag === true
}

const findSyntaxError = (rootNode: Node): { line: number; message: string } | null => {
  const stack: Node[] = [rootNode]
  while (stack.length > 0) {
    const node = stack.pop()!
    if (node.type === "ERROR") {
      const snippet = node.text.trim().replace(/\s+/g, " ").slice(0, 60)
      return { line: lineNumber(node), message: `syntax error near '${snippet || "unexpected token"}'` }
    }
    if (isMissingNode(node)) {
      return { line: lineNumber(node), message: `missing '${node.type}'` }
    }
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i)
      if (child) stack.push(child)
    }
  }
  return null
}

const getCapture = (captures: readonly QueryCapture[], name: string): Node | undefined =>
  captures.find((c) => c.name === name)?.node

const extractYieldEdges = (matches: readonly QueryMatch[], fileID: string): ParsedEdge[] => {
  const edges: ParsedEdge[] = []
  for (const match of matches) {
    const captured = match.captures.find((c) => c.name === "yielded.arg" || c.name === "yielded.value")
    if (!captured) continue
    const callable = findEnclosingCallable(captured.node)
    const fromNodeID = callable
      ? `${fileID}:function:${callable.startPosition.row + 1}`
      : `${fileID}:file`
    const argText = captured.node.text
    const edge = {
      id: `${fileID}:yield:${argText}:${lineNumber(captured.node)}:${match.patternIndex}`,
      fromNodeID,
      toNodeID: `service:${argText}`,
      kind: "yield",
    } as unknown as ParsedEdge
    edges.push(edge)
  }
  return edges
}

const extractCallsEdges = (matches: readonly QueryMatch[], fileID: string): ParsedEdge[] => {
  const edges: ParsedEdge[] = []
  for (const match of matches) {
    const nameCap = getCapture(match.captures, "callee.name")
    const objCap = getCapture(match.captures, "callee.object")
    const propCap = getCapture(match.captures, "callee.property")
    const target = nameCap ?? propCap
    if (!target) continue
    const targetName = target.text
    const callerNode = nameCap ?? objCap ?? propCap
    if (!callerNode) continue
    const callable = findEnclosingCallable(callerNode)
    const fromNodeID = callable
      ? `${fileID}:function:${callable.startPosition.row + 1}`
      : `${fileID}:file`
    edges.push({
      id: `${fileID}:calls:${targetName}:${lineNumber(callerNode)}:${match.patternIndex}`,
      fromNodeID,
      toNodeID: `symbol:${targetName}`,
      kind: "calls",
    })
  }
  return edges
}

const extractServiceRegistrationEdges = (matches: readonly QueryMatch[], fileID: string): ParsedEdge[] => {
  const edges: ParsedEdge[] = []
  for (const match of matches) {
    const classCap = getCapture(match.captures, "class.name")
    const tagCap = getCapture(match.captures, "service.tag")
    if (!classCap || !tagCap) continue
    const tagText = quoteStringLiteral(tagCap.text)
    if (!tagText) continue
    const className = classCap.text
    const fromNodeID = `${fileID}:class:${className}:${lineNumber(classCap)}`
    const edge = {
      id: `${fileID}:service_access:${tagText}:${lineNumber(classCap)}`,
      fromNodeID,
      toNodeID: `service:${tagText}`,
      kind: "service_access",
    } as unknown as ParsedEdge
    edges.push(edge)
  }
  return edges
}

interface BundleRefs {
  readonly parser: Parser
  readonly query: Query
}

const extractEdgesFromMatches = (
  matches: readonly QueryMatch[],
  fileID: string,
): ParsedEdge[] => {
  const seen = new Set<string>()
  const all: ParsedEdge[] = []
  for (const edge of [
    ...extractYieldEdges(matches, fileID),
    ...extractCallsEdges(matches, fileID),
    ...extractServiceRegistrationEdges(matches, fileID),
  ]) {
    if (seen.has(edge.id)) continue
    seen.add(edge.id)
    // Phase 0 tree-sitter: mark every edge produced by the tree-sitter
    // query pass so the indexer can tell parser-owned edges from regex
    // parser output (imports) when BANYANCODE_TS_EDGES=parser is set.
    all.push({ ...edge, source: "tree-sitter" })
  }
  return all
}

const buildQueryOnTree = (
  tree: Tree,
  query: Query,
  fileID: string,
): ParsedEdge[] => {
  return extractEdgesFromMatches(query.matches(tree.rootNode), fileID)
}

const runQueryAndExtract = (
  refs: BundleRefs,
  content: string,
  fileID: string,
): { edges: ParsedEdge[]; syntaxError: { line: number; message: string } | null } => {
  const tree = refs.parser.parse(content)
  if (!tree) return { edges: [], syntaxError: null }
  return {
    edges: buildQueryOnTree(tree, refs.query, fileID),
    // Phase 0 tree-sitter: report ERROR / MISSING nodes so the indexer can
    // record a real parse error (Wave-5 goal) while still indexing this file.
    syntaxError: tree.rootNode ? findSyntaxError(tree.rootNode) : null,
  }
}

const QUERY_CACHE = new Map<string, Query>()
const getCachedQuery = (ext: string, language: Language, QueryCtor: typeof Query, querySource: string): Query | null => {
  const key = `${ext}:${querySource}`
  const cached = QUERY_CACHE.get(key)
  if (cached) return cached
  try {
    const compiled = new QueryCtor(language, querySource)
    QUERY_CACHE.set(key, compiled)
    return compiled
  } catch {
    return null
  }
}

export interface IncrementalParseResult {
  readonly result: ParseResult
  readonly tree: Tree | undefined
}

export const parseTypeScriptWithTreeSitter = (
  content: string,
  fileID: string,
): Effect.Effect<ParseResult, TreeSitterUnavailableError, never> =>
  Effect.gen(function* () {
    const querySource = querySourceCached(".ts")
    if (querySource === "") return parseTypeScript(content, fileID)
    return yield* withTreeSitter((state) => {
      const parser = state.parser.parsersByExt.get(".ts")
      const language = state.parser.languagesByExt.get(".ts") as Language | undefined
      const Query = state.parser.Query
      if (!parser || !language) return parseTypeScript(content, fileID)
      const query = getCachedQuery(".ts", language, Query, querySource)
      if (!query) return parseTypeScript(content, fileID)
      const { edges: tsEdges, syntaxError } = runQueryAndExtract({ parser, query }, content, fileID)
      const regex = parseTypeScript(content, fileID)
      return {
        ...regex,
        edges: [...regex.edges, ...tsEdges],
        // Phase 0 tree-sitter: mark the backend so the indexer can stamp
        // node derivation and (with BANYANCODE_TS_EDGES=parser) let these
        // edges survive the derived-edge lifecycle.
        backend: "tree-sitter" as const,
        ...(syntaxError ? { syntaxError } : {}),
      }
    })
  })

export const parsePythonWithTreeSitter = (
  content: string,
  fileID: string,
): Effect.Effect<ParseResult, TreeSitterUnavailableError, never> =>
  Effect.gen(function* () {
    const querySource = querySourceCached(".py")
    if (querySource === "") return parsePython(content, fileID)
    return yield* withTreeSitter((state) => {
      const parser = state.parser.parsersByExt.get(".py")
      const language = state.parser.languagesByExt.get(".py") as Language | undefined
      const Query = state.parser.Query
      if (!parser || !language) return parsePython(content, fileID)
      const query = getCachedQuery(".py", language, Query, querySource)
      if (!query) return parsePython(content, fileID)
      const { edges: tsEdges, syntaxError } = runQueryAndExtract({ parser, query }, content, fileID)
      const regex = parsePython(content, fileID)
      return {
        ...regex,
        edges: [...regex.edges, ...tsEdges],
        // Phase 0 tree-sitter: see parseTypeScriptWithTreeSitter.
        backend: "tree-sitter" as const,
        ...(syntaxError ? { syntaxError } : {}),
      }
    })
  })

export const parseTypeScriptWithTreeSitterIncremental = (
  content: string,
  fileID: string,
  oldTree: Tree | undefined,
): Effect.Effect<IncrementalParseResult, never, never> =>
  Effect.gen(function* () {
    const querySource = querySourceCached(".ts")
    if (querySource === "") return { result: parseTypeScript(content, fileID), tree: undefined }
    return yield* withTreeSitter((state) => {
      const parser = state.parser.parsersByExt.get(".ts")
      const language = state.parser.languagesByExt.get(".ts") as Language | undefined
      const Query = state.parser.Query
      if (!parser || !language) return { result: parseTypeScript(content, fileID), tree: undefined }
      const query = getCachedQuery(".ts", language, Query, querySource)
      if (!query) return { result: parseTypeScript(content, fileID), tree: undefined }
      const tree = (oldTree
        ? parser.parse(content, oldTree)
        : parser.parse(content)) as Tree | null
      if (!tree) return { result: parseTypeScript(content, fileID), tree: undefined }
      const tsEdges = buildQueryOnTree(tree, query, fileID)
      const regex = parseTypeScript(content, fileID)
      return { result: { ...regex, edges: [...regex.edges, ...tsEdges] }, tree }
    }).pipe(
      Effect.catchCause(() =>
        Effect.succeed<IncrementalParseResult>({
          result: parseTypeScript(content, fileID),
          tree: undefined,
        }),
      ),
    )
  })

export const parsePythonWithTreeSitterIncremental = (
  content: string,
  fileID: string,
  oldTree: Tree | undefined,
): Effect.Effect<IncrementalParseResult, never, never> =>
  Effect.gen(function* () {
    const querySource = querySourceCached(".py")
    if (querySource === "") return { result: parsePython(content, fileID), tree: undefined }
    return yield* withTreeSitter((state) => {
      const parser = state.parser.parsersByExt.get(".py")
      const language = state.parser.languagesByExt.get(".py") as Language | undefined
      const Query = state.parser.Query
      if (!parser || !language) return { result: parsePython(content, fileID), tree: undefined }
      const query = getCachedQuery(".py", language, Query, querySource)
      if (!query) return { result: parsePython(content, fileID), tree: undefined }
      const tree = (oldTree
        ? parser.parse(content, oldTree)
        : parser.parse(content)) as Tree | null
      if (!tree) return { result: parsePython(content, fileID), tree: undefined }
      const tsEdges = buildQueryOnTree(tree, query, fileID)
      const regex = parsePython(content, fileID)
      return { result: { ...regex, edges: [...regex.edges, ...tsEdges] }, tree }
    }).pipe(
      Effect.catchCause(() =>
        Effect.succeed<IncrementalParseResult>({
          result: parsePython(content, fileID),
          tree: undefined,
        }),
      ),
    )
  })

// ---------------------------------------------------------------------------
// Phase 5 (Batch 3): generic AST-walk node extraction for the 13 languages
// with bundled grammars but no .scm query files (rust, go, java, c, cpp,
// csharp, ruby, php, bash, json, zig, toml, yaml). The walker is driven by
// the declarative per-language mappings in langs/adapters/ — every node type
// and field name there was verified against the bundled grammar by parsing
// real samples. Nodes merge onto the regex fallback result with the same
// contract as parseTypeScriptWithTreeSitter: backend:"tree-sitter" when the
// AST pass ran, syntaxError recorded (and the file still indexes), regex
// fallback when wasm is unavailable.
// ---------------------------------------------------------------------------

// Same body cap as the regex parsers' body extraction (regex-fallback.ts
// GENERIC_BODY_BOUND): walked node.code must stay bounded for the derived
// identifier scan in rebuildDerivedGraph.
const WALKED_NODE_BODY_CAP = 4000

// Bounded ancestor walk: deep ASTs must not walk the whole file per node.
const METHOD_ANCESTOR_DEPTH = 10

const stripWalkedName = (raw: string): string => {
  let trimmed = raw.trim()
  if (trimmed.length >= 2) {
    const first = trimmed[0]
    const last = trimmed[trimmed.length - 1]
    if ((first === "\"" && last === "\"") || (first === "'" && last === "'")) {
      trimmed = trimmed.slice(1, -1)
    }
  }
  // cpp out-of-line methods resolve to a qualified_identifier whose text is
  // `Widget::draw` — same convention as the c.ts regex parser, which keeps
  // only the final component (name.split("::").pop()).
  const lastSegment = trimmed.split("::").pop()
  return lastSegment ?? trimmed
}

// c/cpp declarator chain: `AuthManager* auth_new(void)` parses as
// declarator: (pointer_declarator declarator: (function_declarator
// declarator: (identifier) ...)) — pointer-returning functions wrap the
// declarator one level deeper than plain ones. Descend childForFieldName
// through every wrapper until a plain name node (identifier /
// qualified_identifier) is reached.
const DECLARATOR_WRAPPERS = new Set([
  "pointer_declarator",
  "function_declarator",
  "init_declarator",
  "array_declarator",
  "parenthesized_declarator",
])

const resolveWalkedNameNode = (node: Node, entry: NodeKindMappingEntry): Node | null => {
  let nameNode = entry.nameField ? node.childForFieldName(entry.nameField) : node.firstNamedChild
  if (!nameNode) return null
  if (entry.nameKinds && !entry.nameKinds.includes(nameNode.type)) return null
  if (entry.nameSubField) {
    let sub = nameNode.childForFieldName(entry.nameSubField)
    while (sub && DECLARATOR_WRAPPERS.has(sub.type)) {
      nameNode = sub
      sub = nameNode.childForFieldName(entry.nameSubField)
    }
    if (sub) nameNode = sub
  }
  if (entry.nameDepth) {
    let current: Node = nameNode
    for (let i = 0; i < entry.nameDepth; i++) {
      const deeper = current.firstNamedChild
      if (!deeper) break
      current = deeper
    }
    nameNode = current
  }
  return nameNode
}

const hasAncestorType = (node: Node, types: readonly string[]): boolean => {
  let current: Node | null = node.parent
  let depth = 0
  while (current && depth < METHOD_ANCESTOR_DEPTH) {
    if (types.includes(current.type)) return true
    current = current.parent
    depth++
  }
  return false
}

const buildWalkedNode = (node: Node, entry: NodeKindMappingEntry, fileID: string): ParsedNode | null => {
  if (entry.onlyWhenParent && (!node.parent || !entry.onlyWhenParent.includes(node.parent.type))) return null
  let kind = entry.kind
  if (entry.kindByChildType) {
    kind = entry.defaultKind ?? entry.kind
    for (const child of node.namedChildren) {
      if (!child) continue
      const match = entry.kindByChildType.find((k) => k.childType === child.type)
      if (match) {
        kind = match.kind
        break
      }
    }
  }
  const nameNode = resolveWalkedNameNode(node, entry)
  if (!nameNode) return null
  if (entry.methodOnly) {
    kind = "method"
  } else if (entry.methodAncestors && hasAncestorType(node, entry.methodAncestors)) {
    kind = "method"
  } else if (entry.methodNameTypes && entry.methodNameTypes.includes(nameNode.type)) {
    kind = "method"
  }
  const name = stripWalkedName(nameNode.text)
  if (!name) return null
  const startLine = node.startPosition.row + 1
  const endLine = node.endPosition.row + 1
  const text = node.text
  const code = text.slice(0, WALKED_NODE_BODY_CAP)
  const firstLine = text.split("\n", 1)[0]?.trim() ?? ""
  const signature = firstLine.length > 200 ? firstLine.slice(0, 200) : firstLine
  const parsed: ParsedNode = { id: `${fileID}:${kind}:${name}:${startLine}`, kind, name, startLine, endLine, code }
  if (signature) parsed.signature = signature
  return parsed
}

// Iterative AST walk (no recursion — deep ASTs must not overflow the stack),
// emitting one codegraph node per mapped tree-sitter node type.
export const walkNodeTree = (rootNode: Node, mapping: NodeKindMapping, fileID: string): ParsedNode[] => {
  const out: ParsedNode[] = []
  const seen = new Set<string>()
  const stack: Node[] = [rootNode]
  while (stack.length > 0) {
    const node = stack.pop()!
    const entry = mapping.get(node.type)
    if (entry) {
      const built = buildWalkedNode(node, entry, fileID)
      if (built && !seen.has(built.id)) {
        seen.add(built.id)
        out.push(built)
      }
    }
    const namedChildren = node.namedChildren
    for (let i = namedChildren.length - 1; i >= 0; i--) {
      const child = namedChildren[i]
      if (child) stack.push(child)
    }
  }
  return out
}

/**
 * Phase 5 (Batch 3): tree-sitter AST-walk parse for languages whose grammar
 * has no .scm query bundle (rust … yaml). Walks the parsed AST with the
 * per-extension node-kind mapping, records the first syntax error, and merges
 * onto the regex fallback result — same contract as
 * parseTypeScriptWithTreeSitter: walked nodes replace the regex nodes (they
 * are the same symbols, AST-extracted), regex edges stay (their endpoints
 * use the identical `${fileID}:<kind>:<name>:<line>` id scheme), and the
 * result is stamped backend:"tree-sitter".
 */
export const parseLanguageWithTreeSitter = (
  ext: string,
  content: string,
  fileID: string,
  regexFallback: () => ParseResult,
): Effect.Effect<ParseResult, TreeSitterUnavailableError, never> =>
  Effect.gen(function* () {
    const mapping = getWalkerMapping(ext)
    if (!mapping) return regexFallback()
    return yield* withTreeSitter((state) => {
      const parser = state.parser.parsersByExt.get(ext)
      if (!parser) return regexFallback()
      const tree = parser.parse(content)
      const rootNode = tree?.rootNode
      if (!rootNode) return regexFallback()
      const walked = walkNodeTree(rootNode, mapping, fileID)
      const regex = regexFallback()
      const syntaxError = findSyntaxError(rootNode)
      return {
        ...regex,
        nodes: walked.length > 0 ? walked : regex.nodes,
        // Phase 0 tree-sitter: mark the backend so the indexer can stamp
        // node derivation (tree-sitter-v1) exactly like the TS/PY path.
        backend: "tree-sitter" as const,
        ...(syntaxError ? { syntaxError } : {}),
      }
    })
  })

export const validateQueryFile = (ext: string): Effect.Effect<boolean, TreeSitterUnavailableError, never> =>
  Effect.gen(function* () {
    const querySource = yield* loadQuerySourceOrEmpty(ext)
    if (querySource === "") return false
    return yield* withTreeSitter((state) => {
      const language = state.parser.languagesByExt.get(ext) as Language | undefined
      const Query = state.parser.Query
      if (!language) return false
      try {
        new Query(language, querySource)
        return true
      } catch {
        return false
      }
    })
  })

export const QUERY_FILES: readonly string[] = ["typescript.scm", "javascript.scm", "python.scm"]