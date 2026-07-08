import { describe, expect, test } from "bun:test"
import { join, resolve } from "path"
import { glob } from "glob"

const REPO_ROOT = resolve("D:/OpenCode")

const IDENTIFIER_RE = /`([a-zA-Z][a-zA-Z0-9]+(?:\.[a-zA-Z][a-zA-Z0-9]+)+)`/g
const CAMEL_CASE_RE = /`([a-z][a-zA-Z0-9]+(?:[A-Z][a-zA-Z0-9]+)+)`/g

const EXCLUDE = new Set(["fs.watch", "Effect.forkDaemon"])

function extractIdentifiers(content: string): string[] {
  const ids = new Set<string>()
  for (const re of [IDENTIFIER_RE, CAMEL_CASE_RE]) {
    for (const match of content.matchAll(re)) {
      ids.add(match[1])
    }
  }
  return [...ids]
}

let sourceIndexPromise: Promise<string> | undefined
function getSourceIndex(): Promise<string> {
  if (sourceIndexPromise) return sourceIndexPromise
  const extensions = [".ts", ".tsx", ".js", ".jsx", ".sql"]
  const skipDirs = ["**/node_modules/**", "**/dist/**", "**/.git/**", "**/coverage/**", "**/.turbo/**"]
  sourceIndexPromise = (async () => {
    const parts: string[] = []
    for (const ext of extensions) {
      const files = glob.sync(`**/*${ext}`, {
        cwd: REPO_ROOT,
        absolute: true,
        ignore: skipDirs,
      })
      for (const file of files) {
        try {
          parts.push(await Bun.file(file).text())
        } catch {}
      }
    }
    return parts.join("\n")
  })()
  return sourceIndexPromise
}

describe("agents-md-staleness", () => {
  test("Permission.ask is a valid exported symbol", async () => {
    const index = await getSourceIndex()
    expect(index.includes("Permission.ask")).toBe(true)
  })

  test("all backtick-quoted identifiers in AGENTS.md resolve in source", async () => {
    const agentsMdPath = join(REPO_ROOT, "packages/opencode/AGENTS.md")
    const content = await Bun.file(agentsMdPath).text()
    const identifiers = extractIdentifiers(content)
    const index = await getSourceIndex()

    const unresolved = identifiers.filter((id) => !EXCLUDE.has(id) && !index.includes(id))
    expect(unresolved).toEqual([])
  })
})