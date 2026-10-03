// Path-guard unit tests: symlink escapes, missing targets, case handling.
// Pure filesystem fixtures in a tmpdir — no server, no mocks.

import { describe, expect, test } from "bun:test"
import { mkdir, symlink, writeFile } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "../fixture/tmpdir"
import { assertInsideRoot, isInsideRoot } from "../../src/mcp-server/paths"

describe("mcp paths guard", () => {
  test("keeps in-root paths, rejects .. and absolute escapes", async () => {
    await using tmp = await tmpdir()
    expect(isInsideRoot(tmp.path, "src/a.ts")).toBe(true)
    expect(isInsideRoot(tmp.path, "src/../src/a.ts")).toBe(true)
    expect(isInsideRoot(tmp.path, "../escape.ts")).toBe(false)
    expect(isInsideRoot(tmp.path, "/etc/passwd")).toBe(false)
    expect(isInsideRoot(tmp.path, "a/../../escape.ts")).toBe(false)
  })

  test("returns the absolute resolved path for in-root input", async () => {
    await using tmp = await tmpdir()
    expect(assertInsideRoot(tmp.path, "src/a.ts")).toBe(path.join(tmp.path, "src", "a.ts"))
    expect(assertInsideRoot(tmp.path, ".")).toBe(tmp.path)
  })

  test("rejects a symlink inside the root that points outside it", async () => {
    await using tmp = await tmpdir()
    await using outer = await tmpdir()
    const secret = path.join(outer.path, "secret.txt")
    await writeFile(secret, "secret")
    await symlink(outer.path, path.join(tmp.path, "link"), process.platform === "win32" ? "junction" : "dir")
    expect(isInsideRoot(tmp.path, "link/secret.txt")).toBe(false)
    expect(() => assertInsideRoot(tmp.path, "link/secret.txt")).toThrow("escapes")
  })

  test("accepts a symlink that stays inside the root", async () => {
    await using tmp = await tmpdir()
    const inner = path.join(tmp.path, "inner")
    await mkdir(inner, { recursive: true })
    await writeFile(path.join(inner, "ok.txt"), "ok")
    await symlink(inner, path.join(tmp.path, "alias"), process.platform === "win32" ? "junction" : "dir")
    expect(isInsideRoot(tmp.path, "alias/ok.txt")).toBe(true)
  })

  test("accepts a not-yet-existing path inside the root", async () => {
    await using tmp = await tmpdir()
    expect(isInsideRoot(tmp.path, "new/nested/file.ts")).toBe(true)
    expect(assertInsideRoot(tmp.path, "new/nested/file.ts")).toBe(path.join(tmp.path, "new", "nested", "file.ts"))
  })

  test("compares case-insensitively on win32 (drive letter / mixed case)", async () => {
    await using tmp = await tmpdir()
    if (process.platform !== "win32") {
      expect(isInsideRoot(tmp.path, "src/a.ts")).toBe(true)
      return
    }
    const upper = tmp.path.toUpperCase()
    const mixed = tmp.path.replace(/^[a-z]/i, (c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()))
    expect(isInsideRoot(upper, "src/a.ts")).toBe(true)
    expect(isInsideRoot(tmp.path, "SRC/../src/a.ts")).toBe(true)
    expect(assertInsideRoot(mixed, "src/a.ts")).toContain("src")
  })
})
