import { describe, expect, test } from "bun:test"
import { join, resolve } from "path"

const REPO_ROOT = resolve("D:/OpenCode")

const IDENTIFIER_RE = /`([a-zA-Z][a-zA-Z0-9]+(?:\.[a-zA-Z][a-zA-Z0-9]+)+)`/g
const CAMEL_CASE_RE = /`([a-z][a-zA-Z0-9]+(?:[A-Z][a-zA-Z0-9]+)+)`/g

const EXCLUDE = new Set(["fs.watch", "Effect.forkDaemon"])

async function findMdFiles(pattern: string): Promise<string[]> {
  const { glob } = await import("glob")
  const files = await glob(pattern, { cwd: REPO_ROOT, absolute: true })
  return [...new Set(files)]
}

function extractIdentifiers(content: string): string[] {
  const ids = new Set<string>()
  for (const re of [IDENTIFIER_RE, CAMEL_CASE_RE]) {
    for (const match of content.matchAll(re)) {
      ids.add(match[1])
    }
  }
  return [...ids]
}

async function grepSource(pattern: string, root: string): Promise<boolean> {
  const { glob } = await import("glob")
  const extensions = [".ts", ".tsx", ".js", ".jsx", ".sql"]
  const skipDirs = `**/node_modules/**|**/dist/**|**/.git/**|**/coverage/**|**/.turbo/**`
  for (const ext of extensions) {
    const files: string[] = glob.sync(`**/*${ext}`, {
      cwd: root,
      absolute: true,
      ignore: [skipDirs],
    })
    for (const file of files) {
      try {
        const content = await Bun.file(file).text()
        if (content.includes(pattern)) return true
      } catch {
        // skip directories
      }
    }
  }
  return false
}

describe("agents-md-staleness", () => {
  test("Permission.ask is a valid exported symbol", async () => {
    const found = await grepSource("Permission.ask", join(REPO_ROOT, "packages/opencode/src"))
    expect(found).toBe(true)
  })

  test("all backtick-quoted identifiers in AGENTS.md resolve in source", async () => {
    const agentsMdPath = join(REPO_ROOT, "packages/opencode/AGENTS.md")
    const content = await Bun.file(agentsMdPath).text()
    const identifiers = extractIdentifiers(content)

    const unresolved: string[] = []
    for (const id of identifiers) {
      if (EXCLUDE.has(id)) continue
      const found = await grepSource(id, REPO_ROOT)
      if (!found) unresolved.push(id)
    }

    expect(unresolved).toEqual([])
  })
})
