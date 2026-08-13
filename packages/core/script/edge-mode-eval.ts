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
 * Run: bun run script/edge-mode-eval.ts  (from packages/core)
 */

import { Effect, Layer } from "effect"
import { cp, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir as osTmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { Database } from "../src/database/database"
import { CodegraphIndexer } from "../src/banyancode/codegraph-indexer"
import { CodegraphRepo, defaultLayer as codegraphRepoDefaultLayer } from "../src/banyancode/codegraph-repo"
import { FSUtil } from "../src/fs-util"
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

type BuildOutcome = {
  readonly mode: "derived" | "parser"
  readonly durationMs: number
  readonly indexed: number
  readonly symbolsIndexed: number
  readonly edges: CodegraphEdge[]
  readonly files: CodegraphFile[]
  readonly nodesById: Map<string, CodegraphNode>
  readonly filesById: Map<string, CodegraphFile>
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
      const [edges, nodes, files] = yield* Effect.all([
        repo.listAllEdges(),
        repo.listAllNodes(),
        repo.listAllFiles(),
      ])
      return {
        mode,
        durationMs: Date.now() - startedAt,
        indexed: result.indexed,
        symbolsIndexed: result.symbolsIndexed,
        edges,
        files,
        nodesById: new Map(nodes.map((n) => [n.id, n] as const)),
        filesById: new Map(files.map((f) => [f.id, f] as const)),
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

const edgeMatches = (edge: CodegraphEdge, expected: ManifestEdge, graph: BuildOutcome): boolean => {
  if (edge.kind !== expected.kind) return false
  const from = graph.nodesById.get(edge.fromNodeID)
  const to = graph.nodesById.get(edge.toNodeID)
  if (!from || !to) return false
  if (from.name !== expected.fromSymbol || to.name !== expected.toSymbol) return false
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
  readonly hardNegativeHits: string[]
  readonly symbolCoverage: { readonly found: number; readonly total: number; readonly missing: string[] }
  readonly callsByLanguage: Map<string, LanguageCalls>
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
  // nodes for (diagnostic for a drifted fixture).
  const manifestSymbols = new Set([...expected, ...optional].flatMap((e) => [e.fromSymbol, e.toSymbol]))
  const foundSymbols = [...manifestSymbols].filter((s) => [...graph.nodesById.values()].some((n) => n.name === s))
  const missingSymbols = [...manifestSymbols].filter((s) => !foundSymbols.includes(s))

  const hardNegativeHits = manifest.hardNegatives.filter((h) =>
    graph.files.some((f) => fileMatches(f.path, h.path)),
  ).map((h) => h.path)

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
    bumpCalls(fromFile?.language ?? "unknown", "mode", 1)
  }

  const denom = expected.length + optional.length
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
    hardNegativeHits,
    symbolCoverage: { found: foundSymbols.length, total: manifestSymbols.size, missing: missingSymbols },
    callsByLanguage,
  }
}

const pct = (v: number): string => v.toFixed(4)

const printModeReport = (manifest: Manifest, score: ModeScore): void => {
  const lines = ["", `--- mode: ${score.mode} (BANYANCODE_TS_EDGES=${score.mode === "parser" ? "parser" : "unset"}) ---`]
  lines.push(`  duration:          ${score.durationMs} ms`)
  lines.push(`  indexed files:     ${score.indexed} (symbols: ${score.symbolsIndexed})`)
  lines.push(`  edges in graph:    ${score.totalEdges} (scored: ${score.scoredEdges})`)
  lines.push(`  symbol coverage:   ${score.symbolCoverage.found}/${score.symbolCoverage.total} manifest symbols${score.symbolCoverage.missing.length > 0 ? ` (missing: ${score.symbolCoverage.missing.join(", ")})` : ""}`)
  lines.push(`  expected matched:  ${score.expectedMatched}/${manifest.expectedEdges.length}`)
  lines.push(`  optional matched:  ${score.optionalMatched}/${manifest.optionalEdges?.length ?? 0}`)
  lines.push(`  precision:         ${pct(score.precision)} (${score.expectedMatched}/${score.scoredEdges} scored edges)`)
  lines.push(`  recall:            ${pct(score.recall)} (${score.expectedMatched + score.optionalMatched}/${manifest.expectedEdges.length + (manifest.optionalEdges?.length ?? 0)} expectation rows)`)
  const hardNegatives = score.hardNegativeHits.length === 0
    ? `pass (${manifest.hardNegatives.length}/${manifest.hardNegatives.length} absent)`
    : `VIOLATION: indexed ${score.hardNegativeHits.join(", ")}`
  lines.push(`  hard negatives:    ${hardNegatives}`)
  lines.push(`  calls by language:`)
  for (const lang of manifest.languages) {
    const row = score.callsByLanguage.get(lang) ?? { expected: 0, matched: 0, mode: 0 }
    lines.push(`    ${lang.padEnd(12)} expected=${row.expected} matched=${row.matched} mode=${row.mode}`)
  }
  for (const [lang, row] of score.callsByLanguage) {
    if (manifest.languages.includes(lang)) continue
    lines.push(`    ${lang.padEnd(12)} expected=${row.expected} matched=${row.matched} mode=${row.mode}`)
  }
  console.log(lines.join("\n"))
}

const printVerdict = (derived: ModeScore, parser: ModeScore): void => {
  const recommendation =
    parser.precision >= derived.precision && parser.recall >= derived.recall ? "parser wins" : "derived wins"
  const lines = [
    "",
    "=== VERDICT ===",
    `precisionDerived:  ${pct(derived.precision)}`,
    `recallDerived:     ${pct(derived.recall)}`,
    `precisionParser:   ${pct(parser.precision)}`,
    `recallParser:      ${pct(parser.recall)}`,
    `durationDerivedMs: ${derived.durationMs}`,
    `durationParserMs:  ${parser.durationMs}`,
    `recommendation:    ${recommendation}`,
    "",
  ]
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
    printModeReport(manifest, derivedScore)
    printModeReport(manifest, parserScore)
    printVerdict(derivedScore, parserScore)
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
