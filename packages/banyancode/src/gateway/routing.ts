export * as GatewayRouting from "./routing.js"

import { posix } from "path"
import type { Decision, DecideInput, GatewayRouteName, GatewayTarget } from "./types.js"

// Pure, deterministic gateway routing. No filesystem, no graph, no services,
// and deliberately no conversation text: the same (tool, arguments, probe,
// ledger) always produces the same decision.

/** Tools the gateway may rewrite. */
export const GATEWAY_TOOLS: ReadonlySet<string> = new Set(["read", "grep", "glob"])

export const DEFAULT_READ_OUTLINE_LINES = 400

/** Files whose extension identifies code; kept in sync with `isCodePath`. */
const CODE_EXTENSIONS: ReadonlySet<string> = new Set([
  "ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs",
  "py", "rs", "go", "java", "kt", "kts", "scala", "groovy",
  "c", "h", "cc", "cpp", "cxx", "hpp", "cs", "swift",
  "rb", "php", "sh", "bash", "zsh", "zig", "dart", "lua",
  "ex", "exs", "erl", "hrl", "hs", "clj", "cljs", "vue", "svelte",
])

const DOC_EXTENSIONS: ReadonlySet<string> = new Set(["md", "mdx", "rst", "adoc", "txt"])
const CONFIG_EXTENSIONS: ReadonlySet<string> = new Set(["json", "jsonc", "yaml", "yml", "toml", "xml", "ini", "lock", "cfg", "conf", "env"])
const MEDIA_EXTENSIONS: ReadonlySet<string> = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "svg", "pdf", "zip", "gz", "tar", "7z",
  "mp3", "mp4", "mov", "avi", "webm", "wav", "woff", "woff2", "ttf", "otf", "wasm", "exe", "dll", "so", "dylib", "bin", "class", "jar",
])

const DOC_DIRS: ReadonlySet<string> = new Set(["docs", "doc", "specs", "spec"])

/** Search terms that are markers, not symbols. */
const LITERAL_TOKENS: ReadonlySet<string> = new Set(["todo", "fixme", "hack", "xxx", "note", "bug"])

const ERROR_TEXT =
  /(?:typeerror|referenceerror|rangeerror|syntaxerror|urierror|eacces|enoent|epipe|econnrefused)\b|not a function|is not defined|cannot read|undefined is not|uncaught exception|stack trace|error\s*:|warning\s*:/i

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*$/

export const normalizePath = (path: string): string => path.replace(/\\/g, "/")

const extensionOf = (path: string): string => {
  const base = normalizePath(path).slice(normalizePath(path).lastIndexOf("/") + 1)
  const dot = base.lastIndexOf(".")
  return dot <= 0 ? "" : base.slice(dot + 1).toLowerCase()
}

const basenameOf = (path: string): string => {
  const parts = normalizePath(path).split("/")
  return parts[parts.length - 1] ?? path
}

const segments = (path: string): string[] => normalizePath(path).toLowerCase().split("/").filter((part) => part !== "")

export const isCodePath = (path: string): boolean => CODE_EXTENSIONS.has(extensionOf(path))

export const isDocumentationPath = (path: string): boolean => {
  const lower = basenameOf(path).toLowerCase()
  if (DOC_EXTENSIONS.has(extensionOf(path))) return true
  if (/^(readme|contributing|license|changelog|authors|notice)(\.|$)/.test(lower)) return true
  return segments(path).some((segment) => DOC_DIRS.has(segment))
}

export const isEnvPath = (path: string): boolean => basenameOf(path).toLowerCase().startsWith(".env")

export const isConfigPath = (path: string): boolean => {
  if (isEnvPath(path)) return true
  if (CONFIG_EXTENSIONS.has(extensionOf(path))) return true
  const lower = basenameOf(path).toLowerCase()
  return lower === "dockerfile" || lower.endsWith(".dockerfile")
}

export const isMediaPath = (path: string): boolean => MEDIA_EXTENSIONS.has(extensionOf(path))

/**
 * True when the path cannot be under the project root: an absolute path above
 * it, a `~` path, or a relative path that walks out. Relative paths are
 * otherwise assumed to be inside (the tools resolve them against the location).
 */
export const isExternalPath = (path: string, root: string): boolean => {
  const raw = normalizePath(path).trim()
  if (raw === "") return false
  if (raw.startsWith("~")) return true
  const absolute = raw.startsWith("/") || /^[A-Za-z]:\//.test(raw)
  // Collapse `..` first: `src/../../secret.ts` walks out of the project.
  const target = posix.normalize(raw)
  if (!absolute) return target === ".." || target.startsWith("../")
  const base = normalizePath(root).replace(/\/+$/, "").toLowerCase()
  const candidate = target.replace(/\/+$/, "").toLowerCase()
  return !(candidate === base || candidate.startsWith(base === "" ? "" : base + "/"))
}

const stripWordBoundaries = (pattern: string): string =>
  pattern.trim().replace(/^(?:\\b|\^)/, "").replace(/(?:\\b|\$)$/, "")

/**
 * The identifier a grep pattern is looking for, or undefined when the pattern
 * is a regex, prose, or a marker. `\bFoo\b` counts as the identifier `Foo`.
 */
export const isLiteralMarker = (pattern: string): boolean =>
  LITERAL_TOKENS.has(stripWordBoundaries(pattern).toLowerCase())

export const identifierQuery = (pattern: string): string | undefined => {
  const candidate = stripWordBoundaries(pattern)
  if (candidate === "" || candidate.length < 3) return undefined
  if (!IDENTIFIER.test(candidate)) return undefined
  if (LITERAL_TOKENS.has(candidate.toLowerCase())) return undefined
  return candidate
}

/** Path-shaped text in a grep pattern means the model is searching text, not a symbol. */
const looksLikeProseOrRegex = (pattern: string): boolean =>
  /\s/.test(pattern) || /[()[\]{}|*+?^$\\]/.test(stripWordBoundaries(pattern))

const globIsCode = (pattern: string): boolean => {
  const cleaned = normalizePath(pattern).trim().replace(/^\.\//, "")
  if (cleaned === "") return false
  const extension = extensionOf(cleaned)
  if (extension !== "") return CODE_EXTENSIONS.has(extension)
  // No extension: a directory wildcard. Refuse only the docs/config corners,
  // where the graph has nothing to add over the filesystem.
  return !segments(cleaned).some((segment) => DOC_DIRS.has(segment) || segment === ".github")
}

const scopePath = (value: unknown): string | undefined => (typeof value === "string" && value.trim() !== "" ? value : undefined)

const target = (tool: string, input: Record<string, unknown>, op: string): GatewayTarget => ({ tool, input, op })

const direct = (reason: string): Decision => ({ route: "direct", reason })
const fallback = (reason: string): Decision => ({ route: "fallback", reason })
const augment = (reason: string): Decision => ({ route: "augment", reason })
const swap = (reason: string, to: GatewayTarget): Decision => ({ route: "swap", reason, target: to })

/**
 * The decision for one call. `decide` never throws: an unexpected argument
 * shape is "direct", not a failed tool call.
 */
export const decide = (input: DecideInput): Decision => {
  try {
    return decideUnsafe(input)
  } catch {
    return direct("routing-error")
  }
}

const decideUnsafe = (input: DecideInput): Decision => {
  if (!GATEWAY_TOOLS.has(input.tool)) return direct("not-gateway-tool")
  // The escape hatch: an identical call that already swapped runs the real tool.
  if (input.repeat) return direct("repeat")
  if (input.tool === "read") return decideRead(input)
  if (input.tool === "grep") return decideGrep(input)
  return decideGlob(input)
}

const decideRead = (input: DecideInput): Decision => {
  const path = scopePath(input.arguments.path ?? input.arguments.filePath)
  if (path === undefined) return direct("no-path")
  if (isExternalPath(path, input.root)) return direct("outside-project")
  if (isEnvPath(path)) return direct("env-file")
  if (isMediaPath(path)) return direct("binary")
  if (isConfigPath(path)) return direct("config")
  if (isDocumentationPath(path)) return direct("docs")
  if (!isCodePath(path)) return direct("non-code")
  // A ranged read is a page request: the page, plus the symbol header when the
  // file is indexed. It never turns into an outline.
  if (typeof input.arguments.offset === "number" || typeof input.arguments.limit === "number") {
    return augment("ranged-read")
  }
  if (!input.probe.graphBuilt) return fallback("graph-unbuilt")
  if (input.probe.indexed !== true) return fallback("not-indexed")
  if (input.probe.fileStale === true) return fallback("file-stale")
  if ((input.probe.lines ?? 0) <= input.readOutlineLines) return augment("small-file")
  if (!input.allows("repo")) return fallback("tool-unavailable")
  return swap("outline", target("repo", { op: "outline", path }, "outline"))
}

const decideGrep = (input: DecideInput): Decision => {
  const pattern = typeof input.arguments.pattern === "string" ? input.arguments.pattern : undefined
  if (pattern === undefined || pattern.trim() === "") return direct("no-pattern")
  const path = scopePath(input.arguments.path)
  if (path !== undefined && isExternalPath(path, input.root)) return direct("outside-project")
  if (path !== undefined) {
    if (isEnvPath(path)) return direct("env-file")
    if (isMediaPath(path)) return direct("binary")
    if (isDocumentationPath(path)) return direct("docs-scoped")
  }
  const include = scopePath(input.arguments.include)
  if (include !== undefined && !globIsCode(include)) return direct("config-scoped")
  if (input.arguments.caseSensitive === false) return direct("case-insensitive")
  if (ERROR_TEXT.test(pattern)) return direct("error-text")
  if (/\s/.test(pattern)) return direct("whitespace")
  const identifier = identifierQuery(pattern)
  if (identifier === undefined) {
    if (isLiteralMarker(pattern)) return direct("literal-marker")
    if (looksLikeProseOrRegex(pattern)) return direct("regex")
    return direct("short-query")
  }
  if (!input.probe.graphBuilt) return fallback("graph-unbuilt")
  if (input.probe.stale) return fallback("graph-stale")
  if (!input.allows("code_find")) return fallback("tool-unavailable")
  if ((input.probe.symbolHits ?? 0) === 0) return fallback("graph-empty")
  // `usages` covers the definition and every incoming call/reference, so the
  // graph answer replaces both halves of what a text search would be read for.
  const scope = {
    ...(path === undefined ? {} : { path }),
    ...(include === undefined ? {} : { include }),
  }
  return swap("identifier", target("code_find", { intent: "usages", target: identifier, ...scope }, "usages"))
}

const decideGlob = (input: DecideInput): Decision => {
  const pattern = typeof input.arguments.pattern === "string" ? input.arguments.pattern : undefined
  if (pattern === undefined || pattern.trim() === "") return direct("no-pattern")
  const path = scopePath(input.arguments.path)
  if (path !== undefined && isExternalPath(path, input.root)) return direct("outside-project")
  if (path !== undefined) {
    if (isEnvPath(path)) return direct("env-file")
    if (isMediaPath(path)) return direct("binary")
    if (isDocumentationPath(path)) return direct("docs-scoped")
  }
  if (/[.](env|env\.[a-z]+)/i.test(pattern)) return direct("env-file")
  // The graph never indexes hidden files, so it cannot answer this request.
  if (input.arguments.hidden === true) return direct("hidden-files")
  if (!globIsCode(pattern)) return direct("pattern-not-code")
  if (!input.probe.graphBuilt) return fallback("graph-unbuilt")
  if (input.probe.stale) return fallback("graph-stale")
  if (!input.allows("repo")) return fallback("tool-unavailable")
  if ((input.probe.matchCount ?? 0) === 0) return fallback("graph-empty")
  return swap("code-files", target("repo", { op: "files", pattern, ...(path === undefined ? {} : { path }) }, "files"))
}

export const routeName = (decision: Decision): GatewayRouteName => {
  if (decision.route === "swap") return "swapped"
  if (decision.route === "augment") return "augmented"
  if (decision.route === "fallback") return "fallback"
  return "direct"
}
