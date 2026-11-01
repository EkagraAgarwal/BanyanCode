import { afterEach, describe, expect, test } from "bun:test"
import { rm } from "node:fs/promises"
import { Effect } from "effect"
import { computePreflight } from "../../src/intel/preflight.js"
import { make } from "../../src/intel/service.js"
import { buildProject } from "./graph-fixture.js"

const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

const setup = async (options: { stale?: boolean } = {}) => {
  const project = await buildProject(options)
  roots.push(project.root)
  const intel = make(project.fixture.port)
  return { ...project, intel }
}

describe("preflight over a real graph fixture", () => {
  test("reports callers, tests, docs, configs, bridges, routes and risks", async () => {
    const { fixture, intel, root } = await setup()
    const result = await Effect.runPromise(
      computePreflight({ port: fixture.port, intel }, { action: "rename", target: "MemoryRepo.update", root }),
    )

    expect(result.target.resolved).toBe(true)
    expect(result.target.node?.name).toBe("update")
    expect(result.target.candidates.length).toBeGreaterThan(0)

    expect(result.directCallers.map((node) => node.name).sort()).toEqual([
      "MemoryRepo.update test",
      "bridgeHook",
      "memory docs",
      "resolve",
      "updateRoute",
      "version",
    ])
    expect(result.transitiveCallers.map((node) => node.name)).toEqual(["boot"])

    expect(result.testsToRun.map((file) => file.path.replace(/\\/g, "/"))).toEqual([
      expect.stringContaining("packages/core/src/memory-repo.test.ts"),
    ])
    expect(result.docsAffected.map((file) => file.path.replace(/\\/g, "/"))).toEqual([
      expect.stringContaining("docs/memory.md"),
    ])
    expect(result.configsAffected.map((file) => file.path.replace(/\\/g, "/"))).toEqual([
      expect.stringContaining("packages/core/package.json"),
    ])

    expect(result.eventBridgesAffected).toEqual([
      { name: "rpc", file: expect.stringContaining("packages/core/src/effect/rpc-bridge.ts") },
    ])
    expect(result.httpRoutesAffected).toEqual([
      { method: "POST", path: "/update", file: expect.stringContaining("httpapi/groups/global.ts") },
    ])

    const kinds = result.risks.map((risk) => risk.kind)
    expect(kinds).toContain("touches-event-bus")
    expect(kinds).toContain("touches-http-routes")
    expect(result.risk).toBe("medium")
    expect(result.derivation).toBe("regex-v1")
    expect(result.filePaths["file-repo"]?.replace(/\\/g, "/")).toContain("packages/core/src/memory-repo.ts")
  })

  test("flags a stale graph and an unresolved target", async () => {
    const { fixture, intel, root } = await setup({ stale: true })
    const stale = await Effect.runPromise(
      computePreflight({ port: fixture.port, intel }, { action: "modify", target: "MemoryRepo.update", root }),
    )
    expect(stale.risks.some((risk) => risk.kind === "stale-graph" && risk.severity === "high")).toBe(true)
    expect(stale.risk).toBe("high")

    const missing = await Effect.runPromise(
      computePreflight({ port: fixture.port, intel }, { action: "delete", target: "DoesNotExistAnywhere", root }),
    )
    expect(missing.target.resolved).toBe(false)
    expect(missing.risk).toBe("unknown")
    expect(missing.risks.map((risk) => risk.kind)).toContain("no-target")
    expect(missing.directCallers).toEqual([])
  })
})
