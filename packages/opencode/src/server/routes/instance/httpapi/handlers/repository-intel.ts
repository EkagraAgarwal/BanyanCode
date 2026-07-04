import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Banyan } from "@opencode-ai/core/banyancode"
import { RootHttpApi } from "../api"
import {
  ExplainInput,
  ImpactInput,
  OwnershipInput,
  QueryInput,
  RelationshipsInput,
  SymbolsInput,
  TestsInput,
  TraceInput,
  type RepositoryResponse,
} from "../groups/repository-intel"

export const repositoryIntelHandlers = HttpApiBuilder.group(RootHttpApi, "repository-intel", (handlers) =>
  Effect.gen(function* () {
    const intel = yield* Banyan.RepositoryIntelligence

    const queryHandler = Effect.fn("RepositoryIntel.query")(function* (ctx: {
      payload: typeof QueryInput.Type
    }) {
      const ctx_eff = yield* intel.query({
        query: ctx.payload.query,
        limit: ctx.payload.limit,
        workspace: ctx.payload.workspace,
      })
      const slice = yield* intel.slice(ctx_eff)
      return { slice, context: ctx_eff } satisfies RepositoryResponse
    })

    const explainHandler = Effect.fn("RepositoryIntel.explain")(function* (ctx: {
      payload: typeof ExplainInput.Type
    }) {
      return yield* intel.explain({
        symbol: ctx.payload.symbol,
        workspace: ctx.payload.workspace,
      })
    })

    const impactHandler = Effect.fn("RepositoryIntel.impact")(function* (ctx: {
      payload: typeof ImpactInput.Type
    }) {
      return yield* intel.impact({
        path: ctx.payload.path,
        workspace: ctx.payload.workspace,
      })
    })

    const traceHandler = Effect.fn("RepositoryIntel.trace")(function* (ctx: {
      payload: typeof TraceInput.Type
    }) {
      return yield* intel.trace({
        symbol: ctx.payload.symbol,
        depth: ctx.payload.depth,
        workspace: ctx.payload.workspace,
      })
    })

    const testsHandler = Effect.fn("RepositoryIntel.tests")(function* (ctx: {
      payload: typeof TestsInput.Type
    }) {
      return yield* intel.tests({ symbol: ctx.payload.symbol })
    })

    const symbolsHandler = Effect.fn("RepositoryIntel.symbols")(function* (ctx: {
      payload: typeof SymbolsInput.Type
    }) {
      return yield* intel.symbols({
        query: ctx.payload.query,
        limit: ctx.payload.limit,
      })
    })

    const relationshipsHandler = Effect.fn("RepositoryIntel.relationships")(function* (ctx: {
      payload: typeof RelationshipsInput.Type
    }) {
      return yield* intel.relationships({
        nodeID: ctx.payload.nodeID,
        depth: ctx.payload.depth,
      })
    })

    const ownershipHandler = Effect.fn("RepositoryIntel.ownership")(function* (ctx: {
      payload: typeof OwnershipInput.Type
    }) {
      return yield* intel.findOwner({ path: ctx.payload.path })
    })

    const architecturalSliceHandler = Effect.fn("RepositoryIntel.architecturalSlice")(function* (ctx: {
      query: { focus: string }
    }) {
      return yield* intel.explain({ symbol: ctx.query.focus })
    })

    return handlers
      .handle("query", queryHandler)
      .handle("explain", explainHandler)
      .handle("impact", impactHandler)
      .handle("trace", traceHandler)
      .handle("tests", testsHandler)
      .handle("symbols", symbolsHandler)
      .handle("relationships", relationshipsHandler)
      .handle("ownership", ownershipHandler)
      .handle("architecturalSlice", architecturalSliceHandler)
  }),
)
