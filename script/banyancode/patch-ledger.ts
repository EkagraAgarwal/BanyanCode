#!/usr/bin/env bun
// Patch-ledger check: every upstream-owned file changed since the upstream base must have a row in
// specs/banyancode/v2-patches.md. BanyanCode-owned paths are filtered out first (see the ledger header).
//
// Usage: bun script/banyancode/patch-ledger.ts [--worktree] [--ledger <path>]
//   BASE=<sha>     upstream base commit (default 4878a0e30f, OpenCode v2.2.5)
//   LEDGER=<path>  ledger file (default specs/banyancode/v2-patches.md)
//   --worktree     also count uncommitted and untracked changes
//
// Exit codes: 0 = every changed upstream path is led, 1 = unledgered paths or a malformed ledger.
import { basename } from "node:path"

export const DEFAULT_BASE = "4878a0e30f"
export const DEFAULT_LEDGER = "specs/banyancode/v2-patches.md"

// Must stay in sync with the "BanyanCode-owned paths" section of specs/banyancode/v2-patches.md.
export const OWNED_GLOBS = [
  "packages/banyancode*/**",
  "specs/banyancode/**",
  "script/banyancode/**",
  ".github/workflows/banyancode-*.yml",
  "bun.lock",
] as const

export const CATEGORIES = ["branding", "hook", "fix", "ci"] as const
export type Category = (typeof CATEGORIES)[number]

export type LedgerEntry = {
  path: string
  category: string
  why: string
  pr: string
  line: number
}

export function normalizePath(path: string): string {
  return path.trim().replace(/\\/g, "/").replace(/^\.\//, "")
}

const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/
const escapeRegex = (char: string) => (REGEX_SPECIAL.test(char) ? `\\${char}` : char)

// Glob semantics: `*` and `?` never cross `/`, `**` does, and `**/` also matches zero directories.
export function globToRegExp(pattern: string): RegExp {
  const normalized = normalizePath(pattern).replace(/\/+$/, "")
  let source = ""
  for (let index = 0; index < normalized.length; index++) {
    const char = normalized[index]
    if (char === "*") {
      if (normalized[index + 1] === "*") {
        if (normalized[index + 2] === "/") {
          source += "(?:.*/)?"
          index += 2
        } else {
          source += ".*"
          index += 1
        }
      } else {
        source += "[^/]*"
      }
      continue
    }
    if (char === "?") {
      source += "[^/]"
      continue
    }
    source += escapeRegex(char)
  }
  return new RegExp(`^${source}$`)
}

export function matchesGlob(path: string, pattern: string): boolean {
  return globToRegExp(pattern).test(normalizePath(path))
}

export function isOwnedPath(path: string): boolean {
  return OWNED_GLOBS.some((glob) => matchesGlob(path, glob))
}

const stripCode = (value: string) => value.trim().replace(/^`+/, "").replace(/`+$/, "").trim()
const isSeparator = (cell: string) => /^:?-+:?$/.test(cell.replace(/\s+/g, ""))

const isLedgerHeader = (cells: string[]) =>
  stripCode(cells[0] ?? "").toLowerCase() === "path" && stripCode(cells[1] ?? "").toLowerCase() === "category"

// Parses the ledger table(s): only a markdown table headed `| Path | Category | ... |` is a ledger, so the
// category glossary elsewhere in the document is not mistaken for rows. The first cell is a path or glob.
export function parseLedgerTable(markdown: string): LedgerEntry[] {
  const entries: LedgerEntry[] = []
  let state: "new" | "skipped" | "ledger" = "new"
  markdown.split(/\r?\n/).forEach((line, index) => {
    const trimmed = line.trim()
    if (!trimmed.startsWith("|")) {
      state = "new"
      return
    }
    const cells = trimmed
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((cell) => cell.trim())
    if (cells.length < 2) return
    if (state === "new") {
      state = isLedgerHeader(cells) ? "ledger" : "skipped"
      return
    }
    if (state === "skipped" || cells.every(isSeparator)) return
    const path = stripCode(cells[0])
    if (!path) return
    entries.push({
      path,
      category: stripCode(cells[1] ?? ""),
      why: cells[2] ?? "",
      pr: cells[3] ?? "",
      line: index + 1,
    })
  })
  return entries
}

export function ledgerProblems(entries: LedgerEntry[]): string[] {
  return entries
    .filter((entry) => !CATEGORIES.includes(entry.category as Category))
    .map(
      (entry) =>
        `line ${entry.line}: unknown category "${entry.category}" for ${entry.path} (expected ${CATEGORIES.join(" | ")})`,
    )
}

export function findUnledgered(changed: string[], entries: LedgerEntry[]): string[] {
  const paths = [...new Set(changed.map(normalizePath).filter(Boolean))]
  return paths
    .filter((path) => !isOwnedPath(path))
    .filter((path) => !entries.some((entry) => matchesGlob(path, entry.path)))
    .sort()
}

// `git diff --name-status --no-renames` output: one status and one path per line, tab separated.
export function parseNameStatus(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.includes("\t"))
    .map((line) => line.split("\t").slice(1).join("\t"))
    .map(normalizePath)
    .filter(Boolean)
}

function git(args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "pipe" })
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed (exit ${result.exitCode}): ${result.stderr.toString().trim()}`)
  }
  return result.stdout.toString()
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const worktree = argv.includes("--worktree")
  const ledgerIndex = argv.indexOf("--ledger")
  const ledgerPath = ledgerIndex === -1 ? (process.env.LEDGER ?? DEFAULT_LEDGER) : (argv[ledgerIndex + 1] ?? DEFAULT_LEDGER)
  const base = (process.env.BASE ?? DEFAULT_BASE).trim()

  process.chdir(git(["rev-parse", "--show-toplevel"]).trim())

  const ledgerFile = Bun.file(ledgerPath)
  if (!(await ledgerFile.exists())) {
    console.error(`patch-ledger: ledger not found at ${ledgerPath}`)
    return 1
  }
  const entries = parseLedgerTable(await ledgerFile.text())
  const problems = ledgerProblems(entries)
  if (problems.length > 0) {
    console.error(`patch-ledger: ${ledgerPath} is malformed:`)
    problems.forEach((problem) => console.error(`  - ${problem}`))
    return 1
  }

  const committed = worktree
    ? git(["diff", "--name-status", "--no-renames", git(["merge-base", base, "HEAD"]).trim()])
    : git(["diff", "--name-status", "--no-renames", `${base}...HEAD`])
  const untracked = worktree ? git(["ls-files", "--others", "--exclude-standard"]).split(/\r?\n/) : []
  const changed = [...parseNameStatus(committed), ...untracked.map(normalizePath).filter(Boolean)]
  const unledgered = findUnledgered(changed, entries)
  const owned = changed.filter(isOwnedPath).length
  const led = changed.filter((path) => !isOwnedPath(path)).length - unledgered.length
  const scope = worktree ? `${base}...HEAD + worktree` : `${base}...HEAD`

  if (unledgered.length > 0) {
    console.error(`patch-ledger: ${unledgered.length} upstream path(s) changed without a ledger row (${scope}):`)
    unledgered.forEach((path) => console.error(`  - ${path}`))
    console.error("")
    console.error(`Record each in ${ledgerPath} as | Path | Category | Why | Upstream PR |,`)
    console.error(`or move the change into a BanyanCode-owned path (${OWNED_GLOBS.join(", ")}).`)
    return 1
  }

  console.log(
    `patch-ledger: ok — ${led} led upstream path(s), ${owned} BanyanCode-owned path(s) ignored, ` +
      `${entries.length} ledger row(s), scope ${scope}, ledger ${basename(ledgerPath)}`,
  )
  return 0
}

if (import.meta.main) {
  main()
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      console.error(`patch-ledger: ${error instanceof Error ? error.message : String(error)}`)
      process.exit(1)
    })
}
