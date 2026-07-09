export * as PreflightTool from "./preflight"

import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer, Schema } from "effect"
import { existsSync } from "node:fs"
import * as fs from "node:fs/promises"
import path from "node:path"
import type { Interface as CodegraphRepoInterface } from "../banyancode/codegraph-repo"
import type { Interface as CodegraphAnalyzerInterface } from "../banyancode/codegraph-analyzer"
import type { Interface as RepositoryIntelligenceInterface } from "../banyancode/repository-intelligence/service"
import type { Interface as PermissionV2Interface } from "../permission"
import { Banyan, isStale } from "../banyancode"
import { resolveGraphTargetPure } from "../banyancode/symbol-resolver"
import { traced } from "../observability/trace"
import { CodegraphNodeSchema } from "../banyancode/types"
import { PermissionV2 } from "../permission"
import { Tool } from "./tool"
import { Tools } from "./tools"
import { defaultLayer as repositoryIntelligenceLayer } from "../banyancode/repository-intelligence"
import { defaultLayer as codegraphAnalyzerLayer } from "../banyancode/codegraph-analyzer"
import { optionalNumber, optionalString } from "./tool-schema"

const banyancodeEnabled = () => process.env.BANYANCODE_ENABLE !== "0"

export const name = "preflight"

const CodegraphFileSchema = Schema.Struct({
  id: Schema.String,
  path: Schema.String,
  contentHash: Schema.String,
  language: Schema.String,
  indexedAt: Schema.Number,
})

const ActionLiterals = Schema.Literals(["rename", "modify", "delete"])
const RiskKindLiterals = Schema.Literals([
  "no-target",
  "many-callers",
  "no-tests",
  "touches-event-bus",
  "touches-http-routes",
  "stale-graph",
])
const RiskSeverityLiterals = Schema.Literals(["low", "medium", "high"])
const DerivationLiterals = Schema.Literals(["regex-v1", "tree-sitter-v1", "runtime-v1"])

const RiskSchema = Schema.Struct({
  kind: RiskKindLiterals,
  severity: RiskSeverityLiterals,
  message: Schema.String,
})

export const Input = Schema.Struct({
  action: ActionLiterals.annotate({
    description:
      "What kind of edit is being planned: 'rename' for symbol rename, " +
      "'modify' for an in-place change, 'delete' for removal. Drives the " +
      "candidate selection and which risk kinds fire.",
  }),
  target: Schema.String.annotate({
    description:
      "REQUIRED. The symbol name (e.g. 'MemoryRepo.update') or node ID " +
      "(UUID:line-line) the edit is targeting. If the symbol is not in the " +
      "code graph, the tool returns a 'no-target' risk with guidance.",
  }),
  depth: optionalNumber.annotate({
    description:
      "Maximum traversal depth for blast radius. Defaults to 64 (capped) when " +
      "omitted. Pass 3-5 for shallow previews.",
  }),
  root: optionalString.annotate({
    description:
      "Workspace root for filesystem scans (event bridges, HTTP routes). " +
      "Defaults to the current working directory when omitted.",
  }),
}).annotate({
  description:
    "Decision report for an upcoming edit: full candidate list, blast radius, " +
    "touched event bridges, HTTP routes, configs, and structured risk tags. " +
    "Use before any non-trivial rename or delete.",
})

export const Output = Schema.Struct({
  target: Schema.Struct({
    resolved: Schema.Boolean,
    node: Schema.optional(CodegraphNodeSchema),
    candidates: Schema.Array(CodegraphNodeSchema),
  }),
  directCallers: Schema.Array(CodegraphNodeSchema),
  transitiveCallers: Schema.Array(CodegraphNodeSchema),
  testsToRun: Schema.Array(CodegraphFileSchema),
  docsAffected: Schema.Array(CodegraphFileSchema),
  configsAffected: Schema.Array(CodegraphFileSchema),
  eventBridgesAffected: Schema.Array(Schema.Struct({ name: Schema.String, file: Schema.String })),
  httpRoutesAffected: Schema.Array(Schema.Struct({ method: Schema.String, path: Schema.String, file: Schema.String })),
  risks: Schema.Array(RiskSchema),
  derivation: DerivationLiterals,
  generatedAt: Schema.Number,
})

const TEST_PATH_PATTERNS = [/\.test\.[^.]+$/, /\.spec\.[^.]+$/, /(^|\/)__tests__\//, /(^|\/)tests?\//]
const DOC_PATH_PATTERNS = [/\.md$/i, /^readme/i, /\/docs?\//i, /^design/i, /^contributing/i, /^changelog/i]
const CONFIG_PATH_PATTERNS = [
  /package\.json$/i,
  /tsconfig.*\.json$/i,
  /pnpm-workspace\.yaml$/i,
  /bun\.fig\.toml$/i,
]

function isTestPath(p: string): boolean {
  return TEST_PATH_PATTERNS.some((re) => re.test(p))
}
function isDocPath(p: string): boolean {
  return DOC_PATH_PATTERNS.some((re) => re.test(p))
}
function isConfigPath(p: string): boolean {
  return CONFIG_PATH_PATTERNS.some((re) => re.test(p))
}

function findRepoRoot(startDir: string): string | undefined {
  let dir = path.resolve(startDir)
  const { root: fsRoot } = path.parse(dir)
  let current: string | undefined = dir
  while (current !== undefined && current !== fsRoot) {
    if (existsSync(path.join(current, ".git"))) return current
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  current = dir
  while (current !== undefined && current !== fsRoot) {
    if (existsSync(path.join(current, "package.json"))) return current
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  return undefined
}

async function readDirSafe(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir)
  } catch {
    return []
  }
}

const ROUTE_REGEX =
  /HttpApiEndpoint\.(post|get|put|patch|delete)\(\s*["']([^"']+)["']\s*,\s*["']([^"']+)["']/g

/**
 * Build an ordered list of search keys for a target, most specific first.
 * Previously the scanner took only the bare leaf (e.g. `Service` after
 * stripping `.Service` from `Foo.Bar.Service`), which produced false-positive
 * hits whenever the leaf was a common suffix like "Service" or "Repository".
 *
 *   input: A.B.Service     →  ["A.B.Service", "A.B", "B.Service", "B"]
 *   input: MyClass          →  ["MyClass"]
 *   input: a.b.c            →  ["a.b.c", "a.b", "b.c", "c"]
 */
function candidateKeys(target: string): string[] {
  const parts = target.split(".").filter((p) => p.length > 0)
  if (parts.length === 0) return []
  const keys: string[] = []
  // full target
  keys.push(parts.join("."))
  // each successively shorter prefix (drops the leftmost segment)
  for (let i = 1; i < parts.length; i++) {
    keys.push(parts.slice(i).join("."))
  }
  // bare leaf as last resort only
  return keys
}

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

function pickStrongKey(target: string, content: string): string | undefined {
  for (const key of candidateKeys(target)) {
    if (content.includes(key)) {
      // If the only key that hit is a generic single-word leaf, treat it as
      // a false positive — the user almost certainly meant the more specific
      // qualified form.
      if (!key.includes(".") && GENERIC_LEAVES.has(key)) continue
      return key
    }
  }
  return undefined
}

async function scanHttpRoutes(
  repoRoot: string,
  target: string,
): Promise<Array<{ method: string; path: string; file: string }>> {
  const groupsDir = path.join(repoRoot, "packages", "opencode", "src", "server", "routes", "instance", "httpapi", "groups")
  const entries = await readDirSafe(groupsDir)
  const out: Array<{ method: string; path: string; file: string }> = []
  for (const entry of entries) {
    if (!entry.endsWith(".ts")) continue
    const full = path.join(groupsDir, entry)
    let content: string
    try {
      content = await fs.readFile(full, "utf8")
    } catch {
      continue
    }
    if (!pickStrongKey(target, content)) continue
    ROUTE_REGEX.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = ROUTE_REGEX.exec(content)) !== null) {
      out.push({ method: match[1].toUpperCase(), path: match[3], file: path.relative(repoRoot, full) })
    }
  }
  return out
}

async function scanEventBridges(
  repoRoot: string,
  target: string,
): Promise<Array<{ name: string; file: string }>> {
  const bridgesDir = path.join(repoRoot, "packages", "opencode", "src", "effect")
  const entries = await readDirSafe(bridgesDir)
  const out: Array<{ name: string; file: string }> = []
  for (const entry of entries) {
    if (!entry.endsWith("-bridge.ts")) continue
    const full = path.join(bridgesDir, entry)
    let content: string
    try {
      content = await fs.readFile(full, "utf8")
    } catch {
      continue
    }
    if (!pickStrongKey(target, content)) continue
    out.push({ name: entry.replace(/-bridge\.ts$/, ""), file: path.relative(repoRoot, full) })
  }
  return out
}

export const computePreflight = (
  deps: {
    readonly repo: CodegraphRepoInterface
    readonly analyzer: CodegraphAnalyzerInterface
    readonly intel: RepositoryIntelligenceInterface
  },
  input: typeof Input.Type,
): Effect.Effect<typeof Output.Type, never, never> =>
  Effect.gen(function* () {
    const repoRoot = input.root ?? findRepoRoot(process.cwd()) ?? process.cwd()
    const now = Date.now()

    const resolution = yield* resolveGraphTargetPure(deps.repo, { target: input.target })
    const candidates = resolution._tag === "Ok" ? resolution.value.candidates.slice(0, 10) : []
    const primary = candidates[0]
    const resolved = primary !== undefined

    const directCallers: Banyan.CodegraphNode[] = []
    const transitiveCallers: Banyan.CodegraphNode[] = []
    if (primary) {
      const impact = yield* deps.analyzer
        .impact({ nodeID: primary.id, function: primary.name })
        .pipe(
          Effect.catchTag("Banyan/SymbolNotFoundError", () =>
            Effect.succeed({ dependents: [] as Array<Banyan.CodegraphNode>, transitive: [] as Array<Banyan.CodegraphNode> }),
          ),
        )
      directCallers.push(...impact.dependents)
      transitiveCallers.push(...impact.transitive)
    }

    const fileIDs = new Set<string>()
    for (const n of [...directCallers, ...transitiveCallers]) fileIDs.add(n.fileID)

    const allFiles = yield* deps.repo.listAllFiles()
    const metaRow = yield* deps.repo.getMeta()
    const meta = metaRow
      ? { graphBuiltAt: metaRow.graphBuiltAt, graphCoverage: metaRow.graphCoverage }
      : undefined
    const filePathByID = new Map(allFiles.map((f) => [f.id, f.path]))

    const testsList: { tests: ReadonlyArray<Banyan.CodegraphNode>; notFound: boolean } = primary
      ? yield* deps.intel.tests({ symbol: primary.name })
      : { tests: [], notFound: false }
    const testsFileByID = new Map<string, Banyan.CodegraphFile>()
    for (const t of testsList.tests) {
      const file = allFiles.find((f) => f.id === t.fileID)
      if (file) testsFileByID.set(file.id, file)
    }

    const testsToRun: Banyan.CodegraphFile[] = Array.from(testsFileByID.values())
    const docsAffected: Banyan.CodegraphFile[] = []
    const configsAffected: Banyan.CodegraphFile[] = []
    for (const id of fileIDs) {
      const f = filePathByID.get(id)
      if (!f) continue
      const fileRecord = allFiles.find((x) => x.id === id)
      if (!fileRecord) continue
      if (isDocPath(f)) docsAffected.push(fileRecord)
      else if (isConfigPath(f)) configsAffected.push(fileRecord)
    }

    const eventBridges = yield* Effect.tryPromise({
      try: () => scanEventBridges(repoRoot, input.target),
      catch: () => new Error("scanEventBridges failed"),
    }).pipe(Effect.orElseSucceed(() => [] as Array<{ name: string; file: string }>))
    const httpRoutes = yield* Effect.tryPromise({
      try: () => scanHttpRoutes(repoRoot, input.target),
      catch: () => new Error("scanHttpRoutes failed"),
    }).pipe(Effect.orElseSucceed(() => [] as Array<{ method: string; path: string; file: string }>))

    const risks: Array<typeof RiskSchema.Type> = []
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
    const stale = isStale(meta)
    if (stale.stale && stale.reason) {
      risks.push({
        kind: "stale-graph",
        severity: stale.severity === "med" ? "medium" : "high",
        message: stale.reason,
      })
    }

    return {
      target: { resolved, node: primary, candidates },
      directCallers,
      transitiveCallers,
      testsToRun,
      docsAffected,
      configsAffected,
      eventBridgesAffected: eventBridges,
      httpRoutesAffected: httpRoutes,
      risks,
      derivation: "regex-v1" as const,
      generatedAt: now,
    }
  })

export const makePreflightTool = (deps: {
  readonly permission: PermissionV2Interface
  readonly repo: CodegraphRepoInterface
  readonly analyzer: CodegraphAnalyzerInterface
  readonly intel: RepositoryIntelligenceInterface
}) =>
  Tool.make({
    description:
      "Use when:\n" +
      "  the agent needs a single-call, decision-ready preflight report before editing a symbol —\n" +
      "  direct + transitive callers, tests, docs, configs, event bridges, HTTP routes,\n" +
      "  and risk verdicts.\n" +
      "Examples\n" +
      '  - "Preflight renaming MemoryRepo.put"\n' +
      '  - "Preflight modifying CodegraphBuildService.start"\n' +
      "Returns\n" +
      "  { target, directCallers, transitiveCallers, testsToRun, docsAffected,\n" +
      "    configsAffected, eventBridgesAffected, httpRoutesAffected, risks,\n" +
      "    derivation, generatedAt }\n" +
      "Avoid when\n" +
      "  only count is needed — use blast_radius instead.\n" +
      "After this, often: safe_rename (if action=rename), edit_plan.\n" +
      "Before this: codegraph_build (if not built), code_find (to check resolution).",
    contract: { visibility: "public" },
    input: Input,
    output: Output,
    toModelOutput: ({ output }) => {
      const riskBlock =
        output.risks.length > 0
          ? output.risks.map((r) => `- [${r.severity.toUpperCase()}] ${r.kind}: ${r.message}`).join("\n")
          : "none."
      const lines = [
        `target.resolved=${output.target.resolved}${output.target.node ? ` (${output.target.node.name})` : ""}`,
        `candidates=${output.target.candidates.length}`,
        `directCallers=${output.directCallers.length}`,
        `transitiveCallers=${output.transitiveCallers.length}`,
        `testsToRun=${output.testsToRun.length}`,
        `docsAffected=${output.docsAffected.length}`,
        `configsAffected=${output.configsAffected.length}`,
        `eventBridgesAffected=${output.eventBridgesAffected.length}`,
        `httpRoutesAffected=${output.httpRoutesAffected.length}`,
        `derivation=${output.derivation}`,
        `risks:\n${riskBlock}`,
      ]
      return [{ type: "text", text: lines.join("\n") }]
    },
    execute: (input, context) =>
      traced(
        process.cwd(),
        context.sessionID,
        name,
        input,
        (output) =>
          `resolved=${output.target.resolved} direct=${output.directCallers.length} transitive=${output.transitiveCallers.length} risks=${output.risks.length}`,
        Effect.gen(function* () {
          yield* deps.permission.assert({
            action: name,
            resources: [input.target],
            save: ["*"],
            metadata: input,
            sessionID: context.sessionID,
            agent: context.agent,
            source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
          })
          return yield* computePreflight(
            { repo: deps.repo, analyzer: deps.analyzer, intel: deps.intel },
            input,
          )
        }),
      ).pipe(
        Effect.mapError((err) =>
          err instanceof ToolFailure ? err : new ToolFailure({ message: "preflight failed" }),
        ),
      ),
  })

export const locationLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    if (!banyancodeEnabled()) return
    const tools = yield* Tools.Service
    const permission = yield* PermissionV2.Service
    const repo = yield* Banyan.CodegraphRepo
    const analyzer = yield* Banyan.CodegraphAnalyzer
    const intel = yield* Banyan.RepositoryIntelligence

    yield* tools
      .register({
        [name]: makePreflightTool({
          permission: permission as PermissionV2Interface,
          repo: repo as CodegraphRepoInterface,
          analyzer: analyzer as CodegraphAnalyzerInterface,
          intel: intel as RepositoryIntelligenceInterface,
        }),
      })
      .pipe(Effect.orDie)
  }),
).pipe(Layer.provide(repositoryIntelligenceLayer), Layer.provide(codegraphAnalyzerLayer))
