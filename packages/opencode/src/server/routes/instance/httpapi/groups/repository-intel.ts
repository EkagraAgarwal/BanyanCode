import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { CodegraphNodeSchema } from "@opencode-ai/core/banyancode/types"
import { described } from "./metadata"

const SearchIntent = Schema.Literals(["exact", "prefix", "fuzzy", "structural", "graph", "subsystem", "tests"])

const SearchSignalSchema = Schema.Struct({
  exact: Schema.optional(Schema.Boolean),
  prefix: Schema.optional(Schema.Boolean),
  camelCase: Schema.optional(Schema.Boolean),
  snake_case: Schema.optional(Schema.Boolean),
  bm25: Schema.optional(Schema.Number),
  fuzzy: Schema.optional(Schema.Number),
  qualified: Schema.optional(Schema.Boolean),
  graph: Schema.optional(Schema.Number),
  git: Schema.optional(Schema.Number),
  workspace: Schema.optional(Schema.Number),
})

export const SearchResultSchema = Schema.Struct({
  node: CodegraphNodeSchema,
  score: Schema.Number,
  signals: SearchSignalSchema,
})

export const RepositoryIntelPaths = {
  findSymbol: "/global/repo/find-symbol",
  findSubsystem: "/global/repo/find-subsystem",
  findEntrypoints: "/global/repo/find-entrypoints",
  findTests: "/global/repo/find-tests",
  findRelated: "/global/repo/find-related",
  estimateImpact: "/global/repo/estimate-impact",
  traceExecution: "/global/repo/trace-execution",
  search: "/global/codegraph/search",
  findImplementations: "/global/codegraph/find-implementations",
  findOverrides: "/global/codegraph/find-overrides",
  findRecursive: "/global/codegraph/find-recursive",
  findAsync: "/global/codegraph/find-async",
  findHttpRoutes: "/global/codegraph/find-http-routes",
} as const

export const FindSymbolInput = Schema.Struct({
  name: Schema.String,
  kind: Schema.optional(Schema.String),
  file: Schema.optional(Schema.String),
  exact: Schema.optional(Schema.Boolean),
})

export const FindSubsystemInput = Schema.Struct({
  query: Schema.String,
  maxDepth: Schema.optional(Schema.Number),
})

export const FindSubsystemResult = Schema.Struct({
  entry: CodegraphNodeSchema,
  related: Schema.Array(CodegraphNodeSchema),
})

export const FindEntrypointsInput = Schema.Struct({
  feature: Schema.String,
})

export const FindTestsInput = Schema.Struct({
  symbol: Schema.String,
})

export const FindRelatedInput = Schema.Struct({
  nodeID: Schema.String,
  depth: Schema.optional(Schema.Number),
})

export const EstimateImpactInput = Schema.Struct({
  paths: Schema.Array(Schema.String),
  maxDepth: Schema.optional(Schema.Number),
})

export const EstimateImpactResult = Schema.Struct({
  direct: Schema.Array(CodegraphNodeSchema),
  transitive: Schema.Array(CodegraphNodeSchema),
  blastRadius: Schema.Number,
})

export const TraceExecutionInput = Schema.Struct({
  from: Schema.String,
  maxDepth: Schema.optional(Schema.Number),
})

export const SearchInput = Schema.Struct({
  query: Schema.String,
  modes: Schema.optional(Schema.Array(SearchIntent)),
  limit: Schema.optional(Schema.Number),
})

export const FindImplementationsInput = Schema.Struct({
  interfaceName: Schema.String,
  file: Schema.optional(Schema.String),
  language: Schema.optional(Schema.String),
})

export const FindOverridesInput = Schema.Struct({
  methodName: Schema.String,
  baseClass: Schema.optional(Schema.String),
  file: Schema.optional(Schema.String),
  language: Schema.optional(Schema.String),
})

export const FindFileLanguageInput = Schema.Struct({
  file: Schema.optional(Schema.String),
  language: Schema.optional(Schema.String),
})

export const RepositoryIntelApi = HttpApi.make("repository-intel").add(
  HttpApiGroup.make("repository-intel")
    .add(
      HttpApiEndpoint.post("findSymbol", RepositoryIntelPaths.findSymbol, {
        payload: FindSymbolInput,
        success: described(Schema.Array(CodegraphNodeSchema), "Matching symbols"),
      }).annotateMerge(OpenApi.annotations({ identifier: "repositoryIntel.findSymbol", summary: "Find symbol" })),
      HttpApiEndpoint.post("findSubsystem", RepositoryIntelPaths.findSubsystem, {
        payload: FindSubsystemInput,
        success: described(FindSubsystemResult, "Subsystem entry and related nodes"),
      }).annotateMerge(OpenApi.annotations({ identifier: "repositoryIntel.findSubsystem", summary: "Find subsystem" })),
      HttpApiEndpoint.post("findEntrypoints", RepositoryIntelPaths.findEntrypoints, {
        payload: FindEntrypointsInput,
        success: described(Schema.Array(CodegraphNodeSchema), "Feature entrypoints"),
      }).annotateMerge(OpenApi.annotations({ identifier: "repositoryIntel.findEntrypoints", summary: "Find entrypoints" })),
      HttpApiEndpoint.post("findTests", RepositoryIntelPaths.findTests, {
        payload: FindTestsInput,
        success: described(Schema.Array(CodegraphNodeSchema), "Tests for symbol"),
      }).annotateMerge(OpenApi.annotations({ identifier: "repositoryIntel.findTests", summary: "Find tests" })),
      HttpApiEndpoint.post("findRelated", RepositoryIntelPaths.findRelated, {
        payload: FindRelatedInput,
        success: described(Schema.Array(CodegraphNodeSchema), "Related nodes"),
      }).annotateMerge(OpenApi.annotations({ identifier: "repositoryIntel.findRelated", summary: "Find related" })),
      HttpApiEndpoint.post("estimateImpact", RepositoryIntelPaths.estimateImpact, {
        payload: EstimateImpactInput,
        success: described(EstimateImpactResult, "Impact estimate"),
      }).annotateMerge(OpenApi.annotations({ identifier: "repositoryIntel.estimateImpact", summary: "Estimate impact" })),
      HttpApiEndpoint.post("traceExecution", RepositoryIntelPaths.traceExecution, {
        payload: TraceExecutionInput,
        success: described(Schema.Array(CodegraphNodeSchema), "Execution trace"),
      }).annotateMerge(OpenApi.annotations({ identifier: "repositoryIntel.traceExecution", summary: "Trace execution" })),
      HttpApiEndpoint.post("search", RepositoryIntelPaths.search, {
        payload: SearchInput,
        success: described(Schema.Array(SearchResultSchema), "Search results"),
      }).annotateMerge(OpenApi.annotations({ identifier: "repositoryIntel.search", summary: "Codegraph search" })),
      HttpApiEndpoint.post("findImplementations", RepositoryIntelPaths.findImplementations, {
        payload: FindImplementationsInput,
        success: described(Schema.Array(CodegraphNodeSchema), "Implementations"),
      }).annotateMerge(OpenApi.annotations({ identifier: "repositoryIntel.findImplementations", summary: "Find implementations" })),
      HttpApiEndpoint.post("findOverrides", RepositoryIntelPaths.findOverrides, {
        payload: FindOverridesInput,
        success: described(Schema.Array(CodegraphNodeSchema), "Method overrides"),
      }).annotateMerge(OpenApi.annotations({ identifier: "repositoryIntel.findOverrides", summary: "Find overrides" })),
      HttpApiEndpoint.post("findRecursive", RepositoryIntelPaths.findRecursive, {
        payload: FindFileLanguageInput,
        success: described(Schema.Array(CodegraphNodeSchema), "Recursive functions"),
      }).annotateMerge(OpenApi.annotations({ identifier: "repositoryIntel.findRecursive", summary: "Find recursive functions" })),
      HttpApiEndpoint.post("findAsync", RepositoryIntelPaths.findAsync, {
        payload: FindFileLanguageInput,
        success: described(Schema.Array(CodegraphNodeSchema), "Async functions"),
      }).annotateMerge(OpenApi.annotations({ identifier: "repositoryIntel.findAsync", summary: "Find async functions" })),
      HttpApiEndpoint.post("findHttpRoutes", RepositoryIntelPaths.findHttpRoutes, {
        payload: FindFileLanguageInput,
        success: described(Schema.Array(CodegraphNodeSchema), "HTTP routes"),
      }).annotateMerge(OpenApi.annotations({ identifier: "repositoryIntel.findHttpRoutes", summary: "Find HTTP routes" })),
    ),
)
