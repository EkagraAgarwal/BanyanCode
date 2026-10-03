import { describe, expect, test } from "bun:test"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Effect } from "effect"
import { WorkspaceIdentity } from "../../src/banyancode/workspace-identity"
import { ensureReadyBounded } from "../../src/banyancode/codegraph-readiness"
import type { Interface as ReadinessInterface } from "../../src/banyancode/codegraph-readiness"
import { tmpdir } from "../fixture/tmpdir"

describe("WorkspaceIdentity home-directory guard", () => {
  test("a package.json in the home dir is never the workspace root", async () => {
    await using tmp = await tmpdir()
    const home = join(tmp.path, "home")
    const cwd = join(home, "scratch", "empty")
    mkdirSync(cwd, { recursive: true })
    writeFileSync(join(home, "package.json"), "{}")

    expect(WorkspaceIdentity.findRepoRoot(cwd, home)).toBeUndefined()
    const effective = WorkspaceIdentity.resolveEffectiveRoot({ cwd, home })
    expect(effective._tag).toBe("Ok")
    if (effective._tag === "Ok") expect(effective.root).toBe(WorkspaceIdentity.sanitizeRoot(cwd))
  })

  test("a project marker below home still wins", async () => {
    await using tmp = await tmpdir()
    const home = join(tmp.path, "home")
    const project = join(home, "proj")
    const cwd = join(project, "src")
    mkdirSync(cwd, { recursive: true })
    writeFileSync(join(home, "package.json"), "{}")
    writeFileSync(join(project, "package.json"), "{}")

    expect(WorkspaceIdentity.findRepoRoot(cwd, home)).toBe(project)
  })

  test("cwd equal to home is an invalid workspace", async () => {
    await using tmp = await tmpdir()
    const home = join(tmp.path, "home")
    mkdirSync(home, { recursive: true })
    writeFileSync(join(home, "package.json"), "{}")

    const effective = WorkspaceIdentity.resolveEffectiveRoot({ cwd: home, home })
    expect(effective._tag).toBe("InvalidWorkspace")
    if (effective._tag === "InvalidWorkspace") expect(effective.diagnostic.message).toContain("user home directory")
  })
})

describe("ensureReadyBounded", () => {
  const slow: ReadinessInterface = {
    ensureReady: () => Effect.sleep("60 seconds").pipe(Effect.as({ reason: "ready", autoBuilt: true } as const)),
    status: () => Effect.succeed({ reason: "ready", autoBuilt: false } as const),
  }

  test("returns a failed 'build in progress' result once the wait budget is spent", async () => {
    process.env.BANYANCODE_CODEGRAPH_READY_WAIT_MS = "200"
    try {
      const started = Date.now()
      const result = await Effect.runPromise(ensureReadyBounded(slow, { root: "/some/root" }))
      expect(Date.now() - started).toBeLessThan(3000)
      expect(result.reason).toBe("failed")
      expect(result.autoBuilt).toBe(true)
      expect(result.error).toContain("codegraph build in progress for /some/root")
    } finally {
      delete process.env.BANYANCODE_CODEGRAPH_READY_WAIT_MS
    }
  })

  test("passes through a fast result unchanged", async () => {
    const fast: ReadinessInterface = { ...slow, ensureReady: () => Effect.succeed({ reason: "ready", autoBuilt: false }) }
    expect(await Effect.runPromise(ensureReadyBounded(fast, { root: "/r" }))).toEqual({ reason: "ready", autoBuilt: false })
  })
})
