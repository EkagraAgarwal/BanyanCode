export * as ConfigAgent from "./agent"

import path from "path"
import { Exit, Schema } from "effect"
import { Glob } from "@opencode-ai/core/util/glob"
import { ConfigAgentV1 } from "@opencode-ai/core/v1/config/agent"
import { InvalidError } from "@opencode-ai/core/v1/config/error"
import { configEntryNameFromPath } from "./entry-name"
import * as ConfigMarkdown from "./markdown"
import { ConfigParse } from "./parse"

// Frontmatter key controlling how a custom agent's prompt composes with the
// provider prompt. The value flows through the ConfigAgentV1 decode into
// `options.systemPrompt` (core folds unknown keys into options); agent.ts
// reads it back when merging into Agent.Info.
function systemPromptFromFrontmatter(
  data: Record<string, unknown>,
  source: string,
): "append" | "replace" | undefined {
  const value = data.systemPrompt
  if (value === undefined) return undefined
  if (value !== "append" && value !== "replace") {
    throw new InvalidError({
      path: source,
      issues: [
        {
          code: "invalid_value",
          keys: ["systemPrompt"],
          path: [],
          message: `systemPrompt must be "append" or "replace", got ${JSON.stringify(value)}`,
        },
      ],
    })
  }
  return value
}

export async function load(dir: string) {
  const result: Record<string, ConfigAgentV1.Info> = {}
  for (const item of await Glob.scan("{agent,agents}/**/*.md", {
    cwd: dir,
    absolute: true,
    dot: true,
    symlink: true,
  })) {
    const md = await ConfigMarkdown.parse(item).catch(() => undefined)
    if (!md) continue

    const name = configEntryNameFromPath(path.relative(dir, item), ["agent/", "agents/"])

    systemPromptFromFrontmatter(md.data, item)

    const config = {
      name,
      ...md.data,
      prompt: md.content.trim(),
    }
    result[config.name] = ConfigParse.schema(ConfigAgentV1.Info, config, item)
  }
  return result
}

export async function loadMode(dir: string) {
  const result: Record<string, ConfigAgentV1.Info> = {}
  for (const item of await Glob.scan("{mode,modes}/*.md", {
    cwd: dir,
    absolute: true,
    dot: true,
    symlink: true,
  })) {
    const md = await ConfigMarkdown.parse(item).catch(() => undefined)
    if (!md) continue

    const name = configEntryNameFromPath(path.relative(dir, item), ["mode/", "modes/"])

    systemPromptFromFrontmatter(md.data, item)

    const config = {
      name: configEntryNameFromPath(path.relative(dir, item), ["mode/", "modes/"]),
      ...md.data,
      prompt: md.content.trim(),
    }
    const parsed = Schema.decodeUnknownExit(ConfigAgentV1.Info)(config, { errors: "all", propertyOrder: "original" })
    if (Exit.isSuccess(parsed)) {
      result[config.name] = {
        ...parsed.value,
        mode: "primary" as const,
      }
    }
  }
  return result
}
