/**
 * Phase-2 edge-mode evaluation harness (BANYANCODE_TS_EDGES=derived|parser).
 *
 * Builds a REAL codegraph over the multi-language fixture at
 * test/fixture/edge-eval/ (manifest.json = ground truth) twice into two
 * SEPARATE tmpdir SQLite DBs — once with the derived edge lifecycle, once
 * with parser-owned tree-sitter edges — then scores each mode against the
 * manifest's expectedEdges / optionalEdges and prints a verdict.
 *
 * The edge mode is switched via process.env.BANYANCODE_TS_EDGES, which the
 * indexer reads at build start (codegraph-indexer.ts `index`), so this
 * survives signature churn: no indexer params are touched.
 *
 * BACKEND PROBE (contamination guard): parser mode only differs from derived
 * mode when the tree-sitter backend ACTUALLY engaged AND parser-owned edges
 * were stored. The harness probes both directly:
 *   - treeSitterStateRef (module-level, shared with the indexer's own
 *     ensureWebTreeSitterReady) -> wasm loaded: ready | unavailable+cause
 *   - result.parseErrors causes -> per-file evidence ("tree-sitter
 *     unavailable: ..." = regex fallback; "tree-sitter syntax error ..." =
 *     engaged, syntax error)
 *   - parser-style edge ids in the stored graph -> parser-owned edges that
 *     actually survived the endpoint remap + delete/regenerate lifecycle
 * A parser-mode run with wasm NOT engaged OR zero parser-owned edges is
 * labeled UNRELIABLE and excluded from the verdict (allow-equal rule).
 *
 * Run: bun run script/edge-mode-eval.ts  (from packages/core)
 */

import { Effect, Layer, Ref } from "effect"
import { cp, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir as osTmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { Database } from "../src/database/database"
import { CodegraphIndexer } from "../src/banyancode/codegraph-indexer"
import { CodegraphRepo, defaultLayer as codegraphRepoDefaultLayer } from "../src/banyancode/codegraph-repo"
import { FSUtil } from "../src/fs-util"
import { treeSitterStateRef } from "../src/banyancode/langs/tree-sitter"
import type { CodegraphEdge, CodegraphFile, CodegraphNode } from "../src/banyancode/types"

const FIXTURE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../test/fixture/edge-eval")
const MANIFEST_PATH = path.join(FIXTURE_DIR, "manifest.json")

// Kinds the manifest may score on. Cross-edges (tested_by / configured_by /
// built_by / mounts / generated_from) never appear in the manifest, and the
// scoredKinds intersection below keeps them out of the precision denominator.
const REFERENCE_KINDS = new Set(["calls", "imports", "extends", "references"])

type ManifestEdge = {
  readonly from: string
  readonly fromSymbol: string
  readonly to: string
  readonly toSymbol: string
  readonly kind: string
  readonly note?: string
}

type Manifest = {
  readonly repo: string
  readonly languages: string[]
  readonly files: Array<{ path: string; language: string; symbols: string[] }>
  readonly expectedEdges: ManifestEdge[]
  readonly optionalEdges?: ManifestEdge[]
  readonly hardNegatives: Array<{ path: string; reason: string }>
}

// Success covers CodegraphIndexer.Service AND CodegraphRepo.Service (Layer.provide
// merges the dependency's success), so the gen's requirements are fully
// exhausted by the first provide; the outer Database.layerFromPath provides the
// concrete tmpdir DB (dependency wins on duplicates — same as the tree-sitter
// test's harness).
const serviceLayer = CodegraphIndexer.layer.pipe(
  Layer.provide(FSUtil.defaultLayer),
  Layer.provide(codegraphRepoDefaultLayer),
)

type ParseError = { readonly path: string; readonly cause: string }

// Parser-owned edge ids look like `<fileID>:calls:<name>:<line>:<pattern>`;
// derived ids look like `<fromNodeID>-><toNodeID>:calls`. The suffix check
// distinguishes them (parser ids end in `:\d+:\d+`).
const isParserStyleEdgeId = (id: string): boolean => /:calls:[^->]+:\d+:\d+$/.test(id)

type BuildOutcome = {
  readonly mode: "derived" | "parser"
  readonly durationMs: number
  readonly indexed: number
  readonly symbolsIndexed: number
  readonly edges: CodegraphEdge[]
  readonly files: CodegraphFile[]
  readonly nodes: CodegraphNode[]
  readonly nodesById: Map<string, CodegraphNode>
  readonly filesById: Map<string, CodegraphFile>
  // Probe data (contamination guard).
  readonly wasmState: string
  readonly parseErrors: ParseError[]
  readonly parserOwnedEdges: number
}

const runBuild = (mode: "derived" | "parser", root: string, dbPath: string): Promise<BuildOutcome> => {
  // Env is read by the indexer at build start; set BEFORE the runtime builds.
  if (mode === "parser") process.env.BANYANCODE_TS_EDGES = "parser"
  else delete process.env.BANYANCODE_TS_EDGES
  return Effect.runPromise(
    Effect.gen(function* () {
      const startedAt = Date.now()
      const indexer = yield* CodegraphIndexer.Service
      const result = yield* indexer.index({ root, force: true })
      const repo = yield* CodegraphRepo.Service
      const [edges, nodes, files, state] = yield* Effect.all([
        repo.listAllEdges(),
        repo.listAllNodes(),
        repo.listAllFiles(),
        Ref.get(treeSitterStateRef),
      ])
      const parseErrors = (result as { parseErrors?: ParseError[] }).parseErrors ?? []
      return {
        mode,
        durationMs: Date.now() - startedAt,
        indexed: result.indexed,
        symbolsIndexed: result.symbolsIndexed,
        edges,
        files,
        nodes,
        nodesById: new Map(nodes.map((n) => [n.id, n] as const)),
        filesById: new Map(files.map((f) => [f.id, f] as const)),
        wasmState:
          state._tag === "ready"
            ? `ready (${state.parser.parsersByExt.size} extensions)`
            : state._tag === "unavailable"
              ? `unavailable: ${state.cause}`
              : "uninitialized",
        parseErrors,
        parserOwnedEdges: edges.filter((e) => isParserStyleEdgeId(e.id)).length,
      }
    }).pipe(
      Effect.provide(serviceLayer),
      // Type-only: Layer.provide's result success carries only the layer's own
      // services, so the gen's CodegraphRepo.Service requirement would survive
      // the chain below. Re-providing repoDefaultLayer (Success = CodegraphRepo)
      // exhausts it; at runtime its instance is memoized/shared and built
      // against the tmpdir Database from the outermost provide (same wiring as
      // the codegraph-tree-sitter test's harness).
      Effect.provide(codegraphRepoDefaultLayer),
      Effect.provide(Database.layerFromPath(dbPath)),
    ),
  ).finally(() => {
    delete process.env.BANYANCODE_TS_EDGES
  })
}

const norm = (p: string): string => p.replace(/\\/g, "/")

// Manifest paths are repo-relative; the indexer stores absolute paths.
const fileMatches = (storedPath: string, expectedRel: string): boolean => {
  const stored = norm(storedPath)
  const rel = norm(expectedRel).replace(/^\.\//, "")
  return stored === rel || stored.endsWith(`/${rel}`)
}

// The indexer labels .c/.h/.cpp/.hpp/.cc/.cxx files "c_cpp" (codegraph-indexer.ts
// language detection), while the manifest splits them into "c"/"cpp". Map the
// indexer side onto the manifest labels by extension so the per-language calls
// table has no unlabeled c_cpp rows.
const languageForFile = (file: CodegraphFile): string => {
  const ext = path.extname(file.path).toLowerCase()
  if (ext === ".c" || ext === ".h") return "c"
  if (ext === ".cpp" || ext === ".cc" || ext === ".cxx" || ext === ".hpp" || ext === ".hh" || ext === ".hxx") return "cpp"
  return file.language
}

const edgeMatches = (edge: CodegraphEdge, expected: ManifestEdge, graph: BuildOutcome): boolean => {
  if (edge.kind !== expected.kind) return false
  const from = graph.nodesById.get(edge.fromNodeID)
  const to = graph.nodesById.get(edge.toNodeID)
  if (!from || !to) return false
  // Imports edges carry no symbols in the manifest; only compare names when
  // the expectation actually pins one.
  if (expected.fromSymbol !== undefined && from.name !== expected.fromSymbol) return false
  if (expected.toSymbol !== undefined && to.name !== expected.toSymbol) return false
  const fromFile = graph.filesById.get(from.fileID)
  const toFile = graph.filesById.get(to.fileID)
  if (!fromFile || !toFile) return false
  return fileMatches(fromFile.path, expected.from) && fileMatches(toFile.path, expected.to)
}

// Greedy 1:1 matching: each graph edge satisfies at most one manifest row, so
// duplicate expectations can't inflate the match count.
const matchEdges = (
  expectations: readonly ManifestEdge[],
  graph: BuildOutcome,
  usedIds: Set<string>,
): { readonly matched: number; readonly matchedIdx: Set<number>; readonly usedIds: Set<string> } => {
  const matchedIdx = new Set<number>()
  expectations.forEach((expected, i) => {
    const hit = graph.edges.find((e) => !usedIds.has(e.id) && edgeMatches(e, expected, graph))
    if (hit) {
      usedIds.add(hit.id)
      matchedIdx.add(i)
    }
  })
  return { matched: matchedIdx.size, matchedIdx, usedIds }
}

type LanguageCalls = { expected: number; matched: number; mode: number }

type ModeScore = {
  readonly mode: "derived" | "parser"
  readonly durationMs: number
  readonly indexed: number
  readonly symbolsIndexed: number
  readonly totalEdges: number
  readonly scoredEdges: number
  readonly expectedMatched: number
  readonly optionalMatched: number
  readonly precision: number
  readonly recall: number
  readonly hardNegativeViolations: string[]
  readonly symbolCoverage: { readonly found: number; readonly total: number; readonly missing: string[] }
  readonly callsByLanguage: Map<string, LanguageCalls>
  readonly wasmState: string
  readonly parseErrorSummary: string
  readonly parserOwnedEdges: number
}

const scoreMode = (manifest: Manifest, graph: BuildOutcome): ModeScore => {
  const expected = manifest.expectedEdges
  const optional = manifest.optionalEdges ?? []
  const scoredKinds = new Set(
    [...expected, ...optional].map((e) => e.kind).filter((k) => REFERENCE_KINDS.has(k)),
  )
  const scoredEdges = graph.edges.filter((e) => scoredKinds.has(e.kind)).length

  const expectedRes = matchEdges(expected, graph, new Set())
  const optionalRes = matchEdges(optional, graph, expectedRes.usedIds)

  // Symbol coverage: how many manifest symbols the indexer actually produced
  // nodes for (diagnostic for a drifted fixture). Imports edges carry no
  // symbols — exclude them (their undefined fromSymbol/toSymbol previously
  // polluted the missing list as an empty string).
  const manifestSymbols = new Set(
    [...expected, ...optional].flatMap((e) =>
      e.kind === "imports" ? [] : [e.fromSymbol, e.toSymbol].filter((s): s is string => typeof s === "string" && s.length > 0),
    ),
  )
  const foundSymbols = [...manifestSymbols].filter((s) => [...graph.nodesById.values()].some((n) => n.name === s))
  const missingSymbols = [...manifestSymbols].filter((s) => !foundSymbols.includes(s))

  // Hard negatives: the file MUST be indexed (doc nodes are the expected
  // state) but must have NO symbol nodes and NO edges touching it. A file
  // that is not indexed at all is also a violation of the contract ("no
  // symbol edges for the docs file" cannot be verified if the file vanished).
  const hardNegativeViolations = manifest.hardNegatives.filter((h) => {
    const files = graph.files.filter((f) => fileMatches(f.path, h.path))
    if (files.length === 0) return true
    const fileIDs = new Set(files.map((f) => f.id))
    const fileNodes = graph.nodes.filter((n) => fileIDs.has(n.fileID))
    const hasSymbolNodes = fileNodes.some((n) => n.kind !== "file" && n.kind !== "doc")
    const nodeIDs = new Set(fileNodes.map((n) => n.id))
    const hasEdges = graph.edges.some((e) => nodeIDs.has(e.fromNodeID) || nodeIDs.has(e.toNodeID))
    return hasSymbolNodes || hasEdges
  }).map((h) => h.path)

  const langForManifestPath = new Map(manifest.files.map((f) => [norm(f.path), f.language] as const))
  const callsByLanguage = new Map<string, LanguageCalls>()
  const allExpectations = [...expected, ...optional]
  const optionalOffset = expected.length
  const bumpCalls = (lang: string, key: "expected" | "matched" | "mode", amount: number): void => {
    const row = callsByLanguage.get(lang) ?? { expected: 0, matched: 0, mode: 0 }
    row[key] += amount
    callsByLanguage.set(lang, row)
  }
  allExpectations.forEach((e, i) => {
    if (e.kind !== "calls") return
    const lang = langForManifestPath.get(norm(e.from)) ?? "unknown"
    const matched = i < optionalOffset
      ? expectedRes.matchedIdx.has(i)
      : optionalRes.matchedIdx.has(i - optionalOffset)
    bumpCalls(lang, "expected", 1)
    if (matched) bumpCalls(lang, "matched", 1)
  })
  for (const edge of graph.edges) {
    if (edge.kind !== "calls") continue
    const fromNode = graph.nodesById.get(edge.fromNodeID)
    const fromFile = fromNode ? graph.filesById.get(fromNode.fileID) : undefined
    bumpCalls(fromFile ? languageForFile(fromFile) : "unknown", "mode", 1)
  }

  const denom = expected.length + optional.length
  const unavailableCount = graph.parseErrors.filter((p) => p.cause.startsWith("tree-sitter unavailable")).length
  const syntaxErrorCount = graph.parseErrors.filter((p) => p.cause.startsWith("tree-sitter syntax error")).length
  const parseErrorSummary =
    graph.parseErrors.length === 0
      ? "none (all parses clean)"
      : `unavailable=${unavailableCount} syntaxError=${syntaxErrorCount} total=${graph.parseErrors.length}`
  return {
    mode: graph.mode,
    durationMs: graph.durationMs,
    indexed: graph.indexed,
    symbolsIndexed: graph.symbolsIndexed,
    totalEdges: graph.edges.length,
    scoredEdges,
    expectedMatched: expectedRes.matched,
    optionalMatched: optionalRes.matched,
    precision: scoredEdges === 0 ? 0 : expectedRes.matched / scoredEdges,
    recall: denom === 0 ? 0 : (expectedRes.matched + optionalRes.matched) / denom,
    hardNegativeViolations,
    symbolCoverage: { found: foundSymbols.length, total: manifestSymbols.size, missing: missingSymbols },
    callsByLanguage,
    wasmState: graph.wasmState,
    parseErrorSummary,
    parserOwnedEdges: graph.parserOwnedEdges,
  }
}

const pct = (v: number): string => v.toFixed(4)

// A parser-mode run is only reliable when the tree-sitter backend engaged
// (wasm ready) AND at least one parser-owned edge survived the endpoint
// remap + delete/regenerate lifecycle. Otherwise the two modes ran the same
// regex/derived pipeline and the "differential" is unmeasured.
const reliability = (score: ModeScore): { readonly reliable: boolean; readonly reason: string } => {
  if (score.mode === "derived") return { reliable: true, reason: "" }
  if (!score.wasmState.startsWith("ready")) {
    return { reliable: false, reason: `wasm NOT engaged (${score.wasmState}); parser mode ran on the regex fallback` }
  }
  if (score.parserOwnedEdges === 0) {
    return {
      reliable: false,
      reason: "wasm engaged but ZERO parser-owned edges were stored (endpoint remap dropped every query edge)",
    }
  }
  return { reliable: true, reason: "" }
}

const printModeReport = (manifest: Manifest, score: ModeScore): void => {
  const rel = reliability(score)
  const lines = [
    "",
    `--- mode: ${score.mode} (BANYANCODE_TS_EDGES=${score.mode === "parser" ? "parser" : "unset"})${rel.reliable ? "" : "  [UNRELIABLE]"}`,
    `  duration:          ${score.durationMs} ms`,
    `  indexed files:     ${score.indexed} (symbols: ${score.symbolsIndexed})`,
    `  edges in graph:    ${score.totalEdges} (scored: ${score.scoredEdges}, parser-owned: ${score.parserOwnedEdges})`,
    `  wasm backend:      ${score.wasmState}`,
    `  parse errors:      ${score.parseErrorSummary}`,
    `  symbol coverage:   ${score.symbolCoverage.found}/${score.symbolCoverage.total} manifest symbols${score.symbolCoverage.missing.length > 0 ? ` (missing: ${score.symbolCoverage.missing.join(", ")})` : ""}`,
    `  expected matched:  ${score.expectedMatched}/${manifest.expectedEdges.length}`,
    `  optional matched:  ${score.optionalMatched}/${manifest.optionalEdges?.length ?? 0}`,
    `  precision:         ${pct(score.precision)} (${score.expectedMatched}/${score.scoredEdges} scored edges)`,
    `  recall:            ${pct(score.recall)} (${score.expectedMatched + score.optionalMatched}/${manifest.expectedEdges.length + (manifest.optionalEdges?.length ?? 0)} expectation rows)`,
    `  hard negatives:    ${score.hardNegativeViolations.length === 0
      ? `pass (${manifest.hardNegatives.length}/${manifest.hardNegatives.length} indexed as doc-only, no symbol nodes, no edges)`
      : `VIOLATION: ${score.hardNegativeViolations.join(", ")} (must be indexed doc-only with no symbol nodes and no edges)`}`,
    `  calls by language (c/cpp merged onto manifest labels):`,
  ]
  for (const lang of manifest.languages) {
    const row = score.callsByLanguage.get(lang) ?? { expected: 0, matched: 0, mode: 0 }
    lines.push(`    ${lang.padEnd(12)} expected=${row.expected} matched=${row.matched} mode=${row.mode}`)
  }
  for (const [lang, row] of score.callsByLanguage) {
    if (manifest.languages.includes(lang)) continue
    lines.push(`    ${lang.padEnd(12)} expected=${row.expected} matched=${row.matched} mode=${row.mode}`)
  }
  if (!rel.reliable) lines.push(`  reliability:       UNRELIABLE — ${rel.reason}`)
  console.log(lines.join("\n"))
}

const printVerdict = (derived: ModeScore, parser: ModeScore, differential: { derivedOnly: number; parserOnly: number }): void => {
  const parserRel = reliability(parser)
  const lines = [
    "",
    "=== VERDICT ===",
    `precisionDerived:  ${pct(derived.precision)}`,
    `recallDerived:     ${pct(derived.recall)}`,
    `precisionParser:   ${pct(parser.precision)}${parserRel.reliable ? "" : "  (unreliable)"}`,
    `recallParser:      ${pct(parser.recall)}${parserRel.reliable ? "" : "  (unreliable)"}`,
    `durationDerivedMs: ${derived.durationMs}`,
    `durationParserMs:  ${parser.durationMs}`,
    `wasmDerived:       ${derived.wasmState}`,
    `wasmParser:        ${parser.wasmState}`,
    `parserOwnedEdges:  ${parser.parserOwnedEdges}`,
    `differential:      edges only in derived=${differential.derivedOnly}, only in parser=${differential.parserOnly}`,
  ]
  if (!parserRel.reliable) {
    lines.push(`recommendation:    NO VERDICT — parser run UNRELIABLE: ${parserRel.reason}`)
  } else {
    const recommendation =
      parser.precision >= derived.precision && parser.recall >= derived.recall ? "parser wins" : "derived wins"
    lines.push(`recommendation:    ${recommendation}`)
  }
  console.log(lines.join("\n"))
}

const main = async (): Promise<void> => {
  let raw: string
  try {
    raw = await readFile(MANIFEST_PATH, "utf8")
  } catch {
    console.error(`[edge-mode-eval] manifest not found at ${MANIFEST_PATH}`)
    console.error("[edge-mode-eval] the edge-eval fixture has not landed yet — nothing to evaluate. Exiting 1.")
    process.exitCode = 1
    return
  }
  const manifest = JSON.parse(raw) as Manifest
  if (
    typeof manifest.repo !== "string" ||
    !Array.isArray(manifest.files) ||
    !Array.isArray(manifest.expectedEdges) ||
    !Array.isArray(manifest.hardNegatives)
  ) {
    throw new Error(`[edge-mode-eval] manifest at ${MANIFEST_PATH} does not match the documented shape`)
  }

  console.log("=== edge-mode-eval ===")
  console.log(`repo:            ${manifest.repo}`)
  console.log(`fixture:         ${FIXTURE_DIR}`)
  console.log(
    `manifest:        ${manifest.files.length} files, ${manifest.expectedEdges.length} expectedEdges, ${manifest.optionalEdges?.length ?? 0} optionalEdges, ${manifest.hardNegatives.length} hardNegatives`,
  )
  console.log(`languages:       ${manifest.languages.join(", ")}`)

  const tmpRoot = await mkdtemp(path.join(osTmpdir(), "banyancode-edge-eval-"))
  try {
    const repoRoot = path.join(tmpRoot, "repo")
    await cp(FIXTURE_DIR, repoRoot, {
      recursive: true,
      // manifest.json + manifest.test.ts are the harness's ground truth, not
      // part of the fixture repo; .git (if added) is indexer-excluded anyway.
      filter: (src) =>
        path.basename(src) !== "manifest.json" &&
        path.basename(src) !== "manifest.test.ts" &&
        path.basename(src) !== ".git",
    })
    const derived = await runBuild("derived", repoRoot, path.join(tmpRoot, "derived.sqlite"))
    const parser = await runBuild("parser", repoRoot, path.join(tmpRoot, "parser.sqlite"))
    const derivedScore = scoreMode(manifest, derived)
    const parserScore = scoreMode(manifest, parser)
    // Differential: edge shapes present in exactly one mode's graph. Node ids
    // are fresh UUIDs per DB, so compare normalized (file-relative path +
    // node name + kind) — ids would make every edge look "only in one mode".
    const shapeKey = (edge: CodegraphEdge, graph: BuildOutcome): string => {
      const from = graph.nodesById.get(edge.fromNodeID)
      const to = graph.nodesById.get(edge.toNodeID)
      const fromFile = from ? graph.filesById.get(from.fileID) : undefined
      const toFile = to ? graph.filesById.get(to.fileID) : undefined
      return `${norm(fromFile?.path ?? "?")}:${from?.name ?? "?"}->${norm(toFile?.path ?? "?")}:${to?.name ?? "?"}:${edge.kind}`
    }
    const derivedShapes = new Set(derived.edges.map((e) => shapeKey(e, derived)))
    const parserShapes = new Set(parser.edges.map((e) => shapeKey(e, parser)))
    const differential = {
      derivedOnly: [...derivedShapes].filter((s) => !parserShapes.has(s)).length,
      parserOnly: [...parserShapes].filter((s) => !derivedShapes.has(s)).length,
    }
    printModeReport(manifest, derivedScore)
    printModeReport(manifest, parserScore)
    printVerdict(derivedScore, parserScore, differential)
  } finally {
    await removeDir(tmpRoot)
  }
}

// SQLite keeps the tmp DBs open until GC; on Windows an open handle makes rm
// fail with EBUSY. Same retry pattern as test/fixture/tmpdir.ts (force GC,
// back off, retry), but fail loudly instead of leaking the tmpdir.
async function removeDir(dir: string, retries = 30): Promise<void> {
  try {
    await rm(dir, { recursive: true, force: true })
  } catch (error) {
    if (retries === 0 || !error || typeof error !== "object" || !("code" in error) || error.code !== "EBUSY") {
      throw error
    }
    Bun.gc(true)
    await Bun.sleep(100)
    return removeDir(dir, retries - 1)
  }
}

main().catch((cause) => {
  console.error("[edge-mode-eval] failed:", cause)
  process.exitCode = 1
})
