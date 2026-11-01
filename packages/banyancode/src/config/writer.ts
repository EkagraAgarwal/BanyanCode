import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { Option, Schema } from "effect"
import { withFileLock } from "../storage/lock.js"
import { patchTopLevel, remove, set } from "./edit.js"
import { notifyConfigUpdated } from "./events.js"
import { globalConfigDir, load, type Loaded } from "./loader.js"
import { parseJsonc } from "./jsonc.js"
import { Info, type Info as BanyanConfigInfo } from "./schema.js"

/**
 * Atomic `banyancode.json[c]` writers.
 *
 * Every read-modify-write runs under a sibling `<file>.lock` (the v1
 * data-loss lesson: two agents saving config at once must not overwrite each
 * other). The edited text is written to a temp file in the same directory and
 * renamed over the target, so a crash never leaves a half-written config.
 *
 * Comments and key order are preserved by `edit.ts`. The v1 service used
 * `JSON.stringify(config)`, which silently stripped both.
 */

export interface WriteTarget {
  readonly scope?: "global" | "project"
  /** Plugin location directory (project config search starts here). */
  readonly directory?: string
  readonly projectRoot?: string
  readonly globalDir?: string
  readonly env?: NodeJS.ProcessEnv
  readonly home?: string
  /** Explicit file override (tests). */
  readonly file?: string
}

export interface WriteResult {
  readonly file: string
  readonly config: BanyanConfigInfo
  readonly loaded: Loaded
}

const configCandidates = (directory: string, dotDir: boolean): string[] => [
  join(directory, "banyancode.jsonc"),
  join(directory, "banyancode.json"),
  ...(dotDir
    ? [join(directory, ".banyancode", "banyancode.jsonc"), join(directory, ".banyancode", "banyancode.json")]
    : []),
]

const existing = async (candidates: readonly string[]): Promise<string | undefined> => {
  for (const candidate of candidates) {
    try {
      await readFile(candidate)
      return candidate
    } catch {
      // keep looking
    }
  }
  return undefined
}

/**
 * Resolve the file a write targets. Existing files win (including `.jsonc`);
 * otherwise the canonical `banyancode.json` is created.
 */
export const targetFile = async (target: WriteTarget = {}): Promise<string> => {
  if (target.file !== undefined) return resolve(target.file)
  const scope = target.scope ?? "global"
  if (scope === "project") {
    const directory = resolve(target.projectRoot ?? target.directory ?? process.cwd())
    const found = await existing(configCandidates(directory, true))
    return found ?? join(directory, "banyancode.json")
  }
  const globalDir = target.globalDir ?? globalConfigDir(target.env, target.home)
  const found = await existing(configCandidates(globalDir, false))
  return found ?? join(globalDir, "banyancode.json")
}

const tempName = (file: string): string =>
  join(dirname(file), `.${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`)

const writeAtomic = async (file: string, text: string): Promise<void> => {
  await mkdir(dirname(file), { recursive: true })
  const temp = tempName(file)
  try {
    await writeFile(temp, text, "utf8")
    await rename(temp, file)
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {})
    throw error
  }
}

const readText = async (file: string): Promise<string> => {
  try {
    return await readFile(file, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "{}\n"
    throw error
  }
}

const decode = (text: string): BanyanConfigInfo =>
  Option.getOrElse(
    Schema.decodeUnknownOption(Info, { errors: "all", onExcessProperty: "ignore" })(parseJsonc(text)),
    () => ({}) as BanyanConfigInfo,
  )

const readBack = async (target: WriteTarget, file: string, text: string): Promise<WriteResult> => {
  if (target.file !== undefined) {
    const loaded: Loaded = {
      config: decode(text),
      sources: [{ file, scope: target.scope ?? "global" }],
      unknownKeys: [],
      errors: [],
    }
    return { file, config: loaded.config, loaded }
  }
  const loaded = await load({
    directory: target.directory ?? target.projectRoot ?? process.cwd(),
    projectRoot: target.projectRoot ?? target.directory ?? process.cwd(),
    ...(target.globalDir === undefined ? {} : { globalDir: target.globalDir }),
    ...(target.env === undefined ? {} : { env: target.env }),
    ...(target.home === undefined ? {} : { home: target.home }),
  })
  return {
    file,
    config: loaded.errors.length > 0 ? decode(text) : loaded.config,
    loaded,
  }
}

const lockedEdit = async (
  target: WriteTarget,
  edit: (text: string) => string,
): Promise<WriteResult> => {
  const file = await targetFile(target)
  return withFileLock(`${file}.lock`, async () => {
    const current = await readText(file)
    const next = edit(current)
    if (next !== current) await writeAtomic(file, next.endsWith("\n") ? next : `${next}\n`)
    // v1 parity: every config write publishes `banyancode.config.updated`, so
    // other clients refresh without polling. Only after a landed write.
    if (next !== current) notifyConfigUpdated({ scope: target.scope ?? "global", file })
    return readBack(target, file, next)
  })
}

/**
 * Top-level patch. `undefined` skips a key, `null` deletes it, everything else
 * is written. Used by `/yolo`, `/lsp`, `/max-subagents`, `/swarm` and the
 * generic config.update RPC.
 */
export const update = (target: WriteTarget, patch: Readonly<Record<string, unknown>>): Promise<WriteResult> =>
  lockedEdit(target, (text) => patchTopLevel(text, patch))

export interface AgentOverridePatch {
  readonly enabled?: boolean
  readonly model?: { readonly providerID: string; readonly modelID: string } | null
  readonly thinking?: string | null
  readonly variant?: string | null
}

const agentOverrideEdit = (text: string, name: string, patch: AgentOverridePatch): string => {
  let next = text
  if (patch.enabled !== undefined) next = set(next, ["agent", name, "enabled"], patch.enabled)
  if (patch.model === null) next = remove(next, ["agent", name, "model"])
  else if (patch.model !== undefined) {
    next = set(next, ["agent", name, "model"], `${patch.model.providerID}/${patch.model.modelID}`)
  }
  if (patch.thinking === null) next = remove(next, ["agent", name, "thinking"])
  else if (patch.thinking !== undefined) next = set(next, ["agent", name, "thinking"], patch.thinking)
  if (patch.variant === null) next = remove(next, ["agent", name, "variant"])
  else if (patch.variant !== undefined) next = set(next, ["agent", name, "variant"], patch.variant)
  return next
}

/** Port of v1 `BanyanConfigService.updateAgentOverride` (atomic + locked). */
export const updateAgentOverride = (
  target: WriteTarget,
  name: string,
  patch: AgentOverridePatch,
): Promise<WriteResult> => lockedEdit(target, (text) => agentOverrideEdit(text, name, patch))

/** Port of v1 `BanyanConfigService.updateAgentPrompt` (atomic + locked). */
export const updateAgentPrompt = (
  target: WriteTarget,
  name: string,
  prompt: string,
): Promise<WriteResult> => lockedEdit(target, (text) => set(text, ["agent", name, "prompt"], prompt))

/** Remove one agent override entirely (used by tests and future TUI "reset"). */
export const removeAgentOverride = (target: WriteTarget, name: string): Promise<WriteResult> =>
  lockedEdit(target, (text) => remove(text, ["agent", name]))

export const AGENT_NAME_PATTERN = /^[a-zA-Z0-9._-]+$/
export const AGENT_NAME_MAX = 64

export const isSafeAgentName = (name: string): boolean =>
  name.length > 0 && name.length <= AGENT_NAME_MAX && AGENT_NAME_PATTERN.test(name)

/**
 * Resolve `<agentDir>/<name>.md`, rejecting anything that escapes the agent
 * directory. The schema already constrains the name; this is the defense-in-
 * depth check the v1 path-traversal lesson requires (pattern + resolved path).
 */
export const agentFilePath = (agentDir: string, name: string): string => {
  if (!isSafeAgentName(name)) {
    throw new Error("Invalid agent name. Allowed: letters, digits, '.', '_', '-'.")
  }
  const resolvedDir = resolve(agentDir)
  const resolvedFile = resolve(resolvedDir, `${name}.md`)
  const rel = relative(resolvedDir, resolvedFile)
  if (
    rel.length === 0 ||
    rel === ".." ||
    rel.startsWith(`..${sep}`) ||
    isAbsolute(rel) ||
    rel.split(/[\\/]/).some((segment) => segment === "..")
  ) {
    throw new Error("Resolved agent path escapes the agent directory.")
  }
  return resolvedFile
}

const escapeYamlScalar = (value: string): string =>
  `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`

export interface AgentSaveInput {
  readonly name: string
  readonly description?: string
  readonly mode?: "primary" | "subagent" | "all"
  readonly hidden?: boolean
  readonly model?: { readonly providerID: string; readonly modelID: string }
  readonly permission?: readonly string[]
  readonly tools?: readonly string[]
  readonly prompt?: string
  readonly thinking?: string
}

export interface AgentSaveResult {
  readonly ok: true
  readonly filePath: string
}

/**
 * Write a custom agent markdown file, matching v1's `banyan-agent/save`
 * handler byte-for-byte in the frontmatter it emits. The file lives in the
 * global BanyanCode config dir (`~/.config/banyancode/agent/<name>.md`), which
 * v2's native agent markdown discovery already loads.
 */
export const saveAgent = async (target: WriteTarget, input: AgentSaveInput): Promise<AgentSaveResult> => {
  const globalDir = target.globalDir ?? globalConfigDir(target.env, target.home)
  const directory = join(globalDir, "agent")
  const filePath = agentFilePath(directory, input.name)
  await withFileLock(`${filePath}.lock`, async () => {
    await mkdir(directory, { recursive: true })
    const modelLine = input.model
      ? `model: ${escapeYamlScalar(`${input.model.providerID}/${input.model.modelID}`)}`
      : null
    const toolsLine =
      input.tools && input.tools.length > 0
        ? `tools: { ${input.tools.map((tool) => `${escapeYamlScalar(tool)}: true`).join(", ")} }`
        : null
    const permissionLine =
      input.permission && input.permission.length > 0
        ? `permission: { ${input.permission.map((key) => `${escapeYamlScalar(key)}: "allow"`).join(", ")} }`
        : null
    const thinkingLine = input.thinking ? `thinking: ${escapeYamlScalar(input.thinking)}` : null
    const frontmatter = [
      "---",
      `name: ${escapeYamlScalar(input.name)}`,
      `description: ${escapeYamlScalar(input.description ?? "")}`,
      `mode: ${escapeYamlScalar(input.mode ?? "subagent")}`,
      input.hidden !== undefined ? `hidden: ${input.hidden}` : null,
      modelLine,
      permissionLine,
      toolsLine,
      thinkingLine,
      "---",
      "",
    ]
    const body = input.prompt ? [input.prompt] : [`# ${input.name}`, "", input.description ?? ""]
    await writeAtomic(filePath, [...frontmatter, ...body].filter(Boolean).join("\n"))
  })
  notifyConfigUpdated({ scope: "global", file: filePath })
  return { ok: true, filePath }
}

/** Decode a config document (tests + callers that already have the text). */
export const decodeConfig = decode
