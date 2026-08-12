/**
 * Deterministic routing features — predicate helpers consumed by rules.ts.
 *
 * Signal vocabulary follows spec §20 of the universal repository intelligence
 * architecture: documentation/config paths, exact-content reads, literal text
 * queries, and relationship language. All predicates are pure string/input
 * functions with no side effects.
 */
import type { RuleInput } from "./types"

// --- Path shape helpers -----------------------------------------------------

const DOC_BASENAMES = new Set(["readme", "contributing", "license", "changelog"])
const DOC_EXTENSIONS = new Set([".md", ".mdx"])
const CONFIG_EXTENSIONS = new Set([".txt", ".yaml", ".yml", ".json", ".toml", ".xml", ".env"])

/** Normalize a path to forward slashes so segment checks work on win32. */
export function normalizePath(path: string): string {
  return path.replace(/\\/g, "/")
}

function extensionOf(base: string): string {
  const dot = base.lastIndexOf(".")
  return dot <= 0 ? "" : base.slice(dot).toLowerCase()
}

function hasSegment(path: string, segment: string): boolean {
  return path.split("/").some((part) => part === segment)
}

function basenameOf(path: string): string {
  const parts = normalizePath(path).split("/")
  return parts[parts.length - 1] ?? path
}

/**
 * Documentation-path signal (spec §20): README / CONTRIBUTING / LICENSE /
 * CHANGELOG basenames, any path under a `docs/` or `specs/` directory, and
 * markdown files.
 */
export function isDocumentationPath(path: string): boolean {
  const base = basenameOf(path)
  const stem = base.replace(/\.(md|mdx|txt)$/i, "").toLowerCase()
  if (DOC_BASENAMES.has(stem)) return true
  if (hasSegment(normalizePath(path), "docs")) return true
  if (hasSegment(normalizePath(path), "specs")) return true
  return DOC_EXTENSIONS.has(extensionOf(base))
}

/**
 * Config-file signal (spec §20): .txt/.yaml/.yml/.json/.toml/.xml/.env
 * extensions, Dockerfile, `.env*` dotfiles, and `.github/` paths.
 */
export function isConfigFile(path: string): boolean {
  const base = basenameOf(path)
  const lower = base.toLowerCase()
  if (CONFIG_EXTENSIONS.has(extensionOf(base))) return true
  if (lower === "dockerfile" || lower.endsWith(".dockerfile")) return true
  if (lower.startsWith(".env")) return true
  if (hasSegment(normalizePath(path), ".github")) return true
  return false
}

/** Combined "routing this path is always safe as a direct operation". */
export function isDirectPathSignal(path: string): boolean {
  return isDocumentationPath(path) || isConfigFile(path)
}

// --- Input field extraction -------------------------------------------------

/**
 * Resolve the path scope for an input: `input.paths` plus arg-derived paths
 * (`path`, `paths`, `directory`). For glob, the `pattern` is itself a path
 * pattern and is included so `glob docs/** /*.md` is detected as docs-scoped.
 * For grep, the `include` glob filter is included so `include: "*.md"` is
 * detected as a docs-scope signal (spec §128/§137).
 */
export function extractPaths(input: RuleInput): string[] {
  const out: string[] = []
  const push = (value: unknown): void => {
    if (typeof value === "string") {
      if (value.trim() !== "") out.push(value)
    } else if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === "string" && item.trim() !== "") out.push(item)
      }
    }
  }
  if (input.paths !== undefined) {
    for (const p of input.paths) push(p)
  }
  push(input.arguments.path)
  push(input.arguments.paths)
  push(input.arguments.directory)
  if (input.toolName === "glob") push(input.arguments.pattern)
  if (input.toolName === "grep") push(input.arguments.include)
  return out
}

/** Resolve the textual query from arguments (`pattern` | `query` | `target`). */
export function extractPattern(input: RuleInput): string | undefined {
  for (const key of ["pattern", "query", "target"] as const) {
    const value = input.arguments[key]
    if (typeof value === "string" && value.trim() !== "") return value
  }
  return undefined
}

// --- Read detection ---------------------------------------------------------

/**
 * Exact-file read request (spec §20): the `read` tool with a file target.
 * Range-paginated reads (offset/limit) are detected separately in rules.ts.
 */
export function isExactFileRead(input: RuleInput): boolean {
  if (input.toolName !== "read") return false
  const target = input.arguments.path ?? input.arguments.filePath
  return typeof target === "string" && target.trim() !== ""
}

// --- Relationship language (spec §20 INTELLIGENCE indicators) ---------------

const RELATIONSHIP_PHRASES = [
  "call sites",
  "call site",
  "called by",
  "calls from",
  "imported by",
  "imports from",
  "implementations of",
  "implementation of",
  "subclasses of",
  "subclass of",
  "affected components",
  "who calls",
  "what calls",
  "used by",
  "depends on",
  "depend on",
] as const

const RELATIONSHIP_TOKENS = new Set([
  "callers",
  "calls",
  "called",
  "references",
  "referenced",
  "reference",
  "usages",
  "usage",
  "dependents",
  "dependencies",
  "dependency",
  "implementations",
  "implementation",
  "implements",
  "implemented",
  "implementing",
  "extends",
  "extended",
  "extending",
  "subclasses",
  "subclass",
  "imports",
  "imported",
  "impact",
  "impacts",
  "impacted",
  "affected",
  "affecting",
  "affects",
  "architecture",
  "architectural",
  "ownership",
  "owner",
  "definition",
  "definitions",
  "define",
  "defined",
  "defining",
  "symbol",
  "symbols",
  "relationship",
  "relationships",
])

const RELATIONSHIP_TOKEN_PATTERN = new RegExp(`\\b(?:${[...RELATIONSHIP_TOKENS].join("|")})\\b`, "i")

/**
 * Relationship language present in the pattern or user request (spec §20
 * INTELLIGENCE indicators: callers, references, dependents, imports,
 * implementations, extends, impact, architecture, ownership, definition,
 * symbol, relationship). Signals, not laws — rules.ts lets a documentation
 * path override this (§121, §128).
 */
export function hasRelationshipLanguage(input: RuleInput): boolean {
  const pattern = extractPattern(input)
  const text = [pattern, input.userRequest].filter((t): t is string => typeof t === "string").join(" ")
  if (text.trim() === "") return false
  const lower = text.toLowerCase()
  if (RELATIONSHIP_PHRASES.some((phrase) => lower.includes(phrase))) return true
  return RELATIONSHIP_TOKEN_PATTERN.test(text)
}

// --- Literal query detection (spec §20 DIRECT indicators) -------------------

const LITERAL_TOKENS = new Set(["todo", "fixme", "hack", "xxx", "note", "bug"])
const LITERAL_TOKEN_PATTERN = new RegExp(`\\b(?:${[...LITERAL_TOKENS].join("|")})\\b`, "i")
const ERROR_SIGNATURE_PATTERN =
  /(?:typeerror|referenceerror|rangeerror|syntaxerror|urierror|eacces|enoent|epipe|econnrefused)\b|not a function|is not defined|cannot read|undefined is not|uncaught exception|stack trace|error\s*:|warning\s*:/i

/**
 * Literal text query (spec §20): grep for TODO/FIXME/HACK-style marker tokens
 * or error-message-looking patterns. Such queries must stay direct even when
 * they mention words that also appear in the relationship vocabulary.
 */
export function isLiteralQuery(input: RuleInput): boolean {
  const pattern = extractPattern(input)
  if (pattern === undefined) return false
  if (LITERAL_TOKEN_PATTERN.test(pattern)) return true
  return ERROR_SIGNATURE_PATTERN.test(pattern)
}

// --- Scope helpers ----------------------------------------------------------

/**
 * Explicit user scope limited to documentation/config paths (spec §137).
 * A non-empty scope where every path is a direct-path signal wins over
 * relationship language (§121, §128) — "grep callers docs/" stays direct.
 */
export function isDocsScoped(input: RuleInput): boolean {
  const paths = extractPaths(input)
  return paths.length > 0 && paths.every(isDirectPathSignal)
}
