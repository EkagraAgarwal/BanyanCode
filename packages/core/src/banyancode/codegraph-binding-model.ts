export * as CodegraphBindingModel from "./codegraph-binding-model"

import path from "path"
import type { CodegraphBinding, CodegraphEdgeDerivation } from "./types"
import { EDGE_CONFIDENCE } from "./types"

// Phase: binding-aware edge model.
//
// This module is the pure, Effect-free core of the derived-edge pass. It turns
// persisted `CodegraphBinding` rows into (a) an index keyed by file and name,
// (b) a module-specifier resolver (relative / workspace-package-exports /
// tsconfig-paths), and (c) a qualified-reference resolver that walks
// import → module → re-export → symbol chains so references like
// `MeshCoordinator.Service` and `Banyan.MeshCoordinator.Service` land on the
// canonical `Service` node instead of relying on name heuristics.
//
// Purity matters: the regression tests unit-test these functions without a DB,
// and the indexer's `rebuildDerivedGraph` uses them against an in-memory graph
// snapshot.

/** Lightweight file handle used by the resolution context. */
export type ResolutionFile = {
  readonly id: string
  readonly path: string
}

/** Lightweight node projection used by the resolution context. */
export type ResolutionNode = {
  readonly id: string
  readonly name: string
  readonly kind: string
}

export type ModuleResolver = (sourceFilePath: string, specifier: string) => readonly ResolutionFile[]

export type ResolutionContext = {
  readonly filesByID: ReadonlyMap<string, ResolutionFile>
  /** fileID -> nodes in that file (used to map an export name to a concrete node). */
  readonly nodesByFile: ReadonlyMap<string, readonly ResolutionNode[]>
  /** fileID -> canonical service node id, derived from codegraph_service_tags. */
  readonly serviceNodeIDByFile: ReadonlyMap<string, string>
  readonly resolveModule: ModuleResolver
}

export type BindingIndex = {
  /** fileID -> localName -> import bindings (`import { A as B }`, `import * as N`, `import D`). */
  readonly imports: ReadonlyMap<string, ReadonlyMap<string, readonly CodegraphBinding[]>>
  /** fileID -> importedName -> export bindings (`export class X`, `export { X } from`, `export * as N from`, `export * from`). */
  readonly exports: ReadonlyMap<string, ReadonlyMap<string, readonly CodegraphBinding[]>>
  /** fileID -> star re-export bindings (`export * from "src"`). */
  readonly starReExports: ReadonlyMap<string, readonly CodegraphBinding[]>
  /** fileID -> set of local names bound by imports (the heuristic pass skips these names). */
  readonly boundNames: ReadonlyMap<string, ReadonlySet<string>>
}

export const buildBindingIndex = (bindings: readonly CodegraphBinding[]): BindingIndex => {
  const imports = new Map<string, Map<string, CodegraphBinding[]>>()
  const exports = new Map<string, Map<string, CodegraphBinding[]>>()
  const starReExports = new Map<string, CodegraphBinding[]>()
  const boundNames = new Map<string, Set<string>>()

  for (const b of bindings) {
    if (b.kind === "import") {
      if (!b.localName) continue
      let byName = imports.get(b.fileID)
      if (!byName) {
        byName = new Map()
        imports.set(b.fileID, byName)
      }
      let list = byName.get(b.localName)
      if (!list) {
        list = []
        byName.set(b.localName, list)
      }
      list.push(b)
      let names = boundNames.get(b.fileID)
      if (!names) {
        names = new Set()
        boundNames.set(b.fileID, names)
      }
      names.add(b.localName)
      continue
    }
    if (b.kind === "star-re-export") {
      let list = starReExports.get(b.fileID)
      if (!list) {
        list = []
        starReExports.set(b.fileID, list)
      }
      list.push(b)
      continue
    }
    // The exports map is keyed by the exported name consumers import:
    // `export class X` / `export { A as B }` / `export * as N` all expose the
    // LOCAL name (`X`, `B`, `N`), not the source-side name (`A`) or the
    // namespace marker `*`.
    const exportName = b.kind === "export" ? b.importedName : b.localName
    if (!exportName) continue
    let byName = exports.get(b.fileID)
    if (!byName) {
      byName = new Map()
      exports.set(b.fileID, byName)
    }
    let list = byName.get(exportName)
    if (!list) {
      list = []
      byName.set(exportName, list)
    }
    list.push(b)
  }

  return {
    imports,
    exports,
    starReExports,
    boundNames,
  }
}

export type QualifiedResolution = {
  readonly nodeID: string
  readonly derivation: "binding-resolved" | "service-tag"
  readonly confidence: number
}

/**
 * Resolve a dotted reference chain in `fileID` to a concrete node. The head
 * segment must be either an import binding local name or a namespace-re-export
 * local name in the referencing file; remaining segments walk export chains
 * across modules (barrel re-exports, `export * as`, star re-exports). When a
 * chain reaches a module whose canonical `Service` node is known via
 * `codegraph_service_tags` and the remaining segments are not exported names
 * (i.e. they are interface methods on the service), the service node is
 * returned with `service-tag` derivation.
 */
export const resolveQualifiedReference = (
  ctx: ResolutionContext,
  index: BindingIndex,
  fileID: string,
  segments: readonly string[],
): QualifiedResolution | undefined => {
  const head = segments[0]
  if (!head) return undefined

  const sourceFile = ctx.filesByID.get(fileID)
  if (!sourceFile) return undefined

  const importList = index.imports.get(fileID)?.get(head)
  if (importList && importList.length > 0) {
    for (const imp of importList) {
      const moduleFiles = ctx.resolveModule(sourceFile.path, imp.source)
      if (moduleFiles.length === 0) continue
      if (imp.importedName === "*") {
        // `import * as NS from "src"` — NS is the module namespace itself.
        for (const m of moduleFiles) {
          const r = resolveExportChain(ctx, index, m, segments.slice(1))
          if (r) return r
        }
      } else {
        // `import { A as B } from "src"` — A is what `src` exports; the
        // remaining chain segments then resolve within that export.
        const exportedName = imp.exportName ?? imp.localName
        if (!exportedName) continue
        for (const m of moduleFiles) {
          const r = resolveExportChain(ctx, index, m, [exportedName, ...segments.slice(1)])
          if (r) return r
        }
      }
    }
  }

  // A namespace-re-export local name in THIS file (e.g. `mesh-coordinator.ts`
  // self-projects `export * as MeshCoordinator from "./mesh-coordinator"` and
  // its own methods reference `MeshCoordinator.<member>`).
  const nsExports = index.exports.get(fileID)?.get(head)
  if (nsExports && nsExports.length > 0) {
    for (const b of nsExports) {
      if (b.kind !== "namespace-re-export") continue
      for (const m of ctx.resolveModule(sourceFile.path, b.source)) {
        const r = resolveExportChain(ctx, index, m, segments.slice(1))
        if (r) return r
      }
    }
  }

  return undefined
}

/**
 * Resolve an export chain within `file`: `names[0]` must be an exported name
 * (declaration, named re-export, namespace re-export, or star re-export) of
 * this module; subsequent names continue through the resolved module.
 * Returns the concrete node (or the canonical service node via the
 * service-tag alias) together with the highest-confidence derivation reached.
 */
const resolveExportChain = (
  ctx: ResolutionContext,
  index: BindingIndex,
  file: ResolutionFile,
  names: readonly string[],
): QualifiedResolution | undefined => {
  const name = names[0]
  if (!name) return undefined

  const exportList = index.exports.get(file.id)?.get(name)
  if (exportList && exportList.length > 0) {
    for (const b of exportList) {
      if (b.kind === "export" && b.localName) {
        const node = findNodeByName(ctx, file.id, b.localName)
        if (node) return bindingResolved(node.id)
      }
      if (b.kind === "namespace-re-export") {
        // `export * as N from "src"` — N is the module namespace of `src`.
        // A trailing chain like `N.leaf` resolves within `src`; a bare `N`
        // resolves to the namespace's canonical service when it has one.
        for (const m of ctx.resolveModule(file.path, b.source)) {
          if (names.length <= 1) {
            const service = ctx.serviceNodeIDByFile.get(m.id)
            if (service) return serviceTagged(service)
            return undefined
          }
          const r = resolveExportChain(ctx, index, m, names.slice(1))
          if (r) return r
        }
      }
      if (b.kind === "re-export" && b.exportName) {
        // `export { A as B } from "src"` — A is what `src` exports.
        for (const m of ctx.resolveModule(file.path, b.source)) {
          const r = resolveExportChain(ctx, index, m, [b.exportName, ...names.slice(1)])
          if (r) return r
        }
      }
    }
  }

  // `export * from "src"` — try the name inside each re-exported module.
  for (const star of index.starReExports.get(file.id) ?? []) {
    for (const m of ctx.resolveModule(file.path, star.source)) {
      const r = resolveExportChain(ctx, index, m, names)
      if (r) return r
    }
  }

  // Direct symbol match: a declaration that the parser did not also record as
  // an export binding (e.g. `export default foo` where `foo` is an identifier).
  const node = findNodeByName(ctx, file.id, name)
  if (node) return bindingResolved(node.id)

  // Service alias: remaining segments are interface members on the canonical
  // `Service` of this module (e.g. `MeshCoordinator.planFor(...)`). The
  // service-tag table is the alias that maps the module to its `Service`.
  const service = ctx.serviceNodeIDByFile.get(file.id)
  if (service) return serviceTagged(service)

  return undefined
}

const bindingResolved = (nodeID: string): QualifiedResolution => ({
  nodeID,
  derivation: "binding-resolved",
  confidence: EDGE_CONFIDENCE["binding-resolved"],
})

const serviceTagged = (nodeID: string): QualifiedResolution => ({
  nodeID,
  derivation: "service-tag",
  confidence: EDGE_CONFIDENCE["service-tag"],
})

const findNodeByName = (ctx: ResolutionContext, fileID: string, name: string): ResolutionNode | undefined =>
  (ctx.nodesByFile.get(fileID) ?? []).find((n) => n.kind !== "file" && n.name === name)

// ---------------------------------------------------------------------------
// Module resolution: relative, workspace-package exports, tsconfig paths.
// ---------------------------------------------------------------------------

export type WorkspacePackageInfo = {
  /** Absolute directory containing the package's package.json. */
  readonly dir: string
  /** exports-map subpath (e.g. `./banyancode`) -> relative target (e.g. `./src/banyancode/index.ts`). */
  readonly exports: ReadonlyMap<string, string>
  /** package.json `main` / `module` fallback target (may be undefined). */
  readonly main: string | undefined
}

export type TsconfigAlias = {
  /** Paths key with the trailing `*` removed (e.g. `@` from `@/*`). */
  readonly prefix: string
  /** Absolute target directories with the trailing `*` removed. */
  readonly targetDirs: readonly string[]
}

const MODULE_CANDIDATE_EXTS = [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs", ".py", ".pyw"]

/** Resolve a filesystem-like specifier (relative/absolute) to candidate files. */
export const resolveRelativeModule = (
  fileByPath: ReadonlyMap<string, ResolutionFile>,
  sourceFilePath: string,
  specifier: string,
): readonly ResolutionFile[] => {
  const sourceDir = path.dirname(sourceFilePath)
  const resolvedBase = path.resolve(sourceDir, specifier).replace(/\\/g, "/")
  return moduleCandidates(fileByPath, resolvedBase)
}

const moduleCandidates = (
  fileByPath: ReadonlyMap<string, ResolutionFile>,
  base: string,
): readonly ResolutionFile[] => {
  const normalized = base.replace(/\\/g, "/")
  const direct = fileByPath.get(normalized)
  if (direct) return [direct]
  const out: ResolutionFile[] = []
  for (const ext of MODULE_CANDIDATE_EXTS) {
    const f = fileByPath.get(normalized + ext)
    if (f) out.push(f)
  }
  if (out.length === 0) {
    for (const idx of ["index.ts", "index.tsx", "index.js", "index.jsx", "index.mts", "index.cts", "index.py"]) {
      const f = fileByPath.get(`${normalized}/${idx}`)
      if (f) out.push(f)
    }
  }
  return out
}

/**
 * Build a module-specifier resolver that tries, in order: relative/absolute
 * paths, tsconfig path aliases (longest prefix first), then workspace package
 * names (longest first, honoring each package's `exports` map when present).
 */
export const createModuleResolver = (input: {
  fileByPath: ReadonlyMap<string, ResolutionFile>
  workspacePackages: ReadonlyMap<string, WorkspacePackageInfo>
  tsconfigAliases: readonly TsconfigAlias[]
}): ModuleResolver => {
  const { fileByPath } = input
  const aliases = [...input.tsconfigAliases].sort((a, b) => b.prefix.length - a.prefix.length)
  const packageNames = [...input.workspacePackages.keys()].sort((a, b) => b.length - a.length)

  return (sourceFilePath: string, specifier: string): readonly ResolutionFile[] => {
    if (!specifier) return []
    if (specifier.startsWith(".") || specifier.startsWith("/")) {
      return resolveRelativeModule(fileByPath, sourceFilePath, specifier)
    }

    for (const alias of aliases) {
      if (specifier === alias.prefix || specifier.startsWith(alias.prefix + "/")) {
        const rest = specifier === alias.prefix ? "" : specifier.slice(alias.prefix.length + 1)
        const out: ResolutionFile[] = []
        for (const dir of alias.targetDirs) {
          out.push(...moduleCandidates(fileByPath, path.join(dir, rest)))
        }
        if (out.length > 0) return out
      }
    }

    for (const name of packageNames) {
      if (specifier === name || specifier.startsWith(name + "/")) {
        const pkg = input.workspacePackages.get(name)!
        const sub = specifier === name ? "" : specifier.slice(name.length + 1)
        const subpath = sub === "" ? "." : `./${sub}`
        const exportTarget = pkg.exports.get(subpath)
        if (exportTarget) {
          const r = moduleCandidates(fileByPath, path.join(pkg.dir, exportTarget))
          if (r.length > 0) return r
        }
        if (sub === "" && pkg.main) {
          const r = moduleCandidates(fileByPath, path.join(pkg.dir, pkg.main))
          if (r.length > 0) return r
        }
        const r = moduleCandidates(fileByPath, path.join(pkg.dir, sub))
        if (r.length > 0) return r
      }
    }

    return []
  }
}

/**
 * Parse every package.json in the graph into a workspace-package map. Pure so
 * the indexer can build it once per rebuild and tests can unit-test it.
 */
export const buildWorkspacePackageMap = (
  packageJsonFiles: readonly { path: string; content: string }[],
): ReadonlyMap<string, WorkspacePackageInfo> => {
  const out = new Map<string, WorkspacePackageInfo>()
  for (const f of packageJsonFiles) {
    let parsed: { name?: unknown; exports?: unknown; main?: unknown; module?: unknown }
    try {
      parsed = JSON.parse(f.content) as { name?: unknown; exports?: unknown; main?: unknown; module?: unknown }
    } catch {
      continue
    }
    if (typeof parsed.name !== "string" || parsed.name === "") continue
    const exports = new Map<string, string>()
    if (parsed.exports && typeof parsed.exports === "object") {
      for (const [subpath, target] of Object.entries(parsed.exports)) {
        if (typeof target === "string") {
          exports.set(subpath, target)
        } else if (target && typeof target === "object") {
          // Conditional exports (`{ "import": "./x.mjs", "require": "./x.cjs" }`)
          // — prefer the first string target deterministically.
          const first = Object.values(target).find((v): v is string => typeof v === "string")
          if (first) exports.set(subpath, first)
        }
      }
    }
    out.set(parsed.name, {
      dir: path.dirname(f.path),
      exports,
      main: typeof parsed.main === "string" ? parsed.main : typeof parsed.module === "string" ? parsed.module : undefined,
    })
  }
  return out
}

const ALIAS_STAR = /^(.+?)\*$/

/**
 * Parse tsconfig `compilerOptions.paths` + `baseUrl` into absolute alias
 * prefixes. Pure so the indexer can build it once per rebuild. `extends` chains
 * are intentionally not followed; the indexer passes every tsconfig it finds
 * and the maps merge.
 */
export const buildTsconfigAliases = (
  tsconfigFiles: readonly { path: string; content: string }[],
): readonly TsconfigAlias[] => {
  const out: TsconfigAlias[] = []
  for (const f of tsconfigFiles) {
    let parsed: { compilerOptions?: { baseUrl?: unknown; paths?: unknown } }
    try {
      parsed = JSON.parse(f.content) as { compilerOptions?: { baseUrl?: unknown; paths?: unknown } }
    } catch {
      continue
    }
    const compilerOptions = parsed.compilerOptions
    if (!compilerOptions) continue
    const paths = compilerOptions.paths
    if (!paths || typeof paths !== "object") continue
    const baseDir = compilerOptions.baseUrl && typeof compilerOptions.baseUrl === "string"
      ? path.resolve(path.dirname(f.path), compilerOptions.baseUrl)
      : path.dirname(f.path)
    for (const [key, targets] of Object.entries(paths)) {
      const star = key.match(ALIAS_STAR)
      // The wildcard capture includes everything before the final `*`, which
      // keeps the trailing `/` (e.g. `@core/*` -> `@core/`); strip it so the
      // resolver can use `<prefix>/<rest>` matching.
      const prefix = (star ? star[1]! : key).replace(/\/+$/g, "")
      const targetDirs: string[] = []
      if (Array.isArray(targets)) {
        for (const t of targets) {
          if (typeof t !== "string") continue
          const tStar = t.match(ALIAS_STAR)
          const resolved = path.resolve(baseDir, tStar ? tStar[1]! : t).replace(/\\/g, "/")
          targetDirs.push(resolved)
        }
      }
      if (targetDirs.length > 0) out.push({ prefix, targetDirs })
    }
  }
  return out
}
