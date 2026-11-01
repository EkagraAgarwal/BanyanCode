import { describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseJsonc } from "../../src/config/jsonc.js"
import { agentFilePath, saveAgent, update, updateAgentOverride, updateAgentPrompt } from "../../src/config/writer.js"

const withTemp = async (fn: (directory: string) => Promise<void>) => {
  const directory = await mkdtemp(join(tmpdir(), "banyancode-system-writer-"))
  try {
    await fn(directory)
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

const read = async (file: string) => readFile(file, "utf8")

describe("banyancode config writers", () => {
  test("update preserves comments, key order and unrelated keys", async () => {
    await withTemp(async (directory) => {
      const globalDir = join(directory, "global")
      await mkdir(globalDir, { recursive: true })
      const file = join(globalDir, "banyancode.json")
      await writeFile(
        file,
        [
          "// BanyanCode config — keep this comment",
          "{",
          '  /* yolo switch */ "banyancode_yolo_mode": false,',
          '  "banyancode_max_subagents": 5,',
          '  "custom_unknown_key": { "keep": true }',
          "}",
          "",
        ].join("\n"),
      )

      const result = await update({ globalDir, directory, projectRoot: directory }, { banyancode_yolo_mode: true })
      expect(result.config.banyancode_yolo_mode).toBe(true)
      expect(result.file).toBe(file)

      const text = await read(file)
      expect(text).toContain("// BanyanCode config — keep this comment")
      expect(text).toContain("/* yolo switch */")
      expect(text).toContain('"custom_unknown_key": { "keep": true }')
      expect(text.indexOf("banyancode_yolo_mode")).toBeLessThan(text.indexOf("banyancode_max_subagents"))
      expect(parseJsonc(text)).toMatchObject({
        banyancode_yolo_mode: true,
        banyancode_max_subagents: 5,
        custom_unknown_key: { keep: true },
      })
    })
  })

  test("concurrent writers do not lose updates", async () => {
    await withTemp(async (directory) => {
      const file = join(directory, "banyancode.json")
      await writeFile(file, "{}\n")
      const target = { file }
      await Promise.all(
        Array.from({ length: 20 }, (_, index) => update(target, { [`concurrent_${index}`]: index })),
      )
      const parsed = parseJsonc(await read(file)) as Record<string, unknown>
      expect(Object.keys(parsed)).toHaveLength(20)
      for (let index = 0; index < 20; index += 1) expect(parsed[`concurrent_${index}`]).toBe(index)
    })
  })

  test("agent override writes model/thinking and null clears + prunes", async () => {
    await withTemp(async (directory) => {
      const file = join(directory, "banyancode.json")
      await writeFile(file, '{\n  // agents\n  "agent": { "coder": { "thinking": "high" } }\n}\n')
      const target = { file }

      await updateAgentOverride(target, "coder", {
        enabled: true,
        model: { providerID: "openai", modelID: "gpt-5" },
        variant: "high",
      })
      await updateAgentPrompt(target, "coder", "You are a focused coder.")
      let parsed = parseJsonc(await read(file)) as any
      expect(parsed.agent.coder).toEqual({
        thinking: "high",
        enabled: true,
        model: "openai/gpt-5",
        variant: "high",
        prompt: "You are a focused coder.",
      })
      expect(await read(file)).toContain("// agents")

      await updateAgentOverride(target, "coder", { model: null, thinking: null, variant: null })
      parsed = parseJsonc(await read(file)) as any
      expect(parsed.agent.coder).toEqual({ enabled: true, prompt: "You are a focused coder." })
    })
  })

  test("agentSave writes v1 frontmatter and rejects traversal names", async () => {
    await withTemp(async (directory) => {
      const result = await saveAgent(
        { globalDir: directory },
        {
          name: "reviewer-pro",
          description: "Reviews diffs",
          mode: "subagent",
          model: { providerID: "openai", modelID: "gpt-5" },
          permission: ["read", "edit"],
          tools: ["read", "grep"],
          thinking: "high",
          prompt: "Review carefully.",
        },
      )
      expect(result.ok).toBe(true)
      expect(result.filePath).toBe(join(directory, "agent", "reviewer-pro.md"))
      const text = await read(result.filePath)
      expect(text).toContain('name: "reviewer-pro"')
      expect(text).toContain('mode: "subagent"')
      expect(text).toContain('model: "openai/gpt-5"')
      expect(text).toContain('permission: { "read": "allow", "edit": "allow" }')
      expect(text).toContain('tools: { "read": true, "grep": true }')
      expect(text).toContain('thinking: "high"')
      expect(text).toContain("Review carefully.")

      for (const name of ["../evil", "..\\evil", "a/b", "a\\b", "", "x".repeat(80)]) {
        await expect(saveAgent({ globalDir: directory }, { name, prompt: "p" })).rejects.toThrow()
      }
      expect(() => agentFilePath(join(directory, "agent"), "../evil")).toThrow()
      expect(() => agentFilePath(join(directory, "agent"), "..")).not.toThrow()
    })
  })

  test("a missing file is created and decoded", async () => {
    await withTemp(async (directory) => {
      const file = join(directory, "nested", "banyancode.jsonc")
      const result = await update({ file }, { banyancode_lsp: true })
      expect(result.config.banyancode_lsp).toBe(true)
      expect(parseJsonc(await read(file))).toEqual({ banyancode_lsp: true })
    })
  })
})
