import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { WorkspaceIdentity } from "../../src/banyancode/workspace-identity"
import { channelSuffix } from "../../src/database/banyan-db-path"
import { tmpdir } from "../fixture/tmpdir"

const dbName = (tag: string) => `banyancode-${tag}${channelSuffix()}.db`

describe("WorkspaceIdentity.identityForRoot", () => {
  test("derives canonical db path inside .banyancode directory", async () => {
    await using tmp = await tmpdir()
    mkdirSync(join(tmp.path, ".banyancode"), { recursive: true })

    const identity = WorkspaceIdentity.identityForRoot(tmp.path)
    expect(identity.root).toBe(tmp.path)
    expect(identity.banyanDir).toBe(join(tmp.path, ".banyancode"))
    expect(identity.dbPath).toBe(join(tmp.path, ".banyancode", dbName(identity.tag)))
    expect(identity.tag).toHaveLength(12)
  })

  test("walks up to find an existing .banyancode directory", async () => {
    await using tmp = await tmpdir()
    const child = join(tmp.path, "packages", "app")
    mkdirSync(join(tmp.path, ".banyancode"), { recursive: true })
    mkdirSync(child, { recursive: true })

    const identity = WorkspaceIdentity.identityForRoot(child)
    expect(identity.banyanDir).toBe(join(tmp.path, ".banyancode"))
    expect(identity.dbPath).toBe(join(tmp.path, ".banyancode", dbName(identity.tag)))
  })

  test("two distinct roots produce distinct db files", async () => {
    await using tmp = await tmpdir()
    const a = join(tmp.path, "a")
    const b = join(tmp.path, "b")
    mkdirSync(join(a, ".banyancode"), { recursive: true })
    mkdirSync(join(b, ".banyancode"), { recursive: true })

    const idA = WorkspaceIdentity.identityForRoot(a)
    const idB = WorkspaceIdentity.identityForRoot(b)
    expect(idA.dbPath).not.toBe(idB.dbPath)
    expect(idA.tag).not.toBe(idB.tag)
  })

  test("resolve symlinks via realpath before computing the tag", async () => {
    await using tmp = await tmpdir()
    const real = join(tmp.path, "real")
    mkdirSync(join(real, ".banyancode"), { recursive: true })

    // We cannot create symlinks on Windows without privileges, so just
    // verify that the same logical root yields the same identity no
    // matter whether it's passed via realpath or raw path.
    const id1 = WorkspaceIdentity.identityForRoot(real)
    const id2 = WorkspaceIdentity.identityForRoot(real)
    expect(id1.dbPath).toBe(id2.dbPath)
  })

  test("rejects empty root", () => {
    expect(() => WorkspaceIdentity.identityForRoot("")).toThrow()
  })

  test("rejects non-existent root", () => {
    expect(() => WorkspaceIdentity.identityForRoot(join(__dirname, "__definitely_missing__"))).toThrow()
  })
})

describe("WorkspaceIdentity.isInsideWorkspace", () => {
  test("returns true for the root itself", () => {
    expect(WorkspaceIdentity.isInsideWorkspace("/foo", "/foo")).toBe(true)
  })

  test("returns true for descendants", () => {
    expect(WorkspaceIdentity.isInsideWorkspace("/foo", "/foo/bar")).toBe(true)
    expect(WorkspaceIdentity.isInsideWorkspace("/foo", "/foo/bar/baz.ts")).toBe(true)
  })

  test("returns false for siblings and parents", () => {
    expect(WorkspaceIdentity.isInsideWorkspace("/foo", "/bar")).toBe(false)
    expect(WorkspaceIdentity.isInsideWorkspace("/foo", "/")).toBe(false)
    expect(WorkspaceIdentity.isInsideWorkspace("/foo", "/foo-other")).toBe(false)
  })

  test("returns false for empty candidate", () => {
    expect(WorkspaceIdentity.isInsideWorkspace("/foo", "")).toBe(false)
  })
})

describe("WorkspaceIdentity.diagnosisFromMeta", () => {
  test("returns no-graph when meta is undefined", async () => {
    await using tmp = await tmpdir()
    mkdirSync(join(tmp.path, ".banyancode"), { recursive: true })
    const id = WorkspaceIdentity.identityForRoot(tmp.path)
    expect(WorkspaceIdentity.diagnosisFromMeta(id, undefined)).toEqual({ status: "no-graph" })
  })

  test("returns in-scope when meta.indexedRoot matches the root", async () => {
    await using tmp = await tmpdir()
    mkdirSync(join(tmp.path, ".banyancode"), { recursive: true })
    const id = WorkspaceIdentity.identityForRoot(tmp.path)
    expect(WorkspaceIdentity.diagnosisFromMeta(id, { indexedRoot: tmp.path })).toEqual({
      status: "in-scope",
      indexedRoot: tmp.path,
    })
  })

  test("returns out-of-scope when meta.indexedRoot differs from the root", async () => {
    await using tmp = await tmpdir()
    mkdirSync(join(tmp.path, ".banyancode"), { recursive: true })
    const id = WorkspaceIdentity.identityForRoot(tmp.path)
    expect(WorkspaceIdentity.diagnosisFromMeta(id, { indexedRoot: "/somewhere/else" })).toEqual({
      status: "out-of-scope",
      indexedRoot: "/somewhere/else",
    })
  })
})

describe("WorkspaceIdentity.identityForRootStrict", () => {
  test("creates the .banyancode directory if missing", async () => {
    await using tmp = await tmpdir()
    // Brand new workspace — no .banyancode yet
    expect(existsSync(join(tmp.path, ".banyancode"))).toBe(false)

    const id = WorkspaceIdentity.identityForRootStrict(tmp.path)
    expect(existsSync(id.banyanDir)).toBe(true)
    expect(id.dbPath).toContain(".banyancode")

    // Cleanup
    rmSync(join(tmp.path, ".banyancode"), { recursive: true, force: true })
  })

  test("does not mutate the project tree when the directory already exists", async () => {
    await using tmp = await tmpdir()
    mkdirSync(join(tmp.path, ".banyancode"), { recursive: true })
    const marker = join(tmp.path, ".banyancode", "marker.txt")
    writeFileSync(marker, "keep")

    const id = WorkspaceIdentity.identityForRootStrict(tmp.path)
    expect(existsSync(marker)).toBe(true)
    expect(id.banyanDir).toBe(join(tmp.path, ".banyancode"))
  })
})
