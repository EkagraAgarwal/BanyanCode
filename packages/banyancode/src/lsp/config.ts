import path from "node:path"
import { existsSync } from "node:fs"
import os from "node:os"
import { readFile } from "node:fs/promises"
import { globalConfigDir, projectConfigDirs } from "../config/loader.js"
import { stripJsonc } from "../config/jsonc.js"
import { builtinServers, resolveTypescriptMaxMemoryMb } from "./server.js"
import { spawn } from "./process.js"
import type { Flags, Info } from "./types.js"

/**
 * LSP configuration resolution.
 *
 * Two sources, in v1 order of authority:
 * 1. the host `lsp` key (`ConfigLSP.Info` from `@opencode/schema/config/lsp`)
 * 2. `banyancode_lsp` / `banyancode_lsp_idle_timeout_ms` (the BanyanCode keys
 *    v1's `/lsp` and settings panel wrote)
 *
 * `banyancode_lsp` wins when present: `false` disables everything, `true`
 * enables the built-ins, and a record overlays per-server overrides on top of
 * the host record. An unset `banyancode_lsp` leaves the host `lsp` key in
 * charge, so an OpenCode-style config keeps working after re-platforming.
 */

export const DEFAULT_LSP_IDLE_TIMEOUT_MS = 5 * 60 * 1000

export interface EntryConfig {
  readonly command?: readonly string[]
  readonly extensions?: readonly string[]
  readonly disabled?: boolean
  readonly env?: Readonly<Record<string, string>>
  readonly initialization?: Readonly<Record<string, unknown>>
  readonly maxMemoryMb?: number
  readonly idleTimeoutMs?: number
}

export type Setting = boolean | Record<string, EntryConfig>

export interface Resolved {
  readonly enabled: boolean
  readonly servers: Record<string, Info>
  readonly disabled: Map<string, string>
  readonly idleTimeoutMs: number
  /** Per-server idle overrides; `0` disables idle shutdown for that server. */
  readonly perServerIdleTimeoutMs: Map<string, number>
  readonly flags: Flags
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const num = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined

const strings = (value: unknown): string[] | undefined =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined

export const coerceEntry = (value: unknown): EntryConfig | undefined => {
  if (!isRecord(value)) return undefined
  const command = strings(value.command)
  const extensions = strings(value.extensions)
  const env = isRecord(value.env)
    ? Object.fromEntries(Object.entries(value.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
    : undefined
  const initialization = isRecord(value.initialization) ? value.initialization : undefined
  const disabled = value.disabled === true ? true : undefined
  const maxMemoryMb = num(value.maxMemoryMb)
  const idleTimeoutMs = num(value.idleTimeoutMs)
  if (disabled) return { disabled: true }
  return {
    ...(command ? { command } : {}),
    ...(extensions ? { extensions } : {}),
    ...(env ? { env } : {}),
    ...(initialization ? { initialization } : {}),
    ...(maxMemoryMb !== undefined ? { maxMemoryMb } : {}),
    ...(idleTimeoutMs !== undefined ? { idleTimeoutMs } : {}),
  }
}

export const coerceSetting = (value: unknown): Setting | undefined => {
  if (typeof value === "boolean") return value
  if (!isRecord(value)) return undefined
  const entries: Record<string, EntryConfig> = {}
  for (const [id, raw] of Object.entries(value)) {
    const entry = coerceEntry(raw)
    if (entry) entries[id] = entry
  }
  return entries
}

const envFlag = (env: NodeJS.ProcessEnv, ...names: string[]): boolean =>
  names.some((name) => /^(?:1|true|yes|on)$/i.test(env[name] ?? ""))

export const resolveFlags = (env: NodeJS.ProcessEnv = process.env): Flags => ({
  disableLspDownload: envFlag(env, "BANYANCODE_DISABLE_LSP_DOWNLOAD", "OPENCODE_DISABLE_LSP_DOWNLOAD"),
  experimentalLspTy: envFlag(env, "BANYANCODE_EXPERIMENTAL_LSP_TY", "OPENCODE_EXPERIMENTAL_LSP_TY"),
  experimentalLspTool: envFlag(env, "BANYANCODE_EXPERIMENTAL_LSP_TOOL", "OPENCODE_EXPERIMENTAL_LSP_TOOL"),
})

export const resolveIdleTimeoutMs = (raw: unknown): number => {
  if (raw === 0) return 0
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return DEFAULT_LSP_IDLE_TIMEOUT_MS
  return Math.floor(raw)
}

const filterExperimentalServers = (servers: Record<string, Info>, flags: Flags) => {
  if (flags.experimentalLspTy) delete servers["pyright"]
  else delete servers["ty"]
}

const mergeServerInitialization = (
  serverID: string,
  handleInit: Record<string, unknown> | undefined,
  item: EntryConfig,
) => {
  if (serverID !== "typescript") return item.initialization ?? handleInit
  const itemInit = item.initialization
  const handleTs = handleInit?.["tsserver"]
  const itemTs = itemInit?.["tsserver"]
  const explicit =
    typeof itemTs === "object" && itemTs !== null
      ? (itemTs as Record<string, unknown>)["maxTsServerMemory"]
      : undefined
  const maxTsServerMemory =
    typeof explicit === "number" && Number.isFinite(explicit) && explicit > 0
      ? Math.floor(Math.min(Math.max(explicit, 256), 16384))
      : resolveTypescriptMaxMemoryMb(item.maxMemoryMb)
  return {
    ...(handleInit ?? {}),
    ...(itemInit ?? {}),
    tsserver: {
      ...(typeof handleTs === "object" && handleTs !== null ? (handleTs as Record<string, unknown>) : {}),
      ...(typeof itemTs === "object" && itemTs !== null ? (itemTs as Record<string, unknown>) : {}),
      maxTsServerMemory,
    },
  }
}

const mergeEntries = (
  host: Setting | undefined,
  banyan: Setting | undefined,
): Record<string, EntryConfig> => {
  const base = typeof host === "object" ? host : {}
  const overlay = typeof banyan === "object" ? banyan : {}
  return { ...base, ...overlay }
}

export const resolveConfig = (input: {
  readonly host?: unknown
  readonly banyan?: unknown
  readonly banyanIdleTimeoutMs?: unknown
  readonly env?: NodeJS.ProcessEnv
}): Resolved => {
  const env = input.env ?? process.env
  const flags = resolveFlags(env)
  const host = coerceSetting(input.host)
  const banyan = coerceSetting(input.banyan)
  const enabled = banyan === undefined ? host === true || typeof host === "object" : banyan !== false
  const idleTimeoutMs = resolveIdleTimeoutMs(input.banyanIdleTimeoutMs)

  if (!enabled) {
    return {
      enabled: false,
      servers: {},
      disabled: new Map(),
      idleTimeoutMs,
      perServerIdleTimeoutMs: new Map(),
      flags,
    }
  }

  const servers: Record<string, Info> = {}
  for (const server of builtinServers) servers[server.id] = server
  filterExperimentalServers(servers, flags)

  const entries = mergeEntries(host, banyan)
  const disabled = new Map<string, string>()
  const perServerIdleTimeoutMs = new Map<string, number>()

  for (const [name, item] of Object.entries(entries)) {
    if (item.disabled) {
      disabled.set(name, "disabled in banyancode.json")
      delete servers[name]
      continue
    }
    if (item.idleTimeoutMs !== undefined) {
      perServerIdleTimeoutMs.set(name, resolveIdleTimeoutMs(item.idleTimeoutMs))
    }
    const existing = servers[name]
    servers[name] = {
      ...existing,
      id: name,
      root: existing?.root ?? (async (_file, ctx) => ctx.directory),
      extensions: item.extensions ? [...item.extensions] : (existing?.extensions ?? []),
      spawn: item.command
        ? async (root) => ({
            process: spawn([...item.command!], { cwd: root, env: { ...process.env, ...item.env } }),
            initialization:
              name === "typescript" ? mergeServerInitialization(name, undefined, item) : item.initialization,
          })
        : existing?.spawn
          ? async (root, ctx, next) => {
              const handle = await existing.spawn(root, ctx, next)
              if (!handle) return undefined
              return {
                ...handle,
                initialization: mergeServerInitialization(name, handle.initialization, item),
              }
            }
          : async () => undefined,
    }
  }

  return { enabled: true, servers, disabled, idleTimeoutMs, perServerIdleTimeoutMs, flags }
}

/**
 * Reads the host `lsp` key from the same configuration files the plugin reads
 * (`banyancode.json[c]` global + project). v2 exposes no plugin-facing config
 * API, and the host normalizer ignores unknown keys, so the raw file is the
 * only surface where `lsp` survives.
 */
export const readHostLsp = async (input: {
  readonly directory: string
  readonly projectRoot: string
  readonly globalDir?: string
  readonly env?: NodeJS.ProcessEnv
  readonly home?: string
}): Promise<unknown> => {
  const env = input.env ?? process.env
  const globalDir = input.globalDir ?? globalConfigDir(env, input.home ?? os.homedir())
  const dirs = [globalDir, ...projectConfigDirs(input.directory, input.projectRoot)]
  let value: unknown
  for (const dir of dirs) {
    for (const name of ["banyancode.jsonc", "banyancode.json"]) {
      const file = path.join(dir, name)
      if (!existsSync(file)) continue
      try {
        const parsed: unknown = JSON.parse(stripJsonc(await readFile(file, "utf8")))
        if (isRecord(parsed) && "lsp" in parsed) value = parsed.lsp
      } catch {
        // A malformed file must not disable LSP; the plugin config loader
        // reports it separately.
      }
      break
    }
  }
  return value
}
