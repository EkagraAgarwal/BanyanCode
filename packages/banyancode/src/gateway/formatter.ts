export * as GatewayFormatter from "./formatter.js"

export interface AugmentSymbolCounts {
  readonly symbol: string
  readonly imports: number
  readonly references: number
  readonly callers: number
  readonly dependents: number
}

/**
 * Exact v1 AUGMENT header (spec §6.2/§29), so a `CodegraphQuery.augmentRead`
 * adapter can produce byte-identical output.
 */
export const formatAugmentHeader = (counts: AugmentSymbolCounts): string =>
  `Symbol: ${counts.symbol} | Imports: ${counts.imports} | References: ${counts.references} | Callers: ${counts.callers} | Dependents: ${counts.dependents}`
