import { beforeEach, describe, expect, test } from "bun:test"
import {
  __test,
  mcpSchemaCacheKey,
  permissionsFingerprint,
  registryCacheKey,
  resetSessionToolsCaches,
  SESSION_TOOLS_CATALOG_TTL_MS,
  SESSION_TOOLS_MCP_SCHEMA_TTL_MS,
  SESSION_TOOLS_MCP_TTL_MS,
  SESSION_TOOLS_REGISTRY_TTL_MS,
} from "@/session/tools"

beforeEach(() => {
  resetSessionToolsCaches()
})

describe("SessionTools R8 cache keys", () => {
  test("registryCacheKey separates provider, model, and agent", () => {
    const key = registryCacheKey("anthropic", "claude", "build")
    expect(registryCacheKey("anthropic", "claude", "build")).toBe(key)
    expect(registryCacheKey("openai", "claude", "build")).not.toBe(key)
    expect(registryCacheKey("anthropic", "other", "build")).not.toBe(key)
    expect(registryCacheKey("anthropic", "claude", "plan")).not.toBe(key)
  })

  test("registryCacheKey parts cannot collide across boundaries", () => {
    const NUL = String.fromCharCode(0)
    // With a plain concatenation ("ab" + "c") would equal ("a" + "bc"); the
    // separator keeps them distinct.
    expect(registryCacheKey("ab", "c", "d")).not.toBe(registryCacheKey(`a${NUL}b`, "c", "d"))
    expect(registryCacheKey("ab", "c", "d")).not.toBe(registryCacheKey("a", "bc", "d"))
  })

  test("mcpSchemaCacheKey separates model and tool", () => {
    const key = mcpSchemaCacheKey("gpt-5.2", "mcp_read")
    expect(mcpSchemaCacheKey("gpt-5.2", "mcp_read")).toBe(key)
    expect(mcpSchemaCacheKey("gpt-5.6", "mcp_read")).not.toBe(key)
    expect(mcpSchemaCacheKey("gpt-5.2", "mcp_write")).not.toBe(key)
  })

  test("permissionsFingerprint is stable for the same ruleset", () => {
    const ruleset = [
      { permission: "*", pattern: "*", action: "allow" },
      { permission: "edit", pattern: "*", action: "deny" },
    ]
    expect(permissionsFingerprint(ruleset)).toBe(JSON.stringify(ruleset))
    expect(permissionsFingerprint(ruleset)).toBe(permissionsFingerprint(structuredClone(ruleset)))
    expect(permissionsFingerprint(undefined)).toBe("[]")
    expect(permissionsFingerprint([{ a: 1 }, { b: 2 }])).not.toBe(permissionsFingerprint([{ b: 2 }, { a: 1 }]))
  })

  test("TTL constants match the documented 5 s window", () => {
    expect(SESSION_TOOLS_REGISTRY_TTL_MS).toBe(5_000)
    expect(SESSION_TOOLS_MCP_TTL_MS).toBe(5_000)
    expect(SESSION_TOOLS_MCP_SCHEMA_TTL_MS).toBe(5_000)
    expect(SESSION_TOOLS_CATALOG_TTL_MS).toBe(5_000)
  })
})

describe("SessionTools R8 cache invalidation", () => {
  test("resetSessionToolsCaches clears every cache", () => {
    __test.registryCache.set("k", { items: [], schemas: new Map() }, 60_000)
    __test.mcpToolsCache.set("k", {}, 60_000)
    __test.mcpSchemaCache.set("k", { type: "object" }, 60_000)
    __test.catalogMaterializeCache.set("k", undefined as never, 60_000)
    expect(__test.registryCache.size).toBe(1)
    expect(__test.mcpToolsCache.size).toBe(1)
    expect(__test.mcpSchemaCache.size).toBe(1)
    expect(__test.catalogMaterializeCache.size).toBe(1)

    resetSessionToolsCaches()

    expect(__test.registryCache.size).toBe(0)
    expect(__test.mcpToolsCache.size).toBe(0)
    expect(__test.mcpSchemaCache.size).toBe(0)
    expect(__test.catalogMaterializeCache.size).toBe(0)
  })

  test("cached entries expire past their TTL", () => {
    __test.registryCache.set("k", { items: [], schemas: new Map() }, 0)
    expect(__test.registryCache.get("k")).toBeUndefined()
  })
})
