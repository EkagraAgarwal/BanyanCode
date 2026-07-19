import { Effect } from "effect"
import * as fs from "node:fs/promises"
import path from "node:path"
import type { ParseResult, ParsedEdge } from "./types"
import { parseTypeScript } from "./typescript"
import { parsePython } from "./python"
import {
  parseIncremental,
  TreeSitterUnavailableError,
  withTreeSitter,
} from "./tree-sitter"
import type { Language, Node, Parser, Query, QueryCapture, QueryMatch, Tree } from "web-tree-sitter"

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
  readonly language: Language
  readonly Query: typeof Query
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
    all.push(edge)
  }
  return all
}

const buildQueryOnTree = (
  tree: Tree,
  language: Language,
  queryCtor: typeof Query,
  querySource: string,
  fileID: string,
): ParsedEdge[] => {
  let query: Query
  try {
    query = new queryCtor(language, querySource)
  } catch {
    return []
  }
  return extractEdgesFromMatches(query.matches(tree.rootNode), fileID)
}

const runQueryAndExtract = (
  refs: BundleRefs,
  querySource: string,
  content: string,
  fileID: string,
): ParsedEdge[] => {
  const tree = refs.parser.parse(content)
  if (!tree) return []
  return buildQueryOnTree(tree, refs.language, refs.Query, querySource, fileID)
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
      const tsEdges = runQueryAndExtract({ parser, language, Query }, querySource, content, fileID)
      const regex = parseTypeScript(content, fileID)
      return { ...regex, edges: [...regex.edges, ...tsEdges] }
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
      const tsEdges = runQueryAndExtract({ parser, language, Query }, querySource, content, fileID)
      const regex = parsePython(content, fileID)
      return { ...regex, edges: [...regex.edges, ...tsEdges] }
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
      const Parser = state.parser.Parser
      const language = state.parser.languagesByExt.get(".ts") as Language | undefined
      const Query = state.parser.Query
      if (!language) return { result: parseTypeScript(content, fileID), tree: undefined }
      const parser = new Parser()
      parser.setLanguage(language)
      const tree = (oldTree
        ? parser.parse(content, oldTree)
        : parser.parse(content)) as Tree | null
      if (!tree) return { result: parseTypeScript(content, fileID), tree: undefined }
      const tsEdges = buildQueryOnTree(tree, language, Query, querySource, fileID)
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
      const Parser = state.parser.Parser
      const language = state.parser.languagesByExt.get(".py") as Language | undefined
      const Query = state.parser.Query
      if (!language) return { result: parsePython(content, fileID), tree: undefined }
      const parser = new Parser()
      parser.setLanguage(language)
      const tree = (oldTree
        ? parser.parse(content, oldTree)
        : parser.parse(content)) as Tree | null
      if (!tree) return { result: parsePython(content, fileID), tree: undefined }
      const tsEdges = buildQueryOnTree(tree, language, Query, querySource, fileID)
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