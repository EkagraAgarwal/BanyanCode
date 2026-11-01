// BanyanCode product identity. Every branded path, file name and CLI name derives
// from this module, so the upstream patch ledger stays a list of call sites rather
// than scattered literals.

export const app = "banyancode"
/** Project and global configuration file names, highest priority last. */
export const configNames = ["banyancode.json", "banyancode.jsonc"] as const
/** Repository-scoped configuration and plugin directory. */
export const projectDir = `.${app}`
/** Default SQLite file name inside the global data directory. */
export const dbName = `${app}.db`
/** CLI command name shown by `--help` and used by build-time defines. */
export const cliName = app
/** Environment namespace the product reads. */
export const envPrefix = "BANYANCODE_"
/** Internal environment namespace the CLI maps the product namespace onto. */
export const internalEnvPrefix = "OPENCODE_"
/** macOS MDM managed preferences bundle identifier. */
export const managedPreferences = `ai.${app}.managed`

export * as Product from "./product.js"
