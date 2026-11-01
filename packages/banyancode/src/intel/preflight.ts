import { promises as fs } from "node:fs"
import path from "node:path"
import { Effect } from "effect"
import { bfs } from "./bfs.js"
import type { CodegraphPort } from "./codegraph-port.js"
import { isConfigPath, isDocPath } from "./paths.js"
import { ALL_EDGE_KINDS, resolveGraphTarget } from "./resolve.js"
import type { Interface as Intelligence } from "./service.js"
import { countStaleFilesFor, isStale } from "./staleness.js"
import type { GraphFile, GraphNode, PreflightInput, PreflightOutput, Risk } from "./types.js"

/**
 * Decision-ready preflight, ported from v1 `packages/core/src/tool/preflight.ts`.
 *
 * v1 hard-coded the v1 monorepo layout for the filesystem scans
 * (`packages/opencode/src/effect/*-bridge.ts` and
 * `.../httpapi/groups/*.ts`). v2 keeps the same semantic scan but walks
 * `packages/<name>/src` generically, so it works in the v2 tree and in the
 * user's own workspace.
 */

const ROUTE_REGEX =
  /HttpApiEndpoint\.(post|get|put|patch|delete)\(\s*["']([^"']+)["']\s*,\s*["']([^"']+)["']/g

const BRIDGE_PATH = /(^|\/)effect\/[^/]*-bridge\.ts$/i
const GROUPS_PATH = /(^|\/)httpapi\/groups\/[^/]*\.ts$/i

const GENERIC_LEAVES = new Set([
  "Service",
  "Repository",
  "Repo",
  "Manager",
  "Controller",
  "Provider",
  "Helper",
  "Util",
  "Utils",
  "Impl",
  "Interface",
  "Module",
])

const candidateKeys = (target: string): string[] => {
  const parts = target.split(".").filter((part) => part.length > 0)
  if (parts.length === 0) return []
  const keys = [parts.join(".")]
  for (let index = 1; index < parts.length; index++) keys.push(parts.slice(index).join("."))
  return keys
}

const pickStrongKey = (target: string, content: string): string | undefined => {
  for (const key of candidateKeys(target)) {
    if (!content.includes(key)) continue
    if (!key.includes(".") && GENERIC_LEAVES.has(key)) continue
    return key
  }
  return undefined
}

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".banyancode",
  ".opencode",
  "dist",
  "build",
  "out",
  ".next",
  "target",
  "vendor",
  "coverage",
])

const MAX_VISITED = 20_000

// Only descend into directories that can contain an event bridge or an HTTP
// route group. Walking the whole monorepo on every preflight call was the v1
// cost driver; the allowlist keeps the scan to a few hundred entries.
const SCAN_DIRS = new Set([
  "src",
  "lib",
  "app",
  "server",
  "servers",
  "routes",
  "router",
  "route",
  "api",
  "apis",
  "http",
  "httpapi",
  "instance",
  "groups",
  "effect",
  "handlers",
  "handler",
])

const walkPackages = async (repoRoot: string): Promise<string[]> => {
  const out: string[] = []
  let visited = 0
  const packagesRoot = path.join(repoRoot, "packages")
  const stack: Array<{ dir: string; depth: number }> = [{ dir: packagesRoot, depth: 0 }]
  while (stack.length > 0 && visited < MAX_VISITED) {
    const current = stack.pop()!
    let entries
    try {
      entries = await fs.readdir(current.dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      visited++
      if (visited >= MAX_VISITED) break
      const full = path.join(current.dir, entry.name)
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue
        // Depth 0 = `packages/`, depth 1 = the package itself; both are
        // traversed unconditionally, deeper levels must be route/bridge dirs.
        if (current.depth <= 1 || SCAN_DIRS.has(entry.name)) {
          if (current.depth < 10) stack.push({ dir: full, depth: current.depth + 1 })
        }
        continue
      }
      if (!entry.isFile() || !entry.name.endsWith(".ts")) continue
      const normalized = full.replace(/\\/g, "/")
      if (BRIDGE_PATH.test(normalized) || GROUPS_PATH.test(normalized)) out.push(full)
    }
  }
  return out
}

const absolutePath = (repoRoot: string, filePath: string): string =>
  path.isAbsolute(filePath) ? filePath : path.join(repoRoot, filePath)

const scanGraphFilesFromDisk = (
  repoRoot: string,
  graphFiles: readonly GraphFile[],
): Effect.Effect<{
  eventBridges: Array<{ name: string; file: string }>
  httpRoutes: Array<{ method: string; path: string; file: string }>
}> =>
  Effect.gen(function* () {
    const eventBridges: Array<{ name: string; file: string }> = []
    const httpRoutes: Array<{ method: string; path: string; file: string }> = []
    for (const file of graphFiles) {
      const normalized = file.path.replace(/\\/g, "/")
      const isBridge = BRIDGE_PATH.test(normalized)
      const isGroups = GROUPS_PATH.test(normalized)
      if (!isBridge && !isGroups) continue
      // Graph rows may be absolute; report repo-relative paths so the graph
      // scan and the workspace scan produce the same entry for dedupe.
      const display = path.isAbsolute(file.path)
        ? path.relative(repoRoot, file.path).replace(/\\/g, "/")
        : file.path
      const content = yield* Effect.promise(() => fs.readFile(absolutePath(repoRoot, file.path), "utf8")).pipe(
        Effect.orElseSucceed(() => ""),
      )
      if (!content) continue
      if (isBridge) {
        const base = normalized.replace(/-bridge\.ts$/i, "").split("/").pop() ?? normalized
        if (!eventBridges.some((entry) => entry.file === display)) eventBridges.push({ name: base, file: display })
      }
      if (isGroups) {
        ROUTE_REGEX.lastIndex = 0
        let match: RegExpExecArray | null
        while ((match = ROUTE_REGEX.exec(content)) !== null) {
          const route = { method: match[1]!.toUpperCase(), path: match[3]!, file: display }
          if (
            !httpRoutes.some(
              (entry) => entry.file === route.file && entry.method === route.method && entry.path === route.path,
            )
          ) {
            httpRoutes.push(route)
          }
        }
      }
    }
    return { eventBridges, httpRoutes }
  })

const scanWorkspace = (
  repoRoot: string,
  target: string,
): Effect.Effect<{
  eventBridges: Array<{ name: string; file: string }>
  httpRoutes: Array<{ method: string; path: string; file: string }>
}> =>
  Effect.gen(function* () {
    const eventBridges: Array<{ name: string; file: string }> = []
    const httpRoutes: Array<{ method: string; path: string; file: string }> = []
    const files = yield* Effect.promise(() => walkPackages(repoRoot)).pipe(Effect.orElseSucceed(() => [] as string[]))
    for (const full of files) {
      const content = yield* Effect.promise(() => fs.readFile(full, "utf8")).pipe(Effect.orElseSucceed(() => ""))
      if (!content) continue
      const relative = path.relative(repoRoot, full).replace(/\\/g, "/")
      const normalized = full.replace(/\\/g, "/")
      if (BRIDGE_PATH.test(normalized)) {
        if (!pickStrongKey(target, content)) continue
        eventBridges.push({
          name: path.basename(relative).replace(/-bridge\.ts$/, ""),
          file: relative,
        })
        continue
      }
      if (!GROUPS_PATH.test(normalized)) continue
      if (!pickStrongKey(target, content)) continue
      ROUTE_REGEX.lastIndex = 0
      let match: RegExpExecArray | null
      while ((match = ROUTE_REGEX.exec(content)) !== null) {
        httpRoutes.push({ method: match[1]!.toUpperCase(), path: match[3]!, file: relative })
      }
    }
    return { eventBridges, httpRoutes }
  })

export interface PreflightDeps {
  readonly port: CodegraphPort
  readonly intel: Intelligence
}

export const computePreflight = (
  deps: PreflightDeps,
  input: PreflightInput,
): Effect.Effect<PreflightOutput> =>
  Effect.gen(function* () {
    const repoRoot = input.root ?? process.cwd()
    const generatedAt = Date.now()

    const resolution = yield* resolveGraphTarget(deps.port, { target: input.target })
    const candidates = resolution._tag === "Ok" ? resolution.value.candidates.slice(0, 10) : []
    const primary = candidates[0]
    const resolved = primary !== undefined

    const directCallers: GraphNode[] = []
    const transitiveCallers: GraphNode[] = []
    if (primary) {
      const depth = Math.max(1, Math.min(64, input.depth ?? 8))
      const run = yield* bfs(deps.port, {
        start: [primary.id],
        direction: "incoming",
        edgeKinds: ALL_EDGE_KINDS,
        maxDepth: depth,
        resultLimit: 500,
      })
      for (const result of run.results) {
        if (result.depth === 1) directCallers.push(result.node)
        else transitiveCallers.push(result.node)
      }
    }

    const allFiles = yield* deps.port.listFiles()
    const fileByID = new Map(allFiles.map((file) => [file.id, file]))
    const meta = yield* deps.port.meta()

    const fileIDs = new Set<string>()
    for (const node of [...directCallers, ...transitiveCallers]) fileIDs.add(node.fileID)
    if (primary && deps.port.dependentFiles) {
      for (const id of yield* deps.port.dependentFiles({ fileIDs: [primary.fileID], limit: 100 })) fileIDs.add(id)
    }

    const testsList = primary ? yield* deps.intel.tests({ symbol: primary.name }) : { tests: [], notFound: false, derivation: "none" as const }
    const testsFileByID = new Map<string, GraphFile>()
    for (const test of testsList.tests) {
      const file = fileByID.get(test.fileID)
      if (file) testsFileByID.set(file.id, file)
    }

    const testsToRun = [...testsFileByID.values()]
    const docsAffected: GraphFile[] = []
    const configsAffected: GraphFile[] = []
    for (const id of fileIDs) {
      const file = fileByID.get(id)
      if (!file) continue
      if (isDocPath(file.path)) docsAffected.push(file)
      else if (isConfigPath(file.path)) configsAffected.push(file)
    }

    const fromDisk = yield* scanWorkspace(repoRoot, input.target)
    const eventBridges = [...fromDisk.eventBridges]
    const httpRoutes = [...fromDisk.httpRoutes]

    if (primary) {
      const graphFiles = allFiles.filter((file) => fileIDs.has(file.id))
      const fromGraph = yield* scanGraphFilesFromDisk(repoRoot, graphFiles)
      for (const bridge of fromGraph.eventBridges) {
        if (!eventBridges.some((entry) => entry.file === bridge.file)) eventBridges.push(bridge)
      }
      for (const route of fromGraph.httpRoutes) {
        if (
          !httpRoutes.some(
            (entry) => entry.file === route.file && entry.method === route.method && entry.path === route.path,
          )
        ) {
          httpRoutes.push(route)
        }
      }
    }

    const risks: Risk[] = []
    if (!resolved) {
      risks.push({
        kind: "no-target",
        severity: "high",
        message: `target "${input.target}" not found in the code graph; verify spelling or run codegraph_build`,
      })
    } else if (directCallers.length === 0) {
      risks.push({
        kind: "many-callers",
        severity: "low",
        message: "no callers found; this symbol appears unused outside its own file",
      })
    } else if (directCallers.length > 8) {
      risks.push({
        kind: "many-callers",
        severity: directCallers.length > 20 ? "high" : "medium",
        message: `${directCallers.length} direct callers found; expect a wide blast radius`,
      })
    }
    if (testsToRun.length === 0 && directCallers.length > 0) {
      risks.push({
        kind: "no-tests",
        severity: "medium",
        message: "no tests reference this symbol directly; verify behavior with manual checks",
      })
    }
    if (eventBridges.length > 0) {
      risks.push({
        kind: "touches-event-bus",
        severity: "medium",
        message: `${eventBridges.length} event bridge${eventBridges.length === 1 ? "" : "s"} reference this symbol; ensure event semantics are preserved`,
      })
    }
    if (httpRoutes.length > 0) {
      risks.push({
        kind: "touches-http-routes",
        severity: "medium",
        message: `${httpRoutes.length} HTTP route${httpRoutes.length === 1 ? "" : "s"} defined in files referencing this symbol; API contract may shift`,
      })
    }
    const stale = isStale(meta ? { graphBuiltAt: meta.graphBuiltAt, graphCoverage: meta.graphCoverage } : undefined)
    if (stale.stale && stale.reason) {
      risks.push({
        kind: "stale-graph",
        severity: stale.severity === "med" ? "medium" : "high",
        message: stale.reason,
      })
    }
    const perFileStale = yield* countStaleFilesFor(deps.port, [...fileIDs])
    if (perFileStale.stale && !stale.stale) {
      risks.push({
        kind: "stale-graph",
        severity: "high",
        message: `${perFileStale.staleFiles} file(s) changed since index; run /codegraph-build`,
      })
    }

    const filePaths: Record<string, string> = {}
    for (const node of [primary, ...candidates, ...directCallers, ...transitiveCallers]) {
      if (!node) continue
      const file = fileByID.get(node.fileID)
      if (file) filePaths[node.fileID] = file.path
    }

    return {
      target: {
        resolved,
        ...(primary ? { node: primary } : {}),
        candidates,
      },
      directCallers,
      transitiveCallers,
      testsToRun,
      docsAffected,
      configsAffected,
      eventBridgesAffected: eventBridges,
      httpRoutesAffected: httpRoutes,
      risks,
      risk: !resolved
        ? "unknown"
        : risks.some((risk) => risk.severity === "high")
          ? "high"
          : risks.some((risk) => risk.severity === "medium")
            ? "medium"
            : "low",
      filePaths,
      derivation: "regex-v1",
      ...(meta
        ? {
            meta: {
              graphBuiltAt: meta.graphBuiltAt,
              graphVersion: meta.graphVersion,
              graphCoverage: meta.graphCoverage,
              totalFiles: meta.totalFiles,
              totalNodes: meta.totalNodes,
              totalEdges: meta.totalEdges,
            },
          }
        : {}),
      ...(perFileStale.staleFiles > 0 ? { staleFiles: perFileStale.staleFiles } : {}),
      generatedAt,
    }
  })
