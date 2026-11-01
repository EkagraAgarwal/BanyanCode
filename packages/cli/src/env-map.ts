import { Product } from "@opencode/util/product"

export const marker = `${Product.envPrefix}INTERNAL_ENV_MAPPED`

/**
 * Maps the BanyanCode environment namespace onto the internal OpenCode namespace.
 * Every pre-existing OpenCode variable is removed first, so a stock OpenCode
 * install's settings never leak into BanyanCode. Call once, before any module
 * reads `process.env`.
 *
 * Child processes the CLI spawns (the standalone `serve` server, PTY handoffs)
 * inherit an already-mapped environment plus internal `OPENCODE_*` values the
 * parent set on purpose, such as the lease password. The marker makes those
 * children skip the rewrite so the parent's explicit values survive.
 */
export function apply(env: NodeJS.ProcessEnv = process.env) {
  if (env[marker] === "1") return
  env[marker] = "1"
  for (const key of Object.keys(env)) {
    if (key.startsWith(Product.internalEnvPrefix)) delete env[key]
  }
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith(Product.envPrefix)) continue
    const name = `${Product.internalEnvPrefix}${key.slice(Product.envPrefix.length)}`
    if (value === undefined) delete env[name]
    else env[name] = value
  }
}

export * as EnvMap from "./env-map.js"
