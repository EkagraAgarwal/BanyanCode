import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { isAbsolute, join, relative, resolve } from "node:path"
import { Option, Schema } from "effect"
import { parseJsonc } from "./jsonc.js"
import {
  AgentKeys,
  DEFAULT_MAX_SUBAGENTS,
  Info,
  InfoKeys,
  MAX_SUBAGENTS_LIMIT,
  type Info as BanyanConfigInfo,
} from "./schema.js"

export type ConfigScope = "global" | "project"

export interface ConfigSource {
  readonly file: string
  readonly scope: ConfigScope
}

export interface UnknownKeys {
  readonly file: string
  readonly keys: readonly string[]
}

export interface ConfigError {
  readonly file: string
  readonly message: string
}

export interface Loaded {
  readonly config: BanyanConfigInfo
  readonly sources: readonly ConfigSource[]
  readonly unknownKeys: readonly UnknownKeys[]
  readonly errors: readonly ConfigError[]
}

export interface LoadInput {
  /** Working directory / location directory the plugin activates in. */
  readonly directory: string
  /** Canonical project root; the upward search stops here. */
  readonly projectRoot: string
  /** Overrides the global config dir (tests). */
  readonly globalDir?: string
  readonly env?: NodeJS.ProcessEnv
  readonly home?: string
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/**
 * Global BanyanCode config directory. v2 has no branding patch yet, so the
 * plugin cannot read `Global.Path.config`; derive the same location the
 * identity layer will use: `$BANYANCODE_CONFIG_DIR`, then
 * `$XDG_CONFIG_HOME/banyancode`, then `~/.config/banyancode`.
 */
export const globalConfigDir = (env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string => {
  const explicit = env.BANYANCODE_CONFIG_DIR?.trim()
  if (explicit && explicit.length > 0) return explicit
  const xdg = env.XDG_CONFIG_HOME?.trim()
  const base = xdg && xdg.length > 0 ? xdg : join(home, ".config")
  return join(base, "banyancode")
}

const configCandidates = (directory: string, dotDir: boolean): string[] => [
  join(directory, "banyancode.jsonc"),
  join(directory, "banyancode.json"),
  ...(dotDir ? [join(directory, ".banyancode", "banyancode.jsonc"), join(directory, ".banyancode", "banyancode.json")] : []),
]

const findConfigFile = (directory: string, dotDir: boolean): string | undefined =>
  configCandidates(directory, dotDir).find((candidate) => existsSync(candidate))

/**
 * Project config files from the project root down to the working directory,
 * so the nearest file wins (v1 `ConfigPaths.banyanFiles` order). Directories
 * outside the project root degrade to `[root, directory]`.
 */
export const projectConfigDirs = (directory: string, projectRoot: string): readonly string[] => {
  const root = resolve(projectRoot)
  const dir = resolve(directory)
  if (root === dir) return [root]
  const rel = relative(root, dir)
  if (rel.startsWith("..") || isAbsolute(rel)) return [root, dir]
  const parts = rel.split(/[\\/]+/).filter(Boolean)
  return [root, ...parts.map((_, index) => join(root, ...parts.slice(0, index + 1)))]
}

const unknownKeysFor = (file: string, raw: Record<string, unknown>): UnknownKeys | undefined => {
  const keys = Object.keys(raw).filter((key) => !InfoKeys.has(key))
  if (isRecord(raw.agent)) {
    for (const [name, value] of Object.entries(raw.agent)) {
      if (!isRecord(value)) continue
      for (const key of Object.keys(value)) {
        if (!AgentKeys.has(key)) keys.push(`agent.${name}.${key}`)
      }
    }
  }
  return keys.length > 0 ? { file, keys } : undefined
}

/**
 * Reads and merges global then project config. Project values win with a
 * shallow top-level merge, matching v1's `BanyanConfigService.readConfig`
 * (`{ ...global, ...local }`); a project `agent` record therefore replaces
 * the global `agent` record rather than merging per agent.
 */
export const load = async (input: LoadInput): Promise<Loaded> => {
  const entries: { file: string; scope: ConfigScope; raw: Record<string, unknown> }[] = []
  const sources: ConfigSource[] = []
  const unknownKeys: UnknownKeys[] = []
  const errors: ConfigError[] = []

  const read = async (file: string, scope: ConfigScope) => {
    let text: string
    try {
      text = await readFile(file, "utf8")
    } catch (cause) {
      errors.push({ file, message: cause instanceof Error ? cause.message : String(cause) })
      return
    }
    let parsed: unknown
    try {
      parsed = parseJsonc(text)
    } catch (cause) {
      errors.push({ file, message: `invalid JSON/JSONC: ${cause instanceof Error ? cause.message : String(cause)}` })
      return
    }
    if (!isRecord(parsed)) {
      errors.push({ file, message: "expected a JSON object" })
      return
    }
    const unknown = unknownKeysFor(file, parsed)
    if (unknown) unknownKeys.push(unknown)
    entries.push({ file, scope, raw: parsed })
    sources.push({ file, scope })
  }

  const globalDir = input.globalDir ?? globalConfigDir(input.env, input.home)
  const globalFile = findConfigFile(globalDir, false)
  if (globalFile) await read(globalFile, "global")

  for (const directory of projectConfigDirs(input.directory, input.projectRoot)) {
    const file = findConfigFile(directory, true)
    if (file) await read(file, "project")
  }

  const merged = entries.reduce<Record<string, unknown>>((result, entry) => ({ ...result, ...entry.raw }), {})
  const decoded = Schema.decodeUnknownOption(Info, { errors: "all", onExcessProperty: "ignore" })(merged)
  if (Option.isNone(decoded)) {
    errors.push({
      file: sources.at(-1)?.file ?? "banyancode.json",
      message: "configuration did not match the BanyanConfig schema",
    })
  }

  return {
    config: Option.isSome(decoded) ? decoded.value : ({} as BanyanConfigInfo),
    sources,
    unknownKeys,
    errors,
  }
}

export interface Summary {
  readonly yoloMode: boolean
  readonly telemetry: "on" | "off"
  readonly backgroundSubagents: boolean
  readonly maxSubagents: number
  readonly codegraphWatch: boolean
  readonly agentOverrides: number
  readonly sourceCount: number
  readonly unknownKeyCount: number
}

export const summarize = (loaded: Loaded): Summary => {
  const max = Math.trunc(loaded.config.banyancode_max_subagents ?? DEFAULT_MAX_SUBAGENTS)
  return {
    yoloMode: loaded.config.banyancode_yolo_mode === true,
    telemetry: loaded.config.banyancode_telemetry ?? "on",
    backgroundSubagents: loaded.config.banyancode_background_subagents !== false,
    maxSubagents: Math.min(MAX_SUBAGENTS_LIMIT, Math.max(1, Number.isFinite(max) ? max : DEFAULT_MAX_SUBAGENTS)),
    codegraphWatch: loaded.config.banyancode_codegraph_watch_enabled !== false,
    agentOverrides: Object.keys(loaded.config.agent ?? {}).length,
    sourceCount: loaded.sources.length,
    unknownKeyCount: loaded.unknownKeys.reduce((count, entry) => count + entry.keys.length, 0),
  }
}

export const empty = (): Loaded => ({ config: {}, sources: [], unknownKeys: [], errors: [] })
