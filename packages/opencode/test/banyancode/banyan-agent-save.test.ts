import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import { BanyanAgentSaveInput } from "../../src/server/routes/instance/httpapi/groups/global"
import { ConfigAgentV1 } from "@opencode-ai/core/v1/config/agent"
import { ConfigMarkdown as ConfigMarkdownCore } from "@opencode-ai/core/config/markdown"
import { ConfigParse } from "../../src/config/parse"
import { ConfigAgent } from "../../src/config/agent"
import { tmpdir } from "../fixture/fixture"

describe("BanyanAgentSaveInput schema validation for tools", () => {
  const decodePromise = (input: unknown) =>
    Effect.runPromise(
      Schema.decodeUnknownExit(BanyanAgentSaveInput)(input).pipe(
        Effect.map((value) => ({ ok: true as const, value })),
        Effect.catch((error) => Effect.succeed({ ok: false as const, error })),
      ),
    )

  test("accepts valid tools array", async () => {
    const result = await decodePromise({
      name: "test-agent",
      tools: ["read", "write", "bash"],
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.tools).toEqual(["read", "write", "bash"])
    }
  })

  test("accepts empty tools array", async () => {
    const result = await decodePromise({
      name: "test-agent",
      tools: [],
    })
    expect(result.ok).toBe(true)
  })

  test("accepts tools with max length items", async () => {
    const result = await decodePromise({
      name: "test-agent",
      tools: ["a".repeat(128)],
    })
    expect(result.ok).toBe(true)
  })

  test("rejects tools item longer than 128 chars", async () => {
    const result = await decodePromise({
      name: "test-agent",
      tools: ["a".repeat(129)],
    })
    expect(result.ok).toBe(false)
  })

  test("rejects tools with path traversal", async () => {
    const result = await decodePromise({
      name: "test-agent",
      tools: ["../escape"],
    })
    expect(result.ok).toBe(false)
  })

  test("rejects tools with absolute path", async () => {
    const result = await decodePromise({
      name: "test-agent",
      tools: ["/etc/passwd"],
    })
    expect(result.ok).toBe(false)
  })

  test("accepts both permission and tools", async () => {
    const result = await decodePromise({
      name: "test-agent",
      permission: ["read", "write"],
      tools: ["code_find", "memory_store"],
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.permission).toEqual(["read", "write"])
      expect(result.value.tools).toEqual(["code_find", "memory_store"])
    }
  })

  test("tools is optional (absent is ok)", async () => {
    const result = await decodePromise({
      name: "test-agent",
      description: "A test agent",
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.tools).toBeUndefined()
    }
  })
})

// Mirror the frontmatter writer in banyanAgentSaveHandler (handlers/global.ts)
// so these tests fail if the handler's serialization drifts from what
// ConfigAgentV1.Info / ConfigPermissionV1.Info actually decode.
const escapeYamlScalar = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`

const buildAgentMarkdown = (input: {
  name: string
  description?: string
  mode?: string
  hidden?: boolean
  model?: { providerID: string; modelID: string }
  permission?: string[]
  tools?: string[]
  prompt?: string
}): string => {
  const model = input.model
  const modelLine = model
    ? `model: ${escapeYamlScalar(model.providerID ? `${model.providerID}/${model.modelID}` : model.modelID)}`
    : null
  const toolsLine =
    input.tools && input.tools.length > 0
      ? `tools: { ${input.tools.map((tool) => `${escapeYamlScalar(tool)}: true`).join(", ")} }`
      : null
  const permissionLine =
    input.permission && input.permission.length > 0
      ? `permission: { ${input.permission.map((key) => `${escapeYamlScalar(key)}: "allow"`).join(", ")} }`
      : null
  const frontmatter: (string | null)[] = [
    "---",
    `name: ${escapeYamlScalar(input.name)}`,
    `description: ${escapeYamlScalar(input.description ?? "")}`,
    `mode: ${escapeYamlScalar(input.mode ?? "subagent")}`,
    input.hidden !== undefined ? `hidden: ${input.hidden}` : null,
    modelLine,
    permissionLine,
    toolsLine,
    "---",
    "",
  ]
  const body = input.prompt ? [input.prompt] : [`# ${input.name}`, "", input.description ?? ""]
  return [...frontmatter, ...body].filter(Boolean).join("\n")
}

describe("banyanAgentSaveHandler frontmatter round-trips through ConfigAgentV1.Info", () => {
  // Same decode path as ConfigAgent.load (ConfigParse.schema with gray-matter data).
  const decodeAgent = (content: string, name: string) => {
    const md = ConfigMarkdownCore.parse(content)
    const config = { name, ...md.data, prompt: md.content.trim() }
    return ConfigParse.schema(ConfigAgentV1.Info, config, `${name}.md`)
  }

  test("full handler-written frontmatter decodes (model string, tools record, permission record)", () => {
    const parsed = decodeAgent(
      buildAgentMarkdown({
        name: "my-researcher",
        description: "A research agent",
        mode: "subagent",
        hidden: true,
        model: { providerID: "anthropic", modelID: "claude-x" },
        permission: ["read", "write"],
        tools: ["read", "write", "code_find"],
        prompt: "You are a focused researcher.",
      }),
      "my-researcher",
    )
    expect(parsed.model).toBe("anthropic/claude-x")
    expect(parsed.tools).toEqual({ read: true, write: true, code_find: true })
    expect(parsed.permission).toMatchObject({
      read: "allow",
      write: "allow",
      code_find: "allow",
    })
    expect(parsed.description).toBe("A research agent")
    expect(parsed.mode).toBe("subagent")
    expect(parsed.hidden).toBe(true)
    expect(parsed.prompt).toBe("You are a focused researcher.")
  })

  test("multi-slash modelID round-trips (openrouter-style)", () => {
    const parsed = decodeAgent(
      buildAgentMarkdown({
        name: "router",
        model: { providerID: "openrouter", modelID: "meta-llama/llama-3.3-70b" },
      }),
      "router",
    )
    expect(parsed.model).toBe("openrouter/meta-llama/llama-3.3-70b")
  })

  test("optional fields omitted when absent", () => {
    const parsed = decodeAgent(buildAgentMarkdown({ name: "minimal" }), "minimal")
    expect(parsed.model).toBeUndefined()
    expect(parsed.tools).toBeUndefined()
    // ConfigAgentV1.normalize always initializes permission to an empty record.
    expect(parsed.permission).toEqual({})
    expect(parsed.mode).toBe("subagent")
  })

  test("old broken shapes (model object, tools array) FAIL to decode", () => {
    const legacy = [
      "---",
      'name: "legacy"',
      'model: {"providerID":"anthropic","modelID":"claude-x"}',
      'tools: ["read", "write"]',
      "---",
      "",
      "prompt",
    ].join("\n")
    expect(() => decodeAgent(legacy, "legacy")).toThrow()
  })

  test("old broken permission array FAILS to decode", () => {
    const legacy = ["---", 'name: "legacy"', 'permission: ["read", "write"]', "---", "", "prompt"].join("\n")
    expect(() => decodeAgent(legacy, "legacy")).toThrow()
  })

  test("end-to-end: agent/ dir file is picked up by ConfigAgent.load", async () => {
    await using tmp = await tmpdir()
    const agentDir = path.join(tmp.path, "agent")
    await fs.mkdir(agentDir, { recursive: true })
    await fs.writeFile(
      path.join(agentDir, "my-researcher.md"),
      buildAgentMarkdown({
        name: "my-researcher",
        description: "A research agent",
        model: { providerID: "anthropic", modelID: "claude-x" },
        permission: ["read"],
        tools: ["read", "write"],
        prompt: "You are a researcher.",
      }),
      "utf-8",
    )
    const agents = await ConfigAgent.load(tmp.path)
    expect(agents["my-researcher"]).toBeDefined()
    expect(agents["my-researcher"].model).toBe("anthropic/claude-x")
    expect(agents["my-researcher"].tools).toEqual({ read: true, write: true })
    expect(agents["my-researcher"].permission).toMatchObject({ read: "allow" })
    expect(agents["my-researcher"].prompt).toBe("You are a researcher.")
  })
})
