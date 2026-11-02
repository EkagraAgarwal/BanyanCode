import { Rpc } from "@opencode/schema/rpc"
import type { RpcCallContext, RpcHandlers } from "@opencode/plugin/effect/rpc"
import { Effect, Schema } from "effect"
import { computeBlastRadius } from "./blast-radius.js"
import { computeCodeFind } from "./code-find.js"
import type { CodegraphPort } from "./codegraph-port.js"
import type { EditPlannerInterface } from "./edit-planner.js"
import { computePreflight } from "./preflight.js"
import { computeSafeRename, RenamePlanError } from "./safe-rename.js"
import type { Interface as Intelligence } from "./service.js"
import {
  ArchitecturalSliceQuery,
  ArchitecturalSliceSchema,
  BlastRadiusInput,
  BlastRadiusOutput,
  CodeFindInput,
  CodeFindOutput,
  ExplainInput,
  GraphNodeSchema,
  ImpactInput,
  OwnershipInput,
  OwnershipOutputSchema,
  PreflightInput,
  PreflightOutput,
  QueryInput,
  RelationshipsInput,
  RepositoryContextSchema,
  SafeRenameInput,
  SafeRenameOutput,
  SymbolsInput,
  TestsInput,
  TraceInput,
} from "./types.js"

/**
 * `banyancode.intel.*` RPC namespace. Mirrors the v1 HTTP surface one-for-one
 * (parity section 5):
 *
 *   POST /global/code-find              → intel.codeFind
 *   POST /global/preflight              → intel.preflight
 *   POST /global/blast-radius           → intel.blastRadius
 *   POST /global/safe-rename            → intel.safeRename
 *   POST /global/repository/query       → intel.query
 *   POST /global/repository/explain     → intel.explain
 *   POST /global/repository/impact      → intel.impact
 *   POST /global/repository/trace       → intel.trace
 *   POST /global/repository/tests       → intel.tests
 *   POST /global/repository/symbols     → intel.symbols
 *   POST /global/repository/relationships → intel.relationships
 *   POST /global/repository/ownership   → intel.ownership
 *   GET  /global/repository/architectural-slice → intel.slice
 *
 * The v1 handlers returned `{ slice, context }` for query and bare node arrays
 * for tests/symbols/relationships; those wire shapes are preserved.
 */

const QueryOutput = Schema.Struct({
  slice: ArchitecturalSliceSchema,
  context: RepositoryContextSchema,
})

// The RPC surface defaults `includeKeywordFallback` like the `code_find` tool
// does: a plain `{intent, target}` lookup must not fail input validation.
const CodeFindRpcInput = Schema.Struct({
  ...CodeFindInput.fields,
  includeKeywordFallback: Schema.optional(Schema.Boolean),
})

export const Definition = Rpc.define({
  id: "banyancode.intel",
  methods: {
    query: { input: QueryInput, output: QueryOutput },
    explain: { input: ExplainInput, output: ArchitecturalSliceSchema },
    impact: { input: ImpactInput, output: ArchitecturalSliceSchema },
    trace: { input: TraceInput, output: ArchitecturalSliceSchema },
    tests: { input: TestsInput, output: Schema.Array(GraphNodeSchema) },
    symbols: { input: SymbolsInput, output: Schema.Array(GraphNodeSchema) },
    relationships: { input: RelationshipsInput, output: Schema.Array(GraphNodeSchema) },
    ownership: { input: OwnershipInput, output: OwnershipOutputSchema },
    slice: { input: ArchitecturalSliceQuery, output: ArchitecturalSliceSchema },
    codeFind: { input: CodeFindRpcInput, output: CodeFindOutput },
    preflight: { input: PreflightInput, output: PreflightOutput },
    blastRadius: { input: BlastRadiusInput, output: BlastRadiusOutput },
    safeRename: {
      input: SafeRenameInput,
      output: SafeRenameOutput,
      errors: { "intel.invalid_request": Schema.Struct({ message: Schema.String }) },
    },
  },
  events: {},
})

export interface HandlerDeps {
  readonly port: CodegraphPort
  readonly intel: Intelligence
  readonly planner: EditPlannerInterface
}

export const handlers = (deps: HandlerDeps): RpcHandlers<typeof Definition> => ({
  query: (input: typeof QueryInput.Type) =>
    Effect.gen(function* () {
      const context = yield* deps.intel.query(input)
      const slice = yield* deps.intel.slice(context)
      return { slice, context }
    }),
  explain: (input: typeof ExplainInput.Type) => deps.intel.explain(input),
  impact: (input: typeof ImpactInput.Type) => deps.intel.impact(input),
  trace: (input: typeof TraceInput.Type) => deps.intel.trace(input),
  tests: (input: typeof TestsInput.Type) =>
    deps.intel.tests(input).pipe(Effect.map((result) => [...result.tests])),
  symbols: (input: typeof SymbolsInput.Type) => deps.intel.symbols(input),
  relationships: (input: typeof RelationshipsInput.Type) => deps.intel.relationships(input),
  ownership: (input: typeof OwnershipInput.Type) =>
    deps.intel.findOwner({
      path: input.path,
      ...(input.workspace?.worktree ? { cwd: input.workspace.worktree } : {}),
    }),
  slice: (input: typeof ArchitecturalSliceQuery.Type) => deps.intel.explain({ symbol: input.focus }),
  codeFind: (input: typeof CodeFindRpcInput.Type) =>
    computeCodeFind(deps.port, { ...input, includeKeywordFallback: input.includeKeywordFallback ?? true }),
  preflight: (input: typeof PreflightInput.Type) =>
    computePreflight({ port: deps.port, intel: deps.intel }, input),
  blastRadius: (input: typeof BlastRadiusInput.Type) =>
    computeBlastRadius({ port: deps.port, intel: deps.intel }, input),
  safeRename: (
    input: typeof SafeRenameInput.Type,
    context: RpcCallContext<typeof Definition.methods.safeRename>,
  ) =>
    computeSafeRename({ port: deps.port, intel: deps.intel, planner: deps.planner }, input).pipe(
      Effect.catchIf(
        (error): error is RenamePlanError => error instanceof RenamePlanError,
        (error) => Effect.fail(context.error("intel.invalid_request", error.message, { message: error.message })),
      ),
    ),
})
