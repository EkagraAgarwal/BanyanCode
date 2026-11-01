import { afterEach, describe, expect, test } from "bun:test"
import { rm } from "node:fs/promises"
import { Effect } from "effect"
import { computeBlastRadius } from "../../src/intel/blast-radius.js"
import { makeEditPlanner } from "../../src/intel/edit-planner.js"
import { resolveGraphTarget } from "../../src/intel/resolve.js"
import { computeSafeRename, RenamePlanError } from "../../src/intel/safe-rename.js"
import { make } from "../../src/intel/service.js"
import type { PreflightOutput } from "../../src/intel/types.js"
import { buildProject } from "./graph-fixture.js"

const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

const setup = async () => {
  const project = await buildProject()
  roots.push(project.root)
  const intel = make(project.fixture.port)
  const planner = makeEditPlanner(project.fixture.port)
  return { ...project, intel, planner }
}

describe("blast radius", () => {
  test("counts direct + transitive dependents, files and tests", async () => {
    const { fixture, intel } = await setup()
    const result = await Effect.runPromise(
      computeBlastRadius({ port: fixture.port, intel }, { target: "MemoryRepo.update" }),
    )

    expect(result.resolved).toBe(true)
    expect(result.directCallers).toBe(6)
    expect(result.transitiveCallers).toBe(1)
    expect(result.filesAffected).toBe(6)
    expect(result.testsToRun).toBe(1)
    expect(result.risk).toBe("medium")
    expect(result.resolutionDerivation).toBe("qualified-split")
    expect(result.graphStale).toBeUndefined()
    expect(result.meta?.graphCoverage).toBe(0.93)
  })

  test("does not report a false-safe radius for an unknown symbol", async () => {
    const { fixture, intel } = await setup()
    const result = await Effect.runPromise(
      computeBlastRadius({ port: fixture.port, intel }, { target: "Nope.Nothing" }),
    )
    expect(result.resolved).toBe(false)
    expect(result.risk).toBe("unknown")
  })
})

describe("safe rename", () => {
  test("emits per-call-site edits, tests and the embedded preflight", async () => {
    const { fixture, intel, planner, root } = await setup()
    const result = await Effect.runPromise(
      computeSafeRename(
        { port: fixture.port, intel, planner },
        { symbol: "MemoryRepo.update", newName: "MemoryRepo.set", dryRun: false, root },
      ),
    )

    expect(result.edits.length).toBe(6)
    expect(result.edits.every((edit) => edit.oldText === "update" && edit.newText === "set")).toBe(true)
    expect(result.edits.map((edit) => edit.file.replace(/\\/g, "/"))).toContainEqual(
      expect.stringContaining("packages/core/src/session.ts"),
    )
    expect(result.testsToRun.map((path) => path.replace(/\\/g, "/"))).toEqual([
      expect.stringContaining("packages/core/src/memory-repo.test.ts"),
    ])
    const preflight = result.preflight as PreflightOutput
    expect(preflight.target.resolved).toBe(true)
    expect(preflight.directCallers.length).toBe(6)
    expect(result.meta?.graphCoverage).toBe(0.93)
  })

  test("dryRun returns the plan without edits", async () => {
    const { fixture, intel, planner, root } = await setup()
    const result = await Effect.runPromise(
      computeSafeRename(
        { port: fixture.port, intel, planner },
        { symbol: "MemoryRepo.update", newName: "MemoryRepo.set", dryRun: true, root },
      ),
    )
    expect(result.edits).toEqual([])
    expect((result.preflight as PreflightOutput).target.resolved).toBe(true)
  })

  test("rejects bare symbol and newName with a typed failure", async () => {
    const { fixture, intel, planner } = await setup()
    const error = await Effect.runPromise(
      Effect.flip(
        computeSafeRename(
          { port: fixture.port, intel, planner },
          { symbol: "update", newName: "set", dryRun: false },
        ),
      ),
    )
    expect(error).toBeInstanceOf(RenamePlanError)
    expect(error.message).toContain("cannot resolve namespace")
  })
})

describe("edit planner", () => {
  test("plans before and after an edit from the same graph", async () => {
    const { planner } = await setup()

    const before = await Effect.runPromise(
      planner.planBeforeEdit({ targetSymbol: "MemoryRepo.update", changeKind: "rename" }),
    )
    expect(before.steps.map((step) => step.tool)).toEqual(["code_find", "code_find", "read", "edit"])
    expect(before.expectedImpact.directDependents).toBe(6)
    expect(before.expectedImpact.transitiveDependents).toBe(1)
    expect(before.expectedImpact.testsToRun.map((path) => path.replace(/\\/g, "/"))).toContainEqual(
      expect.stringContaining("memory-repo.test.ts"),
    )

    const after = await Effect.runPromise(
      planner.planAfterEdit({ targetSymbol: "MemoryRepo.update", filePath: "packages/core/src/memory-repo.ts" }),
    )
    expect(after.steps[0]?.tool).toBe("code_find")
    expect(after.expectedImpact.directDependents).toBe(6)
  })

  test("degrades to grep + code_find for an unknown target", async () => {
    const { planner } = await setup()
    const plan = await Effect.runPromise(
      planner.planBeforeEdit({ targetSymbol: "NotInGraph", changeKind: "modify" }),
    )
    expect(plan.steps.map((step) => step.tool)).toEqual(["grep", "code_find"])
    expect(plan.expectedImpact.unreliable).toContain("not found in graph")
    expect(plan.risks[0]?.kind).toBe("no-target")
  })
})

describe("resolution", () => {
  test("resolves a Context.Service tag and a qualified name", async () => {
    const { fixture } = await setup()
    const tag = await Effect.runPromise(resolveGraphTarget(fixture.port, { target: "MemoryRepo" }))
    expect(tag._tag).toBe("Ok")
    if (tag._tag === "Ok") {
      expect(tag.value.derivation).toBe("tag-fallback")
      expect(tag.value.node.name).toBe("MemoryRepo")
    }

    const qualified = await Effect.runPromise(resolveGraphTarget(fixture.port, { target: "MemoryRepo.update" }))
    expect(qualified._tag).toBe("Ok")
    if (qualified._tag === "Ok") {
      expect(qualified.value.derivation).toBe("qualified-split")
      expect(qualified.value.node.id).toBe("node-update")
    }

    const id = await Effect.runPromise(resolveGraphTarget(fixture.port, { target: "node-update" }))
    expect(id._tag).toBe("Miss")
  })
})
