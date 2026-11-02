// `banyancode mcp install <client>` — write the client config (and, for
// Claude Code, the delegate skill) after the caller has seen the exact change.
//
// Every plan is a list of file contents, so `main` can print exactly what will
// be written before touching the disk. Existing config content is preserved:
// JSON files are merged key-by-key, the Codex TOML block is replaced in place.
//
// Scope: Claude Code and Cursor get a project-scoped config inside `--cwd`
// (`.mcp.json`, `.cursor/mcp.json`) plus a project skill for Claude Code.
// Codex only reads a global TOML file, so it lands in `$CODEX_HOME` (default
// `~/.codex/config.toml`).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { SKILL_MD, SKILL_NAME } from "./skill"

export const InstallClients = ["claude-code", "codex", "cursor"] as const
export type InstallClient = (typeof InstallClients)[number]

export const isInstallClient = (value: string): value is InstallClient =>
  (InstallClients as ReadonlyArray<string>).includes(value)

export const SERVER_KEY = "banyancode"

export type InstallFile = {
  /** Absolute path written by `applyInstall`. */
  path: string
  kind: "json" | "toml" | "markdown"
  /** Exact file content after installation. */
  content: string
  /** True when the file already existed and its content changes. */
  changes: boolean
}

export type InstallPlan = {
  client: InstallClient
  /** Command the client is configured to launch. */
  command: string[]
  files: InstallFile[]
}

export type InstallInput = {
  client: InstallClient
  cwd: string
  /** The command prefix that re-invokes this binary (`selfCommand()`). */
  selfCommand: string[]
  /** Written into the server entry. yolo is left out: it should never come from a config file alone. */
  permission?: "edits"
  env?: NodeJS.ProcessEnv
  /** Overrides the home directory (tests); defaults to $HOME / os.homedir(). */
  home?: string
}

const stdioEntry = (selfCommand: string[], cwd: string, permission?: "edits") => ({
  type: "stdio" as const,
  command: selfCommand[0] ?? "banyancode",
  args: [...selfCommand.slice(1), "mcp", "serve", "--cwd", cwd, ...(permission ? ["--permission", permission] : [])],
})

const readIfExists = (target: string): string | undefined => {
  try {
    return readFileSync(target, "utf8")
  } catch {
    return undefined
  }
}

const parseJsonObject = (text: string | undefined): Record<string, unknown> => {
  if (text === undefined || text.trim() === "") return {}
  try {
    const parsed = JSON.parse(text) as unknown
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

// Deep-ish merge: only `mcpServers.<name>` is replaced; every other server and
// top-level key survives.
export const mergeMcpJson = (existing: string | undefined, name: string, entry: unknown): string => {
  const root = parseJsonObject(existing)
  const servers =
    root["mcpServers"] !== null && typeof root["mcpServers"] === "object" && !Array.isArray(root["mcpServers"])
      ? (root["mcpServers"] as Record<string, unknown>)
      : {}
  return `${JSON.stringify({ ...root, mcpServers: { ...servers, [name]: entry } }, null, 2)}\n`
}

const tomlString = (value: string): string => JSON.stringify(value)

export const tomlBlock = (name: string, entry: { command: string; args: string[] }): string =>
  [
    `[mcp_servers.${name}]`,
    `command = ${tomlString(entry.command)}`,
    `args = [${entry.args.map(tomlString).join(", ")}]`,
    "",
  ].join("\n")

// Replace `[mcp_servers.<name>]` up to the next table header, or append it.
export const upsertTomlBlock = (existing: string | undefined, name: string, block: string): string => {
  const header = `[mcp_servers.${name}]`
  const text = existing ?? ""
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex((line) => line.trim() === header)
  if (start === -1) {
    const base = text.replace(/\s+$/, "")
    return `${base === "" ? "" : `${base}\n\n`}${block}`
  }
  let end = lines.length
  for (let index = start + 1; index < lines.length; index += 1) {
    if (lines[index]?.trim().startsWith("[")) {
      end = index
      break
    }
  }
  const next = [...lines.slice(0, start), ...block.split("\n"), ...lines.slice(end)].join("\n")
  return next.replace(/\n{3,}/g, "\n\n").replace(/\s+$/, "") + "\n"
}

export const planInstall = (input: InstallInput): InstallPlan => {
  const home =
    input.home ??
    input.env?.["HOME"] ??
    input.env?.["USERPROFILE"] ??
    process.env["HOME"] ??
    process.env["USERPROFILE"] ??
    ""
  const entry = stdioEntry(input.selfCommand, input.cwd, input.permission)
  const command = [entry.command, ...entry.args]
  const files: InstallFile[] = []

  if (input.client === "claude-code" || input.client === "cursor") {
    const target =
      input.client === "claude-code"
        ? path.join(input.cwd, ".mcp.json")
        : path.join(input.cwd, ".cursor", "mcp.json")
    const existing = readIfExists(target)
    const content = mergeMcpJson(existing, SERVER_KEY, entry)
    files.push({ path: target, kind: "json", content, changes: existing !== content })
  }

  if (input.client === "claude-code") {
    const target = path.join(input.cwd, ".claude", "skills", SKILL_NAME, "SKILL.md")
    const existing = readIfExists(target)
    files.push({ path: target, kind: "markdown", content: SKILL_MD, changes: existing !== SKILL_MD })
  }

  if (input.client === "codex") {
    const codexHome = input.env?.["CODEX_HOME"] ?? (home === "" ? "" : path.join(home, ".codex"))
    if (codexHome === "") {
      throw new Error("cannot locate the Codex config: set CODEX_HOME or HOME/USERPROFILE")
    }
    const target = path.join(codexHome, "config.toml")
    const existing = readIfExists(target)
    const content = upsertTomlBlock(existing, SERVER_KEY, tomlBlock(SERVER_KEY, entry))
    files.push({ path: target, kind: "toml", content, changes: existing !== content })
  }

  return { client: input.client, command, files }
}

export const applyInstall = (plan: InstallPlan): string[] => {
  const written: string[] = []
  for (const file of plan.files) {
    mkdirSync(path.dirname(file.path), { recursive: true })
    writeFileSync(file.path, file.content)
    written.push(file.path)
  }
  return written
}

// What the operator sees before the write. The JSON embed is the exact server
// entry; the TOML embed is the exact block. Never a paraphrase.
export const describePlan = (plan: InstallPlan): string => {
  const lines: string[] = []
  for (const file of plan.files) {
    const state = existsSync(file.path) ? (file.changes ? "update" : "unchanged") : "create"
    lines.push(`${state} ${file.path}`)
    if (file.kind === "toml") {
      // Slice out just the server block so the print is the exact change even
      // when other tables follow it in the file.
      const header = `[mcp_servers.${SERVER_KEY}]`
      const start = file.content.indexOf(header)
      const rest = start === -1 ? "" : file.content.slice(start + header.length)
      const end = rest.search(/\r?\n\[/)
      const block = start === -1 ? file.content.trimEnd() : `${header}${end === -1 ? rest : rest.slice(0, end)}`
      lines.push(block.split(/\r?\n/).map((line) => `  ${line}`).join("\n"))
      continue
    }
    if (file.kind === "json") {
      const entry = (parseJsonObject(file.content)["mcpServers"] as Record<string, unknown> | undefined)?.[SERVER_KEY]
      lines.push(JSON.stringify({ mcpServers: { [SERVER_KEY]: entry } }, null, 2).replace(/^/gm, "  "))
      continue
    }
    lines.push(`  ${SKILL_NAME}/SKILL.md (${file.content.length} bytes)`)
  }
  return lines.join("\n")
}

export * as McpInstall from "./install"
