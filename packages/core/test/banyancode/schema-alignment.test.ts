/**
 * Phase 7 schema-alignment regression tests.
 *
 * Verifies that LLM tool schemas and HTTP route schemas have matching field
 * names for each aligned input type.
 */

import { describe, expect, test } from "bun:test"
import { readFileSync } from "fs"
import path from "path"

const workspaceRoot = path.join(import.meta.dirname, "..", "..", "..", "..")

const repoWave2Path = path.join(workspaceRoot, "packages", "core", "src", "tool", "repository-wave2.ts")
const httpRepoPath = path.join(
  workspaceRoot,
  "packages",
  "opencode",
  "src",
  "server",
  "routes",
  "instance",
  "httpapi",
  "groups",
  "repository-intel.ts",
)
const agentPath = path.join(workspaceRoot, "packages", "opencode", "src", "agent", "agent.ts")
const pluginAgentPath = path.join(workspaceRoot, "packages", "core", "src", "plugin", "agent.ts")
const toolsLayerPath = path.join(workspaceRoot, "packages", "core", "src", "banyancode", "tools-layer.ts")
const registryPath = path.join(workspaceRoot, "packages", "opencode", "src", "tool", "registry.ts")

const llmSource = readFileSync(repoWave2Path, "utf8")
const httpSource = readFileSync(httpRepoPath, "utf8")

function extractStructFields(source: string, structName: string): Set<string> {
  const fields = new Set<string>()
  const startPattern = new RegExp(`(?:export\\s+)?const\\s+${structName}\\s+=\\s+Schema\\.Struct\\(\\{`)
  const startMatch = startPattern.exec(source)
  if (!startMatch) return fields

  const bodyStart = startMatch.index + startMatch[0].length

  let depth = 1
  for (let i = bodyStart; i < source.length; i++) {
    const ch = source[i]!
    if (ch === "{") {
      depth++
    } else if (ch === "}") {
      depth--
      if (depth <= 0) break
    } else if (ch === ":" && depth === 1) {
      let j = i - 1
      while (j >= bodyStart && /\s/.test(source[j]!)) j--
      let k = j
      while (k >= bodyStart && /\w/.test(source[k]!)) k--
      const name = source.slice(k + 1, j + 1)
      if (name.length > 0 && /^[a-z_$][\w$]*$/i.test(name)) {
        fields.add(name)
      }
    }
  }
  return fields
}

describe("schema field alignment", () => {
  describe("TraceInput", () => {
    test("HTTP has same fields as LLM", () => {
      const httpFields = extractStructFields(httpSource, "TraceInput")
      const llmFields = extractStructFields(llmSource, "TraceInput")
      expect(httpFields.size).toBeGreaterThan(0)
      expect(llmFields.size).toBeGreaterThan(0)
      expect(httpFields).toEqual(llmFields)
    })

    test("HTTP TraceInput has limit field", () => {
      const httpFields = extractStructFields(httpSource, "TraceInput")
      expect(httpFields.has("limit")).toBe(true)
    })
  })

  describe("RelationshipsInput", () => {
    test("HTTP has same fields as LLM", () => {
      const httpFields = extractStructFields(httpSource, "RelationshipsInput")
      const llmFields = extractStructFields(llmSource, "RelationshipsInput")
      expect(httpFields.size).toBeGreaterThan(0)
      expect(llmFields.size).toBeGreaterThan(0)
      expect(httpFields).toEqual(llmFields)
    })

    test("HTTP RelationshipsInput has path field", () => {
      const httpFields = extractStructFields(httpSource, "RelationshipsInput")
      expect(httpFields.has("path")).toBe(true)
    })

    test("HTTP RelationshipsInput has optional nodeID", () => {
      const structPattern = /export\s+const\s+RelationshipsInput\s+=\s+Schema\.Struct\(\{([^}]+)\}\)/
      const match = httpSource.match(structPattern)
      expect(match).toBeTruthy()
      const body = match![1]!
      expect(body).toContain("nodeID: Schema.optional")
    })
  })

  describe("OwnershipInput", () => {
    test("HTTP has same fields as LLM", () => {
      const httpFields = extractStructFields(httpSource, "OwnershipInput")
      const llmFields = extractStructFields(llmSource, "OwnershipInput")
      expect(httpFields.size).toBeGreaterThan(0)
      expect(llmFields.size).toBeGreaterThan(0)
      expect(httpFields).toEqual(llmFields)
    })

    test("HTTP OwnershipInput has workspace field", () => {
      const httpFields = extractStructFields(httpSource, "OwnershipInput")
      expect(httpFields.has("workspace")).toBe(true)
    })
  })

  describe("OwnershipResult", () => {
    test("HTTP uses owner not user", () => {
      const structPattern = /export\s+const\s+OwnershipResult\s+=\s+Schema\.Struct\(\{([^}]+)\}\)/
      const match = httpSource.match(structPattern)
      expect(match).toBeTruthy()
      const body = match![1]!
      expect(body).toContain("owner:")
      expect(body).not.toContain("user:")
    })
  })
})

describe("repository_slice retirement", () => {
  test("repository_slice is not registered as a tool", () => {
    const nameSlicePattern = /export\s+const\s+name_slice\s+=/
    expect(llmSource).not.toMatch(nameSlicePattern)

    const inputSlicePattern = /export\s+const\s+InputSlice\s+=\s+QueryInput/
    const outputSlicePattern = /export\s+const\s+OutputSlice\s+=/
    expect(llmSource).not.toMatch(inputSlicePattern)
    expect(llmSource).not.toMatch(outputSlicePattern)

    const toolBlockPattern = /\[name_slice\]\s*:\s*Tool\.make\(/
    expect(llmSource).not.toMatch(toolBlockPattern)
  })

  test("repository_slice removed from agent permissions", () => {
    const agentSource = readFileSync(agentPath, "utf8")
    const slicePermPattern = /repository_slice\s*:\s*"allow"/
    expect(agentSource).not.toMatch(slicePermPattern)
  })

  test("repository_slice removed from plugin agent permissions", () => {
    const pluginSource = readFileSync(pluginAgentPath, "utf8")
    const slicePermPattern = /action:\s*"repository_slice"/
    expect(pluginSource).not.toMatch(slicePermPattern)
  })
})

describe("repository-intel-tool.ts consolidation", () => {
  test("tools-layer imports RepositoryWave2 not RepositoryIntelTool", () => {
    const toolsLayerSource = readFileSync(toolsLayerPath, "utf8")
    expect(toolsLayerSource).toContain("RepositoryWave2")
    expect(toolsLayerSource).not.toContain("RepositoryIntelTool")
  })

  test("registry imports RepositoryWave2 not RepositoryIntelTool", () => {
    const registrySource = readFileSync(registryPath, "utf8")
    expect(registrySource).toContain("RepositoryWave2")
    expect(registrySource).not.toContain("RepositoryIntelTool")
  })
})
