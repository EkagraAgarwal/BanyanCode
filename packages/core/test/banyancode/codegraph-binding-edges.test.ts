import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { tmpdir } from "../fixture/tmpdir"
import path from "path"
import fs from "fs/promises"
import { CodegraphIndexer } from "../../src/banyancode/codegraph-indexer"
import { CodegraphRepo, defaultLayer as codegraphRepoDefaultLayer } from "../../src/banyancode/codegraph-repo"
import {
  buildTsconfigAliases,
  buildWorkspacePackageMap,
  createModuleResolver,
  resolveQualifiedReference,
  buildBindingIndex,
  type BindingIndex,
  type ResolutionContext,
} from "../../src/banyancode/codegraph-binding-model"
import type { CodegraphBinding, CodegraphEdge } from "../../src/banyancode/types"

process.env.BANYANCODE_ENABLE = "1"

const serviceLayer = CodegraphIndexer.layer.pipe(
  Layer.provide(FSUtil.defaultLayer),
  Layer.provide(codegraphRepoDefaultLayer),
)

const indexInto = <A>(root: string, dbPath: string, run: (repo: CodegraphRepo.Interface) => Effect.Effect<A, never, never>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const indexer = yield* CodegraphIndexer.Service
      const repo = yield* CodegraphRepo.Service
      yield* indexer.index({ root, force: true })
      return yield* run(repo)
    }).pipe(Effect.provide(serviceLayer), Effect.provide(codegraphRepoDefaultLayer), Effect.provide(Database.layerFromPath(dbPath)), Effect.scoped),
  )

const findNode = (repo: CodegraphRepo.Interface, filePath: string, name: string, kind: string) =>
  Effect.gen(function* () {
    const file = yield* repo.getFileByPath(filePath)
    if (!file) return undefined
    const nodes = yield* repo.listNodesByFile(file.id)
    return nodes.find((n) => n.name === name && n.kind === kind)
  })

const edgesToNode = (repo: CodegraphRepo.Interface, nodeID: string) =>
  Effect.gen(function* () {
    const all = yield* repo.listAllEdges()
    return all.filter((e) => e.toNodeID === nodeID)
  })

describe("binding-aware derived edges", () => {
  test("MeshCoordinator.Service dependents found via direct import AND via the Banyan barrel", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.sqlite")

    await fs.mkdir(path.join(tmp.path, "src"), { recursive: true })
    await fs.writeFile(
      path.join(tmp.path, "src/mesh-coordinator.ts"),
      [
        'import { Context } from "effect"',
        'export class Service extends Context.Service<Service, Interface>()("@banyancode/MeshCoordinator") {}',
        "export function status() { return 'ok' }",
        "",
      ].join("\n"),
    )
    await fs.writeFile(path.join(tmp.path, "src/mesh-coordinator-ns.ts"), 'export * as MeshCoordinator from "./mesh-coordinator"\n')
    await fs.writeFile(path.join(tmp.path, "src/barrel.ts"), 'export * as Banyan from "./mesh-coordinator-ns"\n')
    await fs.writeFile(
      path.join(tmp.path, "src/direct-consumer.ts"),
      [
        'import { MeshCoordinator } from "./mesh-coordinator-ns"',
        'export function viaDirect() { return MeshCoordinator.Service.of("x") }',
        "",
      ].join("\n"),
    )
    await fs.writeFile(
      path.join(tmp.path, "src/barrel-consumer.ts"),
      [
        'import { Banyan } from "./barrel"',
        'export function viaBarrel() { return Banyan.MeshCoordinator.of("y") }',
        "export function viaBarrelBare() { return Banyan.MeshCoordinator }",
        "",
      ].join("\n"),
    )

    await indexInto(tmp.path, dbPath, (repo) =>
      Effect.gen(function* () {
        const serviceNode = yield* findNode(repo, path.join(tmp.path, "src/mesh-coordinator.ts"), "Service", "class")
        expect(serviceNode).toBeDefined()
        if (!serviceNode) return

        // The service tag must be registered so the alias chain can resolve.
        const tags = yield* repo.listServiceTags()
        const meshTag = tags.find((t) => t.serviceName === "MeshCoordinator")
        expect(meshTag).toBeDefined()
        expect(meshTag!.nodeID).toBe(serviceNode.id)

        // Bindings must have been persisted for the barrel/ns files.
        const bindings = yield* repo.listBindings()
        expect(bindings.some((b) => b.kind === "namespace-re-export" && b.localName === "Banyan")).toBe(true)
        expect(bindings.some((b) => b.kind === "namespace-re-export" && b.localName === "MeshCoordinator")).toBe(true)

        const dependents = yield* edgesToNode(repo, serviceNode.id)
        const direct = dependents.find((e) => e.fromNodeID.includes("viaDirect"))
        const barrel = dependents.find((e) => e.fromNodeID.includes("viaBarrel"))
        const barrelBare = dependents.find((e) => e.fromNodeID.includes("viaBarrelBare"))

        expect(direct).toBeDefined()
        expect(barrel).toBeDefined()
        expect(barrelBare).toBeDefined()

        // Direct chain resolves through the export binding; the barrel chains
        // resolve through the service-tag alias. Both are high-confidence.
        expect(direct!.derivation).toBe("binding-resolved")
        expect(direct!.confidence).toBe(100)
        expect(barrel!.derivation).toBe("service-tag")
        expect(barrelBare!.derivation).toBe("service-tag")
      }),
    )
  })

  test("collision: multiple Service classes do not leak cross-service dependents", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.sqlite")

    await fs.mkdir(path.join(tmp.path, "src/a"), { recursive: true })
    await fs.mkdir(path.join(tmp.path, "src/b"), { recursive: true })
    await fs.writeFile(
      path.join(tmp.path, "src/a/service.ts"),
      'export class Service extends Context.Service<Service, Interface>()("@banyancode/ServiceA") {}\n',
    )
    await fs.writeFile(
      path.join(tmp.path, "src/b/service.ts"),
      'export class Service extends Context.Service<Service, Interface>()("@banyancode/ServiceB") {}\n',
    )
    // Both modules export a class literally named `Service` and both are
    // imported into the same file (TS would reject this, but the regex parser
    // does not validate). The binding index keeps the first binding, so the
    // resolved target must be service-a's Service and the heuristic edge to
    // service-b's Service must be suppressed.
    await fs.writeFile(
      path.join(tmp.path, "src/collide.ts"),
      [
        'import { Service } from "./a/service"',
        'import { Service } from "./b/service"',
        "export function run() { return Service.foo() }",
        "",
      ].join("\n"),
    )

    await indexInto(tmp.path, dbPath, (repo) =>
      Effect.gen(function* () {
        const serviceANode = yield* findNode(repo, path.join(tmp.path, "src/a/service.ts"), "Service", "class")
        const serviceBNode = yield* findNode(repo, path.join(tmp.path, "src/b/service.ts"), "Service", "class")
        const runNode = yield* findNode(repo, path.join(tmp.path, "src/collide.ts"), "run", "function")
        expect(serviceANode).toBeDefined()
        expect(serviceBNode).toBeDefined()
        expect(runNode).toBeDefined()
        if (!serviceANode || !serviceBNode || !runNode) return

        const dependentsOfA = yield* edgesToNode(repo, serviceANode.id)
        const dependentsOfB = yield* edgesToNode(repo, serviceBNode.id)

        expect(dependentsOfA.some((e) => e.fromNodeID === runNode.id)).toBe(true)
        expect(dependentsOfB.some((e) => e.fromNodeID === runNode.id)).toBe(false)
        expect(dependentsOfB.length).toBe(0)
      }),
    )
  })

  test("binding-resolved edges outrank heuristic-name edges for traversal consumers", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.sqlite")

    await fs.mkdir(path.join(tmp.path, "src"), { recursive: true })
    // No imports in peer.ts, so the indexer falls back to same-directory peers
    // and only a heuristic-name edge is produced for `Alpha`.
    await fs.writeFile(path.join(tmp.path, "src/a.ts"), "export class Alpha { beta() { return 1 } }\n")
    await fs.writeFile(path.join(tmp.path, "src/peer.ts"), "export function main() { return Alpha }\n")
    // import-consumer imports Alpha, so the binding pass resolves the dotted
    // reference and a binding-resolved edge outranks the heuristic one.
    await fs.writeFile(
      path.join(tmp.path, "src/import-consumer.ts"),
      'import { Alpha } from "./a"\nexport function run() { return Alpha.beta() }\n',
    )

    await indexInto(tmp.path, dbPath, (repo) =>
      Effect.gen(function* () {
        const alphaNode = yield* findNode(repo, path.join(tmp.path, "src/a.ts"), "Alpha", "class")
        expect(alphaNode).toBeDefined()
        if (!alphaNode) return

        const mainNode = yield* findNode(repo, path.join(tmp.path, "src/peer.ts"), "main", "function")
        const runNode = yield* findNode(repo, path.join(tmp.path, "src/import-consumer.ts"), "run", "function")
        expect(mainNode).toBeDefined()
        expect(runNode).toBeDefined()
        if (!mainNode || !runNode) return

        const edgesToAlpha = yield* edgesToNode(repo, alphaNode.id)
        const mainEdge = edgesToAlpha.find((e) => e.fromNodeID === mainNode.id)
        const runEdge = edgesToAlpha.find((e) => e.fromNodeID === runNode.id)

        expect(mainEdge).toBeDefined()
        expect(mainEdge!.derivation).toBe("heuristic-name")
        expect(mainEdge!.confidence).toBe(40)
        expect(runEdge).toBeDefined()
        expect(runEdge!.derivation).toBe("binding-resolved")
        expect(runEdge!.confidence).toBe(100)

        // A traversal consumer can sort by confidence and gets binding edges first.
        const sorted = [...edgesToAlpha].sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))
        expect(sorted[0]!.derivation).toBe("binding-resolved")
        expect(sorted.every((e, i) => i === 0 || (e.confidence ?? 0) <= (sorted[i - 1]!.confidence ?? 0))).toBe(true)
      }),
    )
  })
})

describe("binding-model module resolution", () => {
  const mkBinding = (overrides: Partial<CodegraphBinding>): CodegraphBinding => ({
    id: "b1",
    fileID: "f1",
    kind: "import",
    source: "",
    indexedAt: 0,
    ...overrides,
  })

  const makeContext = (
    bindings: CodegraphBinding[],
    files: { id: string; path: string }[],
    nodesByFile?: Map<string, { id: string; name: string; kind: string }[]>,
  ): { index: BindingIndex; context: ResolutionContext } => {
    const index = buildBindingIndex(bindings)
    const filesByID = new Map(files.map((f) => [f.id, { id: f.id, path: f.path.replace(/\\/g, "/") }]))
    const fileByPath = new Map(files.map((f) => [f.path.replace(/\\/g, "/"), { id: f.id, path: f.path.replace(/\\/g, "/") }]))
    const context: ResolutionContext = {
      filesByID,
      nodesByFile: nodesByFile ?? new Map(files.map((f) => [f.id, []])),
      serviceNodeIDByFile: new Map(),
      resolveModule: createModuleResolver({ fileByPath, workspacePackages: new Map(), tsconfigAliases: [] }),
    }
    return { index, context }
  }

  test("resolveQualifiedReference resolves a dotted chain through a relative import", () => {
    const bindings = [
      // `import { Service as svc } from "./svc"` — local name svc, imported name Service.
      mkBinding({ id: "c:import:svc", fileID: "consumer", kind: "import", localName: "svc", importedName: "Service", exportName: "Service", source: "./svc" }),
      mkBinding({ id: "svc:export:Service", fileID: "svc", kind: "export", localName: "Service", importedName: "Service", exportName: "Service", source: "" }),
    ]
    const nodesByFile = new Map<string, { id: string; name: string; kind: string }[]>([["svc", [{ id: "svc:Service", name: "Service", kind: "class" }]]])
    const { index, context } = makeContext(bindings, [
      { id: "consumer", path: "D:/proj/src/consumer.ts" },
      { id: "svc", path: "D:/proj/src/svc.ts" },
    ], nodesByFile)

    const resolved = resolveQualifiedReference(context, index, "consumer", ["svc", "Service"])
    expect(resolved).toBeDefined()
    expect(resolved!.nodeID).toBe("svc:Service")
    expect(resolved!.derivation).toBe("binding-resolved")
  })

  test("resolveQualifiedReference resolves tsconfig-path aliases and workspace package exports", () => {
    const files = [
      { id: "main", path: "D:/proj/src/app/main.ts" },
      { id: "coreSvc", path: "D:/proj/src/core/services/foo.ts" },
      { id: "pkgBanyan", path: "D:/proj/packages/lib/src/banyancode/index.ts" },
    ]
    const aliases = buildTsconfigAliases([
      { path: "D:/proj/tsconfig.json", content: JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@core/*": ["src/core/*"] } } }) },
    ])
    const packages = buildWorkspacePackageMap([
      { path: "D:/proj/packages/lib/package.json", content: JSON.stringify({ name: "@org/lib", exports: { "./banyancode": "./src/banyancode/index.ts" } }) },
    ])
    const fileByPath = new Map(files.map((f) => [f.path, { id: f.id, path: f.path }]))
    const resolveModule = createModuleResolver({ fileByPath, workspacePackages: packages, tsconfigAliases: aliases })

    expect(resolveModule("D:/proj/src/app/main.ts", "@core/services/foo").map((f) => f.id)).toEqual(["coreSvc"])
    expect(resolveModule("D:/proj/src/app/main.ts", "@org/lib/banyancode").map((f) => f.id)).toEqual(["pkgBanyan"])
  })
})
