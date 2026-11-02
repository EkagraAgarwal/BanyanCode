import { describe, expect, test } from "bun:test"
import { groupCatalog, classify } from "../../src/commands/handlers/banyancode/tools-catalog"
import { cli, fakeServer, plain, rpcOutput, tmpRoot } from "./fixture"

describe("tools catalog", () => {
  test("classifies v1 categories and groups deterministically", () => {
    expect(classify("repository_query")).toBe("Repository")
    expect(classify("codegraph_build")).toBe("Codegraph")
    expect(classify("code_find")).toBe("Search")
    expect(classify("mesh_status")).toBe("Mesh")
    expect(classify("edit_plan")).toBe("Edit")
    expect(classify("banyan_test")).toBe("MCP")
    expect(classify("read")).toBe("Primitive")
    const grouped = groupCatalog()
    expect(grouped.get("Repository")).toContain("repository_explain")
    expect(grouped.get("Codegraph")).toContain("codegraph_find_http_routes")
    expect(grouped.get("Primitive")).toContain("shell")
  })

  test("prints the catalog with live usage counts and filters by category", async () => {
    const root = await tmpRoot("banyancode-cli-tools-")
    const server = fakeServer((_request, url) => {
      if (url.pathname === "/api/rpc/banyancode.usage/toolUsage")
        return rpcOutput({
          tools: [{ toolId: "repository_query", useCount: 7, lastUsedAt: 1 }],
        })
      return undefined
    })
    try {
      const all = await cli(root, ["tools", "--server", server.url])
      expect(all.exitCode).toBe(0)
      expect(all.stderr).toContain("Tool Catalog")
      expect(all.stderr).toContain("tools: 64")
      expect(all.stderr).toContain("Repository")
      expect(plain(all.stderr)).toContain("repository_query (7 uses)")

      const mesh = await cli(root, ["tools", "--category", "Mesh", "--server", server.url])
      expect(mesh.stderr).toContain("Mesh")
      expect(mesh.stderr).toContain("mesh_status")
      expect(mesh.stderr).not.toContain("Repository")
      expect(mesh.stderr).not.toContain("codegraph_build")
    } finally {
      server.stop()
    }
  }, 180_000)

  test("lists the catalog even when the usage namespace is missing", async () => {
    const root = await tmpRoot("banyancode-cli-tools-nousage-")
    const server = fakeServer(() => new Response("not found", { status: 404 }))
    try {
      const result = await cli(root, ["tools", "--server", server.url])
      expect(result.exitCode).toBe(0)
      expect(result.stderr).toContain("Tool Catalog")
      expect(result.stderr).toContain("goal")
    } finally {
      server.stop()
    }
  }, 180_000)
})
