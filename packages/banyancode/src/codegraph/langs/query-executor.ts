import { Effect } from "effect"
import * as fs from "node:fs/promises"
import path from "node:path"
import type { ParseResult, ParsedEdge, ParsedNode } from "./types"
import { parseTypeScript } from "./typescript"
import { parsePython } from "./python"
import {
  TreeSitterUnavailableError,
  ensureGrammarForExt,
  withTreeSitter,
} from "./tree-sitter"
import type { Language, Node, Parser, Query, QueryCapture, QueryMatch, Tree } from "web-tree-sitter"
import { getWalkerMapping } from "./adapters"
import type { NodeKindMapping, NodeKindMappingEntry } from "./adapters"

// Query grammar sources are inlined as plain strings (see
// `queries/bundle.ts`). v1 used `import x from "./queries/x.scm" with { type:
// "text" }`; the v2 plugin bundle must not depend on a text loader, so the
// generated bundle is imported as ordinary TypeScript instead.
import { QUERY_SOURCES } from "./queries/bundle.js"

export const BUNDLED_QUERY_SOURCES = QUERY_SOURCES as Readonly<
  Record<"typescript" | "javascript" | "python", string>
>

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

// The vendored tree-sitter TypeScript grammar predates variance annotations,
// so a valid `interface KeyedMutex<in Key>` produces an ERROR node whose text
// is exactly the `in`/`out` modifier inside `type_parameters`. Reporting that
// as a syntax error flags valid source; skip only that shape and keep every
// other ERROR/MISSING report intact.
const isVarianceModifierError = (node: Node): boolean => {
  if (node.type !== "ERROR") return false
  if (node.parent?.type !== "type_parameters") return false
  const text = node.text.trim()
  if (text === "in" || text === "out") return true
  // `class C<in T>` and `function f<out T>` parse the modifier as a
  // type_parameter node and turn the following identifier into the ERROR.
  const previous = node.previousSibling
  return previous?.type === "type_parameter" && (previous.text.trim() === "in" || previous.text.trim() === "out")
}

// The grammar inserts no semicolon before a line starting with `in` or `instanceof`, so a member with that name after a
// member without a semicolon comes back as an error, in valid code.
const isKeywordMemberError = (node: Node): boolean =>
  /(?:^|\s)(?:in|instanceof)\??\s*:/.test(node.text) &&
  (node.parent?.type === "object_type" || node.parent?.type === "interface_body" || node.parent?.type === "ERROR")

const findSyntaxError = (rootNode: Node): { line: number; message: string } | null => {
  const stack: Node[] = [rootNode]
  while (stack.length > 0) {
    const node = stack.pop()!
    if (node.type === "ERROR") {
      if (!isVarianceModifierError(node) && !isKeywordMemberError(node)) {
        const snippet = node.text.trim().replace(/\s+/g, " ").slice(0, 60)
        return { line: lineNumber(node), message: `syntax error near '${snippet || "unexpected token"}'` }
      }
      continue
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

/**
 * Blanks a source range with spaces, preserving newlines and offsets. Used to
 * build a syntax-check copy where grammar gaps are neutralised; the real
 * extraction still runs on the untouched source.
 */
const blankOut = (text: string, start: number, end: number): string =>
  text.slice(0, start) + text.slice(start, end).replace(/[^\n]/g, " ") + text.slice(end)

const findMatching = (text: string, open: number, openChar: string, closeChar: string): number => {
  let depth = 0
  const limit = Math.min(open + 8000, text.length)
  for (let i = open; i < limit; i++) {
    if (text[i] === openChar) depth++
    else if (text[i] === closeChar) {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

/**
 * The vendored TypeScript grammar predates a handful of valid language
 * features (`in`/`out` variance, `export type *`, generic tagged templates,
 * generic call signatures after a plain one). They parse as ERROR or MISSING
 * nodes even though the file is valid, so the syntax-error reporter must not
 * trust the first parse. Neutralising only those constructs and re-parsing
 * keeps genuine errors visible: the error is suppressed only when the
 * repaired copy parses cleanly.
 */
const normalizeTypeScriptForSyntax = (input: string): string => {
  let text = input

  // `export type * from "..."` (TS 5.0): the grammar reads `type` as a stray
  // keyword because it only knows `export *` / `export type { ... }`.
  text = text.replace(/(\bexport\s+)type(\s+\*\s+from\b)/g, (_match: string, head: string, tail: string) =>
    head + " ".repeat(4) + tail,
  )

  // Variance annotations: `interface I<in K, out V>` / `<in out T>`. Blank
  // only the modifier words inside a generic parameter list.
  let cursor = 0
  while (cursor < text.length) {
    const open = text.indexOf("<", cursor)
    if (open === -1) break
    const before = text.slice(Math.max(0, open - 160), open)
    if (!/(?:[A-Za-z_$][\w$]*|\n\s*)$/.test(before)) {
      cursor = open + 1
      continue
    }
    const close = findMatching(text, open, "<", ">")
    if (close === -1) {
      cursor = open + 1
      continue
    }
    const interior = text.slice(open + 1, close)
    const stripped = interior.replace(
      /\b(in\s+out|out\s+in|in|out)\b(\s+)(?=[A-Za-z_$][\w$]*\s*(?:[,>=]|\bextends\b))/g,
      (modifier: string) => " ".repeat(modifier.length),
    )
    if (stripped !== interior) text = text.slice(0, open + 1) + stripped + text.slice(close)
    cursor = close + 1
  }

  // `sql<T>\`...\``: the grammar parses `sql<T>` as an instantiation
  // expression and inserts a missing `!` before the template literal. Blank
  // the type arguments when the next token is a template string.
  cursor = 0
  while (cursor < text.length) {
    const open = text.indexOf("<", cursor)
    if (open === -1) break
    const before = text.slice(Math.max(0, open - 160), open)
    if (!/[A-Za-z_$][\w$.]*\s*$/.test(before)) {
      cursor = open + 1
      continue
    }
    const close = findMatching(text, open, "<", ">")
    if (close === -1) {
      cursor = open + 1
      continue
    }
    let next = close + 1
    while (next < text.length && /\s/.test(text[next]!)) next++
    if (text[next] !== "`") {
      cursor = open + 1
      continue
    }
    text = blankOut(text, open, close + 1)
    cursor = close + 1
  }

  // Generic call signatures: `<T>(value: T): R` on its own line. The grammar
  // only recovers cleanly from one call signature per interface, so a second
  // generic overload corrupts the parse tree.
  const lines = text.split("\n")
  let offset = 0
  for (const line of lines) {
    const match = /^(\s*)</.exec(line)
    if (match) {
      const open = offset + match[1]!.length
      const close = findMatching(text, open, "<", ">")
      if (close !== -1) {
        let next = close + 1
        while (next < text.length && /\s/.test(text[next]!)) next++
        if (text[next] === "(") text = blankOut(text, open, close + 1)
      }
    }
    offset += line.length + 1
  }

  return text
}

const syntaxErrorWithRetry = (
  refs: BundleRefs,
  content: string,
  error: { line: number; message: string } | null,
  normalize: ((text: string) => string) | undefined,
): { line: number; message: string } | null => {
  if (error === null || normalize === undefined) return error
  const repaired = normalize(content)
  if (repaired === content) return error
  const tree = refs.parser.parse(repaired)
  if (!tree) return error
  try {
    return tree.rootNode && findSyntaxError(tree.rootNode) ? error : null
  } finally {
    tree.delete()
  }
}

const runQueryAndExtract = (
  refs: BundleRefs,
  content: string,
  fileID: string,
  normalize?: (text: string) => string,
): { edges: ParsedEdge[]; syntaxError: { line: number; message: string } | null } => {
  const tree = refs.parser.parse(content)
  if (!tree) return { edges: [], syntaxError: null }
  // The extracted edges/syntax error are plain data (no live Node refs), so
  // the per-parse Tree is deleted here — otherwise every parsed file leaks
  // one tree's wasm heap for the process lifetime.
  try {
    const syntaxError = tree.rootNode ? findSyntaxError(tree.rootNode) : null
    return {
      edges: buildQueryOnTree(tree, refs.query, fileID),
      // Phase 0 tree-sitter: report ERROR / MISSING nodes so the indexer can
      // record a real parse error (Wave-5 goal) while still indexing this file.
      syntaxError: syntaxErrorWithRetry(refs, content, syntaxError, normalize),
    }
  } finally {
    tree.delete()
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
    // Lazy grammar trigger: loads the TS grammar on first encountered use.
    yield* ensureGrammarForExt(".ts")
    return yield* withTreeSitter((state) => {
      const parser = state.parser.parsersByExt.get(".ts")
      const language = state.parser.languagesByExt.get(".ts") as Language | undefined
      const Query = state.parser.Query
      if (!parser || !language) return parseTypeScript(content, fileID)
      const query = getCachedQuery(".ts", language, Query, querySource)
      if (!query) return parseTypeScript(content, fileID)
      const { edges: tsEdges, syntaxError } = runQueryAndExtract(
        { parser, query },
        content,
        fileID,
        normalizeTypeScriptForSyntax,
      )
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
    // Lazy grammar trigger: loads the Python grammar on first encountered use.
    yield* ensureGrammarForExt(".py")
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
    yield* ensureGrammarForExt(".ts").pipe(Effect.ignore)
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
    yield* ensureGrammarForExt(".py").pipe(Effect.ignore)
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
    // Lazy grammar trigger for the 13 AST-walk languages.
    yield* ensureGrammarForExt(ext)
    return yield* withTreeSitter((state) => {
      const parser = state.parser.parsersByExt.get(ext)
      if (!parser) return regexFallback()
      // Per-parse Tree deleted in `finally`: only plain-data walked nodes
      // escape (see runQueryAndExtract).
      const tree = parser.parse(content)
      try {
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
      } finally {
        tree?.delete()
      }
    })
  })

export const validateQueryFile = (ext: string): Effect.Effect<boolean, TreeSitterUnavailableError, never> =>
  Effect.gen(function* () {
    const querySource = yield* loadQuerySourceOrEmpty(ext)
    if (querySource === "") return false
    // Best-effort lazy load: ignored so unsupported extensions keep the
    // historical `false` contract instead of failing.
    yield* ensureGrammarForExt(ext).pipe(Effect.ignore)
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