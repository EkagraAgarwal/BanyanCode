import type { Argv } from "yargs"
import { Effect, Layer } from "effect"
import { Banyan } from "@opencode-ai/core/banyancode"
import type {
  ArchitecturalSlice as ArchitecturalSliceT,
  CodegraphNode as CodegraphNodeT,
} from "@opencode-ai/core/banyancode/types"
import { Database } from "@opencode-ai/core/database/database"
import { effectCmd, fail } from "../effect-cmd"
import { UI } from "../ui"

const dim = (value: string) => UI.Style.TEXT_DIM + value + UI.Style.TEXT_NORMAL

const printSliceSummary = (slc: ArchitecturalSliceT) => {
  UI.println(UI.Style.TEXT_HIGHLIGHT + slc.summary + UI.Style.TEXT_NORMAL)
  UI.println(
    dim(
      `entrypoints=${slc.entrypoints.length} symbols=${slc.importantSymbols.length} tests=${slc.relatedTests.length} docs=${slc.relatedDocs.length} configs=${slc.configs.length} routes=${slc.routes.length}`,
    ),
  )
}

const printNodeList = (nodes: readonly CodegraphNodeT[], limit = 10) => {
  if (nodes.length === 0) {
    UI.println(dim("  (none)"))
    return
  }
  for (const node of nodes.slice(0, limit)) {
    const sig = node.signature ?? node.kind
    UI.println(`  ${node.name}  ${dim(sig)}`)
  }
  if (nodes.length > limit) UI.println(dim(`  ...${nodes.length - limit} more`))
}

const repositoryIntelligenceLayer = Banyan.repositoryIntelligenceDefaultLayer.pipe(
  Layer.provide(Banyan.codegraphRepoDefaultLayer),
  Layer.provide(Database.defaultLayer),
)

const QueryCommand = effectCmd({
  command: "query",
  describe: "run a unified repository query (symbols, tests, docs, configs)",
  instance: false,
  builder: (yargs: Argv) =>
    yargs
      .positional("query", { type: "string", demandOption: true, describe: "function name, file path, or feature phrase" })
      .option("limit", { type: "number", describe: "max recent commits to include", default: 10 }),
  handler: Effect.fn("Cli.repository.query")(function* (args: { query?: string; limit?: number }) {
    const query = args.query
    if (!query) return yield* fail("missing query argument")
    return yield* Effect.gen(function* () {
      const intel = yield* Banyan.RepositoryIntelligence
      const ctx = yield* intel.query({ query, limit: args.limit ?? 10 })
      UI.println(UI.Style.TEXT_HIGHLIGHT + `Repository query: ${query}` + UI.Style.TEXT_NORMAL)
      UI.println(dim(`symbols=${ctx.symbols.length} tests=${ctx.tests.length} docs=${ctx.docs.length} configs=${ctx.configs.length}`))
      UI.println(dim(`graph: ${ctx.graph.nodes.length} nodes, ${ctx.graph.edges.length} edges`))
      UI.println(dim(`commits: ${ctx.git.recentCommits.length}`))
      printNodeList(ctx.symbols, 10)
    }).pipe(Effect.provide(repositoryIntelligenceLayer))
  }),
})

const ExplainCommand = effectCmd({
  command: "explain",
  describe: "explain a symbol by name",
  instance: false,
  builder: (yargs: Argv) =>
    yargs.positional("symbol", { type: "string", demandOption: true, describe: "symbol name" }),
  handler: Effect.fn("Cli.repository.explain")(function* (args: { symbol?: string }) {
    const symbol = args.symbol
    if (!symbol) return yield* fail("missing symbol argument")
    return yield* Effect.gen(function* () {
      const intel = yield* Banyan.RepositoryIntelligence
      const slc = yield* intel.explain({ symbol })
      printSliceSummary(slc)
      UI.println(UI.Style.TEXT_INFO_BOLD + "Important symbols:" + UI.Style.TEXT_NORMAL)
      printNodeList(slc.importantSymbols)
    }).pipe(Effect.provide(repositoryIntelligenceLayer))
  }),
})

const TraceCommand = effectCmd({
  command: "trace",
  describe: "trace a symbol to its downstream dependents",
  instance: false,
  builder: (yargs: Argv) =>
    yargs
      .positional("symbol", { type: "string", demandOption: true, describe: "symbol name" })
      .option("depth", { type: "number", describe: "graph walk depth", default: 2 }),
  handler: Effect.fn("Cli.repository.trace")(function* (args: { symbol?: string; depth?: number }) {
    const symbol = args.symbol
    if (!symbol) return yield* fail("missing symbol argument")
    return yield* Effect.gen(function* () {
      const intel = yield* Banyan.RepositoryIntelligence
      const slc = yield* intel.trace({ symbol, depth: args.depth ?? 2 })
      printSliceSummary(slc)
      UI.println(UI.Style.TEXT_INFO_BOLD + "Downstream entrypoints:" + UI.Style.TEXT_NORMAL)
      printNodeList(slc.entrypoints)
    }).pipe(Effect.provide(repositoryIntelligenceLayer))
  }),
})

const ImpactCommand = effectCmd({
  command: "impact",
  describe: "analyze the impact of changing a file by path",
  instance: false,
  builder: (yargs: Argv) =>
    yargs.positional("path", { type: "string", demandOption: true, describe: "repository-relative file path" }),
  handler: Effect.fn("Cli.repository.impact")(function* (args: { path?: string }) {
    const p = args.path
    if (!p) return yield* fail("missing path argument")
    return yield* Effect.gen(function* () {
      const intel = yield* Banyan.RepositoryIntelligence
      const slc = yield* intel.impact({ path: p })
      printSliceSummary(slc)
      UI.println(UI.Style.TEXT_INFO_BOLD + "Direct dependents:" + UI.Style.TEXT_NORMAL)
      printNodeList(slc.importantSymbols)
    }).pipe(Effect.provide(repositoryIntelligenceLayer))
  }),
})

const TestsCommand = effectCmd({
  command: "tests",
  describe: "find tests that reference a symbol",
  instance: false,
  builder: (yargs: Argv) =>
    yargs.positional("symbol", { type: "string", demandOption: true, describe: "symbol name" }),
  handler: Effect.fn("Cli.repository.tests")(function* (args: { symbol?: string }) {
    const symbol = args.symbol
    if (!symbol) return yield* fail("missing symbol argument")
    return yield* Effect.gen(function* () {
      const intel = yield* Banyan.RepositoryIntelligence
      const tests = yield* intel.tests({ symbol })
      UI.println(UI.Style.TEXT_HIGHLIGHT + `Tests referencing ${symbol}` + UI.Style.TEXT_NORMAL)
      printNodeList(tests)
    }).pipe(Effect.provide(repositoryIntelligenceLayer))
  }),
})

const RelationshipsCommand = effectCmd({
  command: "relationships",
  describe: "walk the graph from a nodeID",
  instance: false,
  builder: (yargs: Argv) =>
    yargs
      .positional("nodeID", { type: "string", demandOption: true, describe: "codegraph node id" })
      .option("depth", { type: "number", describe: "graph walk depth", default: 2 }),
  handler: Effect.fn("Cli.repository.relationships")(function* (args: { nodeID?: string; depth?: number }) {
    const nodeID = args.nodeID
    if (!nodeID) return yield* fail("missing nodeID argument")
    return yield* Effect.gen(function* () {
      const intel = yield* Banyan.RepositoryIntelligence
      const nodes = yield* intel.relationships({ nodeID, depth: args.depth ?? 2 })
      UI.println(UI.Style.TEXT_HIGHLIGHT + `Related nodes` + UI.Style.TEXT_NORMAL)
      printNodeList(nodes)
    }).pipe(Effect.provide(repositoryIntelligenceLayer))
  }),
})

const OwnershipCommand = effectCmd({
  command: "ownership",
  describe: "find the most active author for a file by path",
  instance: false,
  builder: (yargs: Argv) =>
    yargs.positional("path", { type: "string", demandOption: true, describe: "repository-relative file path" }),
  handler: Effect.fn("Cli.repository.ownership")(function* (args: { path?: string }) {
    const p = args.path
    if (!p) return yield* fail("missing path argument")
    return yield* Effect.gen(function* () {
      const intel = yield* Banyan.RepositoryIntelligence
      const owner = yield* intel.findOwner({ path: p })
      if (owner.owner) UI.println(`${UI.Style.TEXT_HIGHLIGHT}${owner.owner}${UI.Style.TEXT_NORMAL} ${dim(`(${owner.count} commits)`)}`)
      else UI.println(dim(`no owner (${owner.count} commits)`))
    }).pipe(Effect.provide(repositoryIntelligenceLayer))
  }),
})

export const RepositoryCommand = effectCmd({
  command: "repository",
  describe: "banyancode repository intelligence subcommands",
  instance: false,
  builder: (yargs: Argv) =>
    yargs
      .command(QueryCommand)
      .command(ExplainCommand)
      .command(TraceCommand)
      .command(ImpactCommand)
      .command(TestsCommand)
      .command(RelationshipsCommand)
      .command(OwnershipCommand)
      .demandCommand(),
  handler: Effect.fn("Cli.repository")(function* () {}),
})
