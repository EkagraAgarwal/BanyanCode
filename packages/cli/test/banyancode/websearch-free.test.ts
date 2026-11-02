import { describe, expect, test } from "bun:test"
import { cli, fakeServer, tmpRoot } from "./fixture"

const results = Array.from({ length: 8 }, (_, index) => ({
  url: `https://example.com/${index}`,
  title: `Result ${index}`,
  content: `Snippet ${index}`,
  time: {},
}))

describe("websearch-free", () => {
  test("queries the duckduckgo provider and prints v1's result block", async () => {
    const root = await tmpRoot("banyancode-cli-websearch-")
    const queries: Array<Record<string, unknown>> = []
    const server = fakeServer(async (request, url) => {
      if (url.pathname === "/api/websearch/provider")
        return Response.json({
          location: { directory: root },
          data: [{ id: "duckduckgo", name: "DuckDuckGo" }],
        })
      if (url.pathname === "/api/websearch" && request.method === "POST") {
        queries.push((await request.json()) as Record<string, unknown>)
        return Response.json({
          location: { directory: root },
          data: { providerID: "duckduckgo", results },
        })
      }
      return undefined
    })
    try {
      const result = await cli(root, ["websearch-free", "bun test", "--num", "2", "--server", server.url])
      expect(result.exitCode).toBe(0)
      expect(result.stderr).toContain("Websearch: bun test")
      expect(result.stderr).toContain("results: 2")
      expect(result.stderr).toContain("Result 0")
      expect(result.stderr).toContain("https://example.com/0")
      expect(result.stderr).toContain("Snippet 0")
      expect(result.stderr).not.toContain("Result 2")
      expect(queries).toEqual([{ query: "bun test", providerID: "duckduckgo" }])
    } finally {
      server.stop()
    }
  }, 180_000)

  test("says why the search is disabled by env instead of succeeding silently", async () => {
    const root = await tmpRoot("banyancode-cli-websearch-off-")
    // No --server: a disabled search must not even try to connect.
    const result = await cli(root, ["websearch-free", "anything"], {
      env: { BANYANCODE_DISABLE_WEBSEARCH: "1" },
    })
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toBe("")
    expect(result.stderr).toContain("websearch disabled by BANYANCODE_DISABLE_WEBSEARCH=1")
  }, 120_000)

  test("says so when the provider is not registered", async () => {
    const root = await tmpRoot("banyancode-cli-websearch-missing-")
    const server = fakeServer((_request, url) =>
      url.pathname === "/api/websearch/provider"
        ? Response.json({ location: { directory: root }, data: [] })
        : undefined,
    )
    try {
      const result = await cli(root, ["websearch-free", "anything", "--server", server.url])
      expect(result.exitCode).toBe(1)
      expect(result.stdout).toBe("")
      expect(result.stderr).toContain("websearch is disabled")
    } finally {
      server.stop()
    }
  }, 180_000)
})
