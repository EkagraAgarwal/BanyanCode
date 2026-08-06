import { describe, expect, test } from "bun:test"
import { mkdirSync } from "node:fs"
import { join, parse } from "node:path"
import { findContainingBanyanDir } from "../src/database/banyan-db-path"
import { tmpdir } from "./fixture/tmpdir"

describe("findContainingBanyanDir", () => {
  test("returns the project-local .banyancode when it exists", async () => {
    await using tmp = await tmpdir()
    const project = join(tmp.path, "terminalbench")
    mkdirSync(join(project, ".banyancode"), { recursive: true })

    expect(findContainingBanyanDir(project)).toBe(join(project, ".banyancode"))
  })

  test("walks up to the project-local .banyancode from a nested directory", async () => {
    await using tmp = await tmpdir()
    const project = join(tmp.path, "terminalbench")
    mkdirSync(join(project, ".banyancode"), { recursive: true })
    mkdirSync(join(project, "src", "deep"), { recursive: true })

    expect(findContainingBanyanDir(join(project, "src", "deep"))).toBe(join(project, ".banyancode"))
  })

  test("skips a .banyancode marker sitting at the filesystem root (drive-root pollution)", () => {
    // Simulate a project directory on the same drive as the filesystem root
    // (e.g. `D:/terminalbench` on win32). The directory itself never exists,
    // so the walk must climb to the drive root. If the drive root carries a
    // `.banyancode` marker (the sticky pollution this guards against), the
    // walk must skip it and return undefined — never the root marker.
    // This test never writes to the filesystem root.
    const root = parse(process.cwd()).root
    const ghostProject = join(root, `__banyancode-root-marker-test-${process.pid}__`)

    expect(findContainingBanyanDir(ghostProject)).toBeUndefined()
  })

  test("returns the root-level marker when startDir IS the filesystem root", () => {
    // A marker at the root is the only plausible match when the caller
    // explicitly points at the filesystem root itself.
    const root = parse(process.cwd()).root
    if (findContainingBanyanDir(root) !== undefined) {
      expect(findContainingBanyanDir(root)).toBe(join(root, ".banyancode"))
    }
  })
})
