/**
 * Deterministic routing rules module — pure functions and types consumed later
 * by the RepositoryGateway. Flat exports plus self-reexports per repo
 * convention (no `export namespace`).
 */
export type { RuleInput, RuleVerdict, RouteVerdict } from "./types"
export { evaluate, REASON_CODES, CONFIDENCE } from "./rules"
export {
  extractPaths,
  extractPattern,
  hasRelationshipLanguage,
  isConfigFile,
  isDirectPathSignal,
  isDocsScoped,
  isDocumentationPath,
  isExactFileRead,
  isLiteralQuery,
  normalizePath,
} from "./features"
export { HIGH_CONFIDENCE, MID_CONFIDENCE, routeForConfidence } from "./thresholds"
export {
  expectedCoarseRoute,
  scoreCorpus,
  toRuleInput,
  type BenchResult,
  type CaseScore,
  type CategoryScore,
  type CoarseRoute,
  type Evaluator,
} from "./bench"
export * as RoutingRules from "./rules"
export * as RoutingFeatures from "./features"
export * as RoutingThresholds from "./thresholds"
export * as RoutingBench from "./bench"
