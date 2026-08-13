import { test, expect } from "bun:test"
import path from "node:path"

interface FileEntry {
  path: string
  language: string
  symbols: string[]
}

interface EdgeEntry {
  from?: string
  fromSymbol?: string
  to?: string
  toSymbol?: string
  kind: "calls" | "imports"
  note?: string
}

interface Manifest {
  repo: string
  languages: string[]
  files: FileEntry[]
  expectedEdges: EdgeEntry[]
  optionalEdges: EdgeEntry[]
  hardNegatives: { path: string; reason: string }[]
}

const FIXTURE_ROOT = import.meta.dir

const manifest: Manifest = JSON.parse(await Bun.file(path.join(FIXTURE_ROOT, "manifest.json")).text())

function resolve(p: string): string {
  return path.join(FIXTURE_ROOT, ...p.split("/"))
}

function edgeId(e: EdgeEntry): string {
  return [e.from ?? "", e.fromSymbol ?? "", e.to ?? "", e.toSymbol ?? "", e.kind].join("|")
}

function isImportEdge(e: EdgeEntry): boolean {
  return e.kind === "imports"
}

test("manifest header", () => {
  expect(manifest.repo).toBe("edge-eval")
  expect(manifest.languages.length).toBe(9)
  for (const lang of ["typescript", "python", "go", "rust", "java", "c", "cpp", "ruby", "php"]) {
    expect(manifest.languages).toContain(lang)
  }
  expect(manifest.expectedEdges.length).toBeGreaterThan(0)
  expect(manifest.optionalEdges.length).toBeGreaterThan(0)
})

test("every referenced file exists on disk and is listed in files[]", () => {
  const filePaths = new Set(manifest.files.map((f) => f.path))
  expect(filePaths.size).toBe(manifest.files.length) // no duplicate file paths
  for (const f of manifest.files) {
    expect(filePaths.has(f.path)).toBe(true)
    expect(manifest.languages).toContain(f.language)
    expect(Bun.file(resolve(f.path)).size).toBeGreaterThan(0)
  }
  const edgePaths = [...manifest.expectedEdges, ...manifest.optionalEdges].flatMap((e) => [
    ...(e.from ? [e.from] : []),
    ...(e.to ? [e.to] : []),
  ])
  for (const p of edgePaths) {
    expect(filePaths.has(p), `edge endpoint ${p} not listed in files[]`).toBe(true)
    expect(Bun.file(resolve(p)).size, `edge endpoint file missing: ${p}`).toBeGreaterThan(0)
  }
  for (const h of manifest.hardNegatives) {
    expect(filePaths.has(h.path), `hard-negative ${h.path} must not be in files[]`).toBe(false)
    expect(Bun.file(resolve(h.path)).size, `hard-negative file missing: ${h.path}`).toBeGreaterThan(0)
  }
})

test("no duplicate edge ids across expectedEdges + optionalEdges", () => {
  const ids = [...manifest.expectedEdges, ...manifest.optionalEdges].map(edgeId)
  expect(new Set(ids).size).toBe(ids.length)
})

test("every edge kind is calls or imports; imports edges carry no symbols; calls edges carry all four endpoints", () => {
  for (const e of [...manifest.expectedEdges, ...manifest.optionalEdges]) {
    expect(["calls", "imports"]).toContain(e.kind)
    if (isImportEdge(e)) {
      expect(e.from).toBeTruthy()
      expect(e.to).toBeTruthy()
      expect(e.fromSymbol).toBeFalsy()
      expect(e.toSymbol).toBeFalsy()
    } else {
      expect(e.from).toBeTruthy()
      expect(e.to).toBeTruthy()
      expect(e.fromSymbol).toBeTruthy()
      expect(e.toSymbol).toBeTruthy()
    }
  }
})

test("every fromSymbol/toSymbol occurs verbatim in the referenced file source", async () => {
  const cache = new Map<string, string>()
  const source = async (p: string): Promise<string> => {
    if (!cache.has(p)) cache.set(p, await Bun.file(resolve(p)).text())
    return cache.get(p)!
  }
  for (const e of [...manifest.expectedEdges, ...manifest.optionalEdges]) {
    if (e.fromSymbol) {
      expect((await source(e.from!)).includes(e.fromSymbol), `fromSymbol ${e.fromSymbol} not in ${e.from}`).toBe(true)
    }
    if (e.toSymbol) {
      expect((await source(e.to!)).includes(e.toSymbol), `toSymbol ${e.toSymbol} not in ${e.to}`).toBe(true)
    }
  }
})

test("every symbol in files[] occurs verbatim in its file source", async () => {
  for (const f of manifest.files) {
    const src = await Bun.file(resolve(f.path)).text()
    for (const s of f.symbols) {
      expect(src.includes(s), `symbol ${s} not found in ${f.path}`).toBe(true)
    }
  }
})

test("every language has at least one same-file and one cross-file call edge (source-level truth)", () => {
  const perLang = new Map<string, { same: number; cross: number }>()
  for (const e of [...manifest.expectedEdges, ...manifest.optionalEdges]) {
    if (e.kind !== "calls") continue
    const lang = manifest.files.find((f) => f.path === e.from)?.language
    if (!lang) continue
    const entry = perLang.get(lang) ?? { same: 0, cross: 0 }
    if (e.from === e.to) entry.same++
    else entry.cross++
    perLang.set(lang, entry)
  }
  for (const lang of manifest.languages) {
    const entry = perLang.get(lang)
    expect(entry, `language ${lang} has no call edges in the manifest`).toBeTruthy()
    expect(entry!.same, `language ${lang} lacks a same-file call edge`).toBeGreaterThan(0)
    expect(entry!.cross, `language ${lang} lacks a cross-file call edge`).toBeGreaterThan(0)
  }
})
