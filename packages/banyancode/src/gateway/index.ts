export * as Gateway from "./gateway.js"
export * as GatewayRouting from "./routing.js"
export * as GatewayTrace from "./trace.js"
export * as GatewayFormatter from "./formatter.js"
export * as GatewayTypes from "./types.js"
export { register, augmentEnabled, traceEnabled, GATEWAY_TOOLS, PROBE_TIMEOUT_MS } from "./gateway.js"
export {
  decide,
  identifierQuery,
  isCodePath,
  isConfigPath,
  isDocumentationPath,
  isEnvPath,
  isExternalPath,
  isMediaPath,
  routeName,
  DEFAULT_READ_OUTLINE_LINES,
} from "./routing.js"
export { formatAugmentHeader } from "./formatter.js"
export type { AugmentSymbolCounts } from "./formatter.js"
export type { GatewayMetadata, GatewayProbe, GatewayTarget, Decision, ProbeResult } from "./types.js"
